import { scanAllMarketsForWallet } from "./kamino.js";
import { scanAaveMarketsForWallet } from "./aave.js";
import { getOrcaPositionsForWallet } from "./orca.js";
import { getMeteoraPositionsForWallet } from "./meteora.js";
import { getUniswapPositionsForWallet } from "./uniswap.js";
import { getTronResources, computeTronFlags } from "./tron.js";
import { getUser, upsertWallet } from "./db.js";
import { logger } from "./logger.js";

// Shared between the Telegram bot (bot.js) and the Mini App API (server.js).

// Code-level fallbacks. Used when neither the wallet nor the global defaults set a value.
export const DEFAULT_THRESHOLDS = {
  warningHealthFactor: 1.5,
  dangerHealthFactor: 1.3,
  warningBorrowRate: 10, // %
  dangerBorrowRate: 15 // %
};

// User-configurable global defaults, falling back to code constants.
export function getGlobalDefaults(user) {
  const s = user?.settings || {};
  const out = {};
  for (const [key, fallback] of Object.entries(DEFAULT_THRESHOLDS)) {
    out[key] = s[key] ?? fallback;
  }
  return out;
}

// Effective thresholds for a wallet: per-wallet override -> global default -> constant.
export function getWalletThresholds(user, wallet) {
  const defaults = getGlobalDefaults(user);
  const w = user?.wallets?.[wallet]?.settings || {};
  const out = {};
  for (const key of Object.keys(DEFAULT_THRESHOLDS)) {
    out[key] = w[key] ?? defaults[key];
  }
  return out;
}

// 0 = ok, 1 = warning, 2 = danger. Worst of the health-factor and borrow-rate checks.
export function positionSeverity(thresholds, healthFactor, borrowRate) {
  let level = 0;

  const hf = parseFloat(healthFactor);
  if (Number.isFinite(hf)) {
    if (hf <= thresholds.dangerHealthFactor) level = Math.max(level, 2);
    else if (hf <= thresholds.warningHealthFactor) level = Math.max(level, 1);
  }

  const br = parseFloat(borrowRate);
  if (Number.isFinite(br)) {
    if (br >= thresholds.dangerBorrowRate) level = Math.max(level, 2);
    else if (br >= thresholds.warningBorrowRate) level = Math.max(level, 1);
  }

  return level;
}

function isEvmAddress(address) {
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58Decode(str) {
  if (!str || /[^123456789A-HJ-NP-Za-km-z]/.test(str)) return null;
  let num = 0n;
  for (const ch of str) {
    num = num * 58n + BigInt(BASE58_ALPHABET.indexOf(ch));
  }
  const bytes = [];
  while (num > 0n) {
    bytes.unshift(Number(num & 0xffn));
    num >>= 8n;
  }
  for (const ch of str) {
    if (ch === "1") bytes.unshift(0);
    else break;
  }
  return bytes;
}

// Tron decodes to 25 bytes (0x41 prefix + checksum); Solana pubkeys to 32 bytes.
export function detectWalletType(address) {
  if (isEvmAddress(address)) return "evm";
  const bytes = base58Decode(address);
  if (bytes) {
    if (bytes.length === 25 && bytes[0] === 0x41) return "tron";
    if (bytes.length === 32) return "solana";
  }
  return "unknown";
}

// LP positions (Orca + Meteora for Solana, Uniswap V3 for EVM). Returns
// { positions, failures } — `failures` lists the id prefixes of sources
// (orca:/meteora:/uniswap:<net>:) that failed this scan, so the alert checker can
// carry over previous range state instead of pruning positions it couldn't see
// (pruning would silently re-seed them on recovery and swallow a range crossing).
export async function scanPoolsForWallet(wallet) {
  const walletType = detectWalletType(wallet);
  if (walletType === "solana") {
    // Two independent sources: a failure in one must not prune the other's state.
    const [orca, meteora] = await Promise.all([
      getOrcaPositionsForWallet(wallet)
        .then((positions) => ({ positions }))
        .catch((error) => {
          logger.error({ wallet, error: error.message }, "Orca scan failed");
          return { failure: "orca:" };
        }),
      getMeteoraPositionsForWallet(wallet)
        .then((positions) => ({ positions }))
        .catch((error) => {
          logger.error({ wallet, error: error.message }, "Meteora scan failed");
          return { failure: "meteora:" };
        })
    ]);
    return {
      positions: [...(orca.positions || []), ...(meteora.positions || [])],
      failures: [orca.failure, meteora.failure].filter(Boolean)
    };
  }
  if (walletType === "evm") return getUniswapPositionsForWallet(wallet);
  return { positions: [], failures: [] };
}

// Scan a wallet and persist it. Returns what was found so the caller can render
// it (Telegram reply or JSON). Throws with error.stage === "save" when scanning
// succeeded but persisting failed. Lending and LP scans run concurrently.
export async function addWalletCore(chatId, address, { onKaminoProgress } = {}) {
  const walletType = detectWalletType(address);
  if (walletType === "unknown") throw new Error("Unsupported wallet format");

  if (walletType === "tron") {
    const tron = await getTronResources(address);
    try {
      await upsertWallet(chatId, address, { protocol: "tron", tronState: computeTronFlags(tron) });
    } catch (error) {
      error.stage = "save";
      throw error;
    }
    return { protocol: "tron", tron, positions: [], pools: [] };
  }

  const protocol = walletType === "evm" ? "aave" : "kamino";
  const [positions, pools] = await Promise.all([
    protocol === "aave"
      ? scanAaveMarketsForWallet(address)
      : scanAllMarketsForWallet(address, onKaminoProgress),
    scanPoolsForWallet(address)
      .then((r) => r.positions)
      .catch((error) => {
        logger.error({ address, error: error.message }, "Pool scan failed on add");
        return [];
      })
  ]);

  if ((!positions || positions.length === 0) && pools.length === 0) {
    return { protocol, empty: true, positions: [], pools: [] };
  }

  // Baseline the LP range states silently — alerts fire only on later transitions.
  const poolStates = {};
  for (const pool of pools) poolStates[pool.id] = pool.inRange;

  try {
    await upsertWallet(chatId, address, {
      protocol,
      markets: (positions || []).map((p) => p.market),
      poolStates
    });
  } catch (error) {
    error.stage = "save";
    throw error;
  }

  logger.info(
    { chatId, address, markets: (positions || []).length, pools: pools.length },
    "Wallet added"
  );
  return { protocol, positions: positions || [], pools };
}
