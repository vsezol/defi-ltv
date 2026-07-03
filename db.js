import pg from "pg";
import { logger } from "./logger.js";

const { Pool } = pg;

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  logger.error("DATABASE_URL not set");
  process.exit(1);
}

// Railway's internal network (and localhost) don't use TLS; the public proxy does.
// node-postgres ignores ?sslmode in the URL, so set ssl explicitly.
const needsSsl = !/railway\.internal|localhost|127\.0\.0\.1/.test(connectionString);

const pool = new Pool({
  connectionString,
  max: 8,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
  ssl: needsSsl ? { rejectUnauthorized: false } : false
});

// An idle client error must never crash the process.
pool.on("error", (error) => logger.error({ error: error.message }, "Idle DB client error"));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Threshold field (code) -> column (SQL). Whitelist: never interpolate raw field names.
const THRESHOLD_COLUMNS = {
  warningHealthFactor: "warning_hf",
  dangerHealthFactor: "danger_hf",
  warningBorrowRate: "warning_rate",
  dangerBorrowRate: "danger_rate"
};

// CREATE TABLE IF NOT EXISTS doesn't add columns to existing tables, so every
// column added after the initial schema also needs an ALTER ... IF NOT EXISTS.
const DDL = `
  CREATE TABLE IF NOT EXISTS users (
    chat_id      TEXT PRIMARY KEY,
    warning_hf   DOUBLE PRECISION,
    danger_hf    DOUBLE PRECISION,
    warning_rate DOUBLE PRECISION,
    danger_rate  DOUBLE PRECISION,
    warning_supply_rate DOUBLE PRECISION,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS wallets (
    chat_id      TEXT NOT NULL REFERENCES users(chat_id) ON DELETE CASCADE,
    address      TEXT NOT NULL,
    protocol     TEXT NOT NULL,
    warning_hf   DOUBLE PRECISION,
    danger_hf    DOUBLE PRECISION,
    warning_rate DOUBLE PRECISION,
    danger_rate  DOUBLE PRECISION,
    warning_supply_rate DOUBLE PRECISION,
    markets      JSONB NOT NULL DEFAULT '[]',
    pool_states  JSONB NOT NULL DEFAULT '{}',
    supply_states JSONB NOT NULL DEFAULT '{}',
    tron_state   JSONB,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (chat_id, address)
  );
  ALTER TABLE users   ADD COLUMN IF NOT EXISTS warning_supply_rate DOUBLE PRECISION;
  ALTER TABLE wallets ADD COLUMN IF NOT EXISTS warning_supply_rate DOUBLE PRECISION;
  ALTER TABLE wallets ADD COLUMN IF NOT EXISTS supply_states JSONB NOT NULL DEFAULT '{}';
`;

export async function initDb() {
  let lastError;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await pool.query("SELECT 1");
      await pool.query(DDL);
      logger.info("Database ready");
      return;
    } catch (error) {
      lastError = error;
      logger.warn({ attempt: attempt + 1, error: error.message }, "DB init failed, retrying");
      await sleep(2000 * (attempt + 1));
    }
  }
  logger.error({ error: lastError?.message }, "DB init failed permanently");
  process.exit(1);
}

export async function closeDb() {
  await pool.end();
}

// --- assembly: rows -> the merged user object shape the bot expects ---

function settingsFromRow(row) {
  const settings = {};
  if (row.warning_hf != null) settings.warningHealthFactor = row.warning_hf;
  if (row.danger_hf != null) settings.dangerHealthFactor = row.danger_hf;
  if (row.warning_rate != null) settings.warningBorrowRate = row.warning_rate;
  if (row.danger_rate != null) settings.dangerBorrowRate = row.danger_rate;
  return settings;
}

function assembleUser(userRow, walletRows) {
  const wallets = {};
  for (const w of walletRows) {
    wallets[w.address] = {
      protocol: w.protocol,
      markets: w.markets || [],
      poolStates: w.pool_states || {},
      settings: settingsFromRow(w),
      ...(w.tron_state ? { tronState: w.tron_state } : {})
    };
  }
  return { wallets, settings: userRow ? settingsFromRow(userRow) : {} };
}

// --- reads ---

