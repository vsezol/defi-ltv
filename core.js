import { scanAllMarketsForWallet, getKaminoSupplies } from "./kamino.js";
import { scanAaveMarketsForWallet, scanAaveSuppliesForWallet } from "./aave.js";
import { getFluidSuppliesForWallet } from "./fluid.js";
import { getOrcaPositionsForWallet } from "./orca.js";
import { getUniswapPositionsForWallet } from "./uniswap.js";
import { getTronResources, computeTronFlags } from "./tron.js";
import { getUser, upsertWallet, setWalletMarkets } from "./db.js";
import { logger } from "./logger.js";

// Shared between the Telegram bot (bot.js) and the Mini App API (server.js).

// Code-level fallbacks. Used when neither the wallet nor the global defaults set a value.
export const DEFAULT_THRESHOLDS = {
  warningHealthFactor: 1.5,
  dangerHealthFactor: 1.3,
  warningBorrowRate: 10, // %
  dangerBorrowRate: 15, // %
  warningSupplyRate: 3 // % — alert when a deposit's APY drops below this
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

// Both scanners return { positions, failures }. `failures` is a list of position-id
// prefixes whose source (chain/network/vault) failed this scan — the alert checkers
// use it to carry over previous state instead of pruning positions they couldn't
// see, which would silently re-seed them later and swallow a threshold crossing.

// LP positions (Orca for Solana wallets, Uniswap V3 for EVM wallets).
export async function scanPoolsForWallet(wallet) {
  const walletType = detectWalletType(wallet);
  // Orca is a single source: a failure throws and the caller keeps all state.
  if (walletType === "solana") return { positions: await getOrcaPositionsForWallet(wallet), failures: [] };
  if (walletType === "evm") return getUniswapPositionsForWallet(wallet);
  return { positions: [], failures: [] };
}

// Lending deposit (supply) positions: Kamino Earn for Solana, Aave + Fluid for EVM.
export async function scanSuppliesForWallet(wallet) {
  const walletType = detectWalletType(wallet);
  if (walletType === "solana") return getKaminoSupplies(wallet);
  if (walletType === "evm") {
    const [aave, fluid] = await Promise.all([
      scanAaveSuppliesForWallet(wallet),
      getFluidSuppliesForWallet(wallet)
    ]);
    return {
      positions: [...aave.positions, ...fluid.positions],
      failures: [...aave.failures, ...fluid.failures]
    };
  }
  return { positions: [], failures: [] };
}

export function isSupplyBelow(position, threshold) {
  return Number.isFinite(position.supplyApy) && position.supplyApy < threshold;
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

// Rescan lending markets for a user's wallets and persist the market lists.
// Returns per-wallet scan results (presentation is up to the caller).
export async function refreshWalletsCore(chatId, protocolFilter) {
  const user = (await getUser(chatId)) || {};
  const wallets = Object.entries(user.wallets || {}).filter(([_, data]) => {
    if ((data.protocol || "") === "tron") return false;
    if (!protocolFilter || protocolFilter === "all") return true;
    return (data.protocol || "kamino") === protocolFilter;
  });

  const results = [];
  for (const [wallet, walletData] of wallets) {
    const protocol = walletData.protocol || "kamino";
    try {
      const positions =
        protocol === "aave" ? await scanAaveMarketsForWallet(wallet) : await scanAllMarketsForWallet(wallet);
      await setWalletMarkets(chatId, wallet, (positions || []).map((p) => p.market));
      results.push({ address: wallet, protocol, positions: positions || [] });
    } catch (error) {
      logger.error({ wallet, error: error.message }, "Refresh failed");
      results.push({ address: wallet, protocol, positions: [], error: error.message });
    }
  }
  return results;
}

// Scan a wallet and persist it. Returns what was found so the caller can render
// it (Telegram reply or JSON). Throws with error.stage === "save" when scanning
// succeeded but persisting failed.
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
    return { protocol: "tron", tron, positions: [], pools: [], supplies: [] };
  }

  const protocol = walletType === "evm" ? "aave" : "kamino";
  const positions =
    protocol === "aave"
      ? await scanAaveMarketsForWallet(address)
      : await scanAllMarketsForWallet(address, onKaminoProgress);

  let pools = [];
  try {
    pools = (await scanPoolsForWallet(address)).positions;
  } catch (error) {
    logger.error({ address, error: error.message }, "Pool scan failed on add");
  }
  let supplies = [];
  try {
    supplies = (await scanSuppliesForWallet(address)).positions;
  } catch (error) {
    logger.error({ address, error: error.message }, "Supply scan failed on add");
  }

  if ((!positions || positions.length === 0) && pools.length === 0 && supplies.length === 0) {
    return { protocol, empty: true, positions: [], pools: [], supplies: [] };
  }

  // Baseline the alert states silently — alerts fire only on later transitions.
  // Must use the wallet-EFFECTIVE threshold (per-wallet overrides survive re-adds):
  // baselining with the global default would make the next background cycle see a
  // phantom transition whenever an override differs from the default.
  const user = (await getUser(chatId)) || {};
  const supplyThreshold = getWalletThresholds(user, address).warningSupplyRate;
  const poolStates = {};
  for (const pool of pools) poolStates[pool.id] = pool.inRange;
  const supplyStates = {};
  for (const supply of supplies) supplyStates[supply.id] = isSupplyBelow(supply, supplyThreshold);

  try {
    await upsertWallet(chatId, address, {
      protocol,
      markets: (positions || []).map((p) => p.market),
      poolStates,
      supplyStates
    });
  } catch (error) {
    error.stage = "save";
    throw error;
  }

  logger.info(
    { chatId, address, markets: (positions || []).length, pools: pools.length, supplies: supplies.length },
    "Wallet added"
  );
  return { protocol, positions: positions || [], pools, supplies };
}
