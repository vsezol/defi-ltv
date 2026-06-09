import { readFileSync, writeFileSync, existsSync } from "fs";
import { logger } from "./logger.js";

const KAMINO_DB_FILE = "./db-kamino.json";
const AAVE_DB_FILE = "./db-aave.json";
const LEGACY_DB_FILE = "./db.json";

const defaultKaminoDb = {
  markets: [],
  marketsUpdatedAt: null,
  users: {}
};

const defaultAaveDb = {
  aaveMarkets: {},
  aaveMarketsUpdatedAt: {},
  users: {}
};

let kaminoDb = null;
let aaveDb = null;

function loadJson(file, fallback) {
  if (!existsSync(file)) return { ...fallback };
  try {
    return JSON.parse(readFileSync(file, "utf-8"));
  } catch (error) {
    logger.error({ file, error: error.message }, "Failed to load db");
    return { ...fallback };
  }
}

function saveJson(file, data) {
  writeFileSync(file, JSON.stringify(data, null, 2));
}

export function loadDb() {
  if (kaminoDb && aaveDb) return { kaminoDb, aaveDb };

  const hasKamino = existsSync(KAMINO_DB_FILE);
  const hasAave = existsSync(AAVE_DB_FILE);
  const hasLegacy = existsSync(LEGACY_DB_FILE);

  if (!hasKamino && hasLegacy) {
    const legacy = loadJson(LEGACY_DB_FILE, defaultKaminoDb);
    kaminoDb = {
      markets: legacy.markets || [],
      marketsUpdatedAt: legacy.marketsUpdatedAt || null,
      users: legacy.users || {}
    };
  } else {
    kaminoDb = loadJson(KAMINO_DB_FILE, defaultKaminoDb);
  }

  if (hasAave) {
    aaveDb = loadJson(AAVE_DB_FILE, defaultAaveDb);
  } else {
    aaveDb = { ...defaultAaveDb };
  }

  return { kaminoDb, aaveDb };
}

function ensureLoaded() {
  if (!kaminoDb || !aaveDb) loadDb();
}

function saveKamino() {
  if (!kaminoDb) return;
  saveJson(KAMINO_DB_FILE, kaminoDb);
}

function saveAave() {
  if (!aaveDb) return;
  saveJson(AAVE_DB_FILE, aaveDb);
}

export function getDb() {
  ensureLoaded();
  return { kaminoDb, aaveDb };
}

export function getMarkets() {
  ensureLoaded();
  return kaminoDb.markets;
}

export function setMarkets(markets) {
  ensureLoaded();
  kaminoDb.markets = markets;
  kaminoDb.marketsUpdatedAt = new Date().toISOString();
  saveKamino();
}

export function getAaveMarkets(networkKey) {
  ensureLoaded();
  return aaveDb.aaveMarkets[networkKey] || [];
}

export function setAaveMarkets(networkKey, markets) {
  ensureLoaded();
  aaveDb.aaveMarkets[networkKey] = markets;
  aaveDb.aaveMarketsUpdatedAt[networkKey] = new Date().toISOString();
  saveAave();
}

function mergeUsers(kaminoUser, aaveUser) {
  if (!kaminoUser && !aaveUser) return undefined;
  return {
    wallets: {
      ...(kaminoUser?.wallets || {}),
      ...(aaveUser?.wallets || {})
    },
    // Global default thresholds are user-wide; persisted in the Kamino store.
    settings: kaminoUser?.settings || {},
    ui: kaminoUser?.ui || {}
  };
}

function splitUser(user) {
  const wallets = user?.wallets || {};
  const kaminoWallets = {};
  const aaveWallets = {};

  for (const [wallet, data] of Object.entries(wallets)) {
    const protocol = data?.protocol === "aave" ? "aave" : "kamino";
    if (protocol === "aave") {
      aaveWallets[wallet] = data;
    } else {
      kaminoWallets[wallet] = data;
    }
  }

  const kaminoUser = {
    wallets: kaminoWallets,
    settings: user?.settings || {},
    ui: user?.ui || {}
  };

  const aaveUser = {
    wallets: aaveWallets
  };

  return { kaminoUser, aaveUser };
}

export function getUser(chatId) {
  ensureLoaded();
  const kaminoUser = kaminoDb.users[chatId];
  const aaveUser = aaveDb.users[chatId];
  return mergeUsers(kaminoUser, aaveUser);
}

export function setUser(chatId, user) {
  ensureLoaded();
  const { kaminoUser, aaveUser } = splitUser(user);

  const hasKaminoData =
    Object.keys(kaminoUser.wallets).length > 0 ||
    Object.keys(kaminoUser.settings || {}).length > 0 ||
    Object.keys(kaminoUser.ui || {}).length > 0;
  if (hasKaminoData) {
    kaminoDb.users[chatId] = kaminoUser;
  } else {
    delete kaminoDb.users[chatId];
  }

  const hasAaveData = Object.keys(aaveUser.wallets).length > 0;
  if (hasAaveData) {
    aaveDb.users[chatId] = aaveUser;
  } else {
    delete aaveDb.users[chatId];
  }

  saveKamino();
  saveAave();
}

export function deleteUser(chatId) {
  ensureLoaded();
  delete kaminoDb.users[chatId];
  delete aaveDb.users[chatId];
  saveKamino();
  saveAave();
}

export function getUserCount() {
  ensureLoaded();
  const ids = new Set([
    ...Object.keys(kaminoDb.users || {}),
    ...Object.keys(aaveDb.users || {})
  ]);
  return ids.size;
}

export function getAllUsers() {
  ensureLoaded();
  const ids = new Set([
    ...Object.keys(kaminoDb.users || {}),
    ...Object.keys(aaveDb.users || {})
  ]);
  return Array.from(ids).map((id) => [id, getUser(id)]);
}