export async function getUser(chatId) {
  const [userRes, walletRes] = await Promise.all([
    pool.query("SELECT * FROM users WHERE chat_id = $1", [chatId]),
    pool.query("SELECT * FROM wallets WHERE chat_id = $1", [chatId])
  ]);
  if (userRes.rowCount === 0 && walletRes.rowCount === 0) return undefined;
  return assembleUser(userRes.rows[0], walletRes.rows);
}

export async function getAllUsers() {
  const [userRes, walletRes] = await Promise.all([
    pool.query("SELECT * FROM users"),
    pool.query("SELECT * FROM wallets ORDER BY chat_id")
  ]);
  const byChat = new Map();
  for (const u of userRes.rows) byChat.set(u.chat_id, { userRow: u, walletRows: [] });
  for (const w of walletRes.rows) {
    if (!byChat.has(w.chat_id)) byChat.set(w.chat_id, { userRow: null, walletRows: [] });
    byChat.get(w.chat_id).walletRows.push(w);
  }
  return Array.from(byChat.entries()).map(([chatId, { userRow, walletRows }]) => [
    chatId,
    assembleUser(userRow, walletRows)
  ]);
}

export async function getUserCount() {
  const res = await pool.query("SELECT count(*)::int AS n FROM users");
  return res.rows[0].n;
}

// --- writes (granular, atomic) ---

export async function upsertWallet(
  chatId,
  address,
  { protocol, markets = [], poolStates = {}, tronState = null }
) {
  await pool.query("INSERT INTO users (chat_id) VALUES ($1) ON CONFLICT (chat_id) DO NOTHING", [chatId]);
  await pool.query(
    `INSERT INTO wallets (chat_id, address, protocol, markets, pool_states, tron_state)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb)
     ON CONFLICT (chat_id, address) DO UPDATE SET
       protocol    = EXCLUDED.protocol,
       markets     = EXCLUDED.markets,
       pool_states = EXCLUDED.pool_states,
       tron_state  = EXCLUDED.tron_state`,
    [
      chatId,
      address,
      protocol,
      JSON.stringify(markets),
      JSON.stringify(poolStates),
      tronState ? JSON.stringify(tronState) : null
    ]
  );
}

export async function deleteWallet(chatId, address) {
  await pool.query("DELETE FROM wallets WHERE chat_id = $1 AND address = $2", [chatId, address]);
}

export async function deleteUser(chatId) {
  await pool.query("DELETE FROM users WHERE chat_id = $1", [chatId]);
}

export async function setGlobalThreshold(chatId, field, value) {
  const col = THRESHOLD_COLUMNS[field];
  if (!col) throw new Error(`Unknown threshold field: ${field}`);
  await pool.query(
    `INSERT INTO users (chat_id, ${col}) VALUES ($1, $2)
     ON CONFLICT (chat_id) DO UPDATE SET ${col} = $2, updated_at = now()`,
    [chatId, value]
  );
}

export async function setWalletThreshold(chatId, address, field, value) {
  const col = THRESHOLD_COLUMNS[field];
  if (!col) throw new Error(`Unknown threshold field: ${field}`);
  await pool.query(`UPDATE wallets SET ${col} = $3 WHERE chat_id = $1 AND address = $2`, [chatId, address, value]);
}

export async function resetWalletThresholds(chatId, address) {
  await pool.query(
    `UPDATE wallets SET warning_hf = NULL, danger_hf = NULL, warning_rate = NULL, danger_rate = NULL
     WHERE chat_id = $1 AND address = $2`,
    [chatId, address]
  );
}

export async function setWalletMarkets(chatId, address, markets) {
  await pool.query("UPDATE wallets SET markets = $3::jsonb WHERE chat_id = $1 AND address = $2", [
    chatId,
    address,
    JSON.stringify(markets || [])
  ]);
}

// Column-scoped UPDATE (never upsert) — must not resurrect a wallet removed mid-scan.
export async function setWalletPoolStates(chatId, address, states) {
  await pool.query("UPDATE wallets SET pool_states = $3::jsonb WHERE chat_id = $1 AND address = $2", [
    chatId,
    address,
    JSON.stringify(states || {})
  ]);
}

export async function setWalletTronState(chatId, address, state) {
  await pool.query("UPDATE wallets SET tron_state = $3::jsonb WHERE chat_id = $1 AND address = $2", [
    chatId,
    address,
    JSON.stringify(state || {})
  ]);
}
