import { fetchMarkets, checkSpecificMarkets } from "./kamino.js";
import { fetchAaveMarketsAll, checkAaveMarkets } from "./aave.js";
import { getTronResources, computeTronFlags } from "./tron.js";
import {
  getWalletThresholds,
  scanPoolsForWallet,
  scanSuppliesForWallet,
  isSupplyBelow,
  positionSeverity
} from "./core.js";
import {
  getAllUsers,
  getUserCount,
  setWalletPoolStates,
  setWalletSupplyStates,
  setWalletTronState
} from "./db.js";
import { sendNotification } from "./notifier.js";
import { logger } from "./logger.js";

// Background alert loops. All Telegram rendering lives in the bot microservice —
// these loops emit structured events via the notifier. Every alert follows
// send-before-persist: a failed delivery throws, the previous state is kept, and
// the transition fires again on the next cycle.

export const CHECK_INTERVAL = 10 * 60 * 1000;
export const TRON_CHECK_INTERVAL = 60 * 60 * 1000;

async function refreshMarketsBackground() {
  try {
    await fetchMarkets();
    await fetchAaveMarketsAll();
  } catch (error) {
    logger.error({ error: error.message }, "Failed to refresh markets in background");
  }
}

async function checkLendingForWallet(chatId, user, wallet, walletData) {
  const protocol = walletData.protocol || "kamino";
  const markets = walletData.markets || [];
  const thresholds = getWalletThresholds(user, wallet);

  if (protocol === "kamino" && markets.length === 0) return;

  let positions;
  if (protocol === "aave") {
    positions = await checkAaveMarkets(wallet);
  } else {
    positions = await checkSpecificMarkets(wallet, markets);
  }

  if (!positions || positions.length === 0) return;

  const withSeverity = positions.map((p) => ({
    ...p,
    platform: protocol,
    severity: positionSeverity(thresholds, p.healthFactor, p.borrowRate)
  }));
  const breaching = withSeverity.filter((p) => p.severity >= 1);
  if (breaching.length === 0) return;

  logger.info(
    { chatId, wallet, protocol, breaching: breaching.map((p) => p.market), thresholds },
    "Threshold breached"
  );
  await sendNotification(chatId, { type: "lending-alert", wallet, protocol, positions: withSeverity });
}

// A position missing from this scan because its source (chain/network) failed must
// keep its previous alert state — pruning it would silently re-seed the baseline on
// recovery and swallow any threshold/range crossing that happened around the outage.
function carryOverFailedSources(next, previous, failures) {
  if (failures.length === 0) return;
  for (const [id, state] of Object.entries(previous)) {
    if (id in next) continue;
    if (failures.some((prefix) => id.startsWith(prefix))) next[id] = state;
  }
}

// Notify only when a pool position crosses the range boundary (in <-> out).
// First sighting of a position just records the baseline state silently.
async function checkPoolsForWallet(chatId, wallet, walletData) {
  const { positions: pools, failures } = await scanPoolsForWallet(wallet);
  const previous = walletData.poolStates || {};
  const next = {};
  const transitions = [];
  const seeded = [];

  for (const pool of pools) {
    next[pool.id] = pool.inRange;
    if (!(pool.id in previous)) {
      seeded.push(`${pool.pool} = ${pool.inRange ? "in" : "out"}`);
    } else if (previous[pool.id] !== pool.inRange) {
      transitions.push(pool);
    }
  }
  carryOverFailedSources(next, previous, failures);

  if (seeded.length > 0) {
    logger.info({ chatId, wallet, seeded }, "Pool baseline recorded");
  }

  if (transitions.length > 0) {
    logger.info(
      { chatId, wallet, transitions: transitions.map((p) => `${p.pool} -> ${p.inRange ? "in" : "out"}`) },
      "Pool range transition"
    );
    await sendNotification(chatId, { type: "pool-transition", wallet, transitions });
  }

  if (JSON.stringify(next) !== JSON.stringify(previous)) {
    await setWalletPoolStates(chatId, wallet, next);
  }
}

// Notify only when a deposit's APY crosses the warning threshold (below <-> above).
// First sighting of a position just records the baseline state silently.
async function checkSuppliesForWallet(chatId, user, wallet, walletData) {
  const { positions: supplies, failures } = await scanSuppliesForWallet(wallet);
  const threshold = getWalletThresholds(user, wallet).warningSupplyRate;
  const previous = walletData.supplyStates || {};
  const next = {};
  const transitions = [];
  const seeded = [];

  for (const supply of supplies) {
    const below = isSupplyBelow(supply, threshold);
    next[supply.id] = below;
    if (!(supply.id in previous)) {
      seeded.push(`${supply.asset} = ${below ? "below" : "ok"}`);
    } else if (previous[supply.id] !== below) {
      transitions.push({ ...supply, below });
    }
  }
  carryOverFailedSources(next, previous, failures);

  if (seeded.length > 0) {
    logger.info({ chatId, wallet, seeded }, "Supply baseline recorded");
  }

  if (transitions.length > 0) {
    logger.info(
      { chatId, wallet, threshold, transitions: transitions.map((s) => `${s.asset} @ ${s.supplyApy}%`) },
      "Supply APY transition"
    );
    await sendNotification(chatId, { type: "supply-transition", wallet, threshold, transitions });
  }

  if (JSON.stringify(next) !== JSON.stringify(previous)) {
    await setWalletSupplyStates(chatId, wallet, next);
  }
}

async function checkAllUsers() {
  try {
    for (const [chatId, user] of await getAllUsers()) {
      logger.info({ chatId }, "Checking user positions on background");

      if (!user.wallets) continue;

      for (const [wallet, walletData] of Object.entries(user.wallets)) {
        if ((walletData.protocol || "") === "tron") continue; // Tron has its own slower loop
        try {
          await checkLendingForWallet(chatId, user, wallet, walletData);
        } catch (error) {
          logger.error({ chatId, wallet, error: error.message }, "Check failed");
        }
        try {
          await checkSuppliesForWallet(chatId, user, wallet, walletData);
        } catch (error) {
          // Keep previous supplyStates on scan failure to avoid phantom transitions.
          logger.error({ chatId, wallet, error: error.message }, "Supply check failed");
        }
        try {
          await checkPoolsForWallet(chatId, wallet, walletData);
        } catch (error) {
          // Keep previous poolStates on scan failure to avoid phantom transitions.
          logger.error({ chatId, wallet, error: error.message }, "Pool check failed");
        }
      }
    }
  } catch (error) {
    logger.error({ error: error.message }, "Background check cycle failed");
  }
}

// Notify on transition into an actionable state (false -> true):
// - reclaim:  a delegation unlocked and there's bandwidth to reclaim it
// - delegate: resources are free and nothing is delegated
async function checkTronForWallet(chatId, wallet, walletData) {
  const res = await getTronResources(wallet);
  const flags = computeTronFlags(res);
  const prev = walletData.tronState;

  if (!prev) {
    await setWalletTronState(chatId, wallet, flags);
    logger.info({ chatId, wallet, flags }, "Tron baseline recorded");
    return;
  }

  const notes = [];
  if (flags.reclaim && !prev.reclaim) {
    notes.push("🔓 Resources ready to reclaim (delegation unlocked)");
  }
  if (flags.delegate && !prev.delegate) {
    notes.push("🟢 Resources free to delegate");
  }

  if (notes.length > 0) {
    logger.info({ chatId, wallet, notes }, "Tron transition");
    await sendNotification(chatId, { type: "tron-transition", wallet, notes, resources: res });
  }

  if (prev.reclaim !== flags.reclaim || prev.delegate !== flags.delegate) {
    await setWalletTronState(chatId, wallet, flags);
  }
}

async function checkAllTron() {
  try {
    for (const [chatId, user] of await getAllUsers()) {
      if (!user.wallets) continue;
      for (const [wallet, walletData] of Object.entries(user.wallets)) {
        if ((walletData.protocol || "") !== "tron") continue;
        try {
          await checkTronForWallet(chatId, wallet, walletData);
        } catch (error) {
          logger.error({ chatId, wallet, error: error.message }, "Tron check failed");
        }
      }
    }
  } catch (error) {
    logger.error({ error: error.message }, "Tron check cycle failed");
  }
}

export async function startAlertLoops() {
  setInterval(refreshMarketsBackground, CHECK_INTERVAL);
  setInterval(checkAllUsers, CHECK_INTERVAL);
  setInterval(checkAllTron, TRON_CHECK_INTERVAL);

  const userCount = await getUserCount();
  if (userCount > 0) {
    logger.info({ count: userCount }, "Users loaded");
    setTimeout(checkAllUsers, 5000);
    setTimeout(checkAllTron, 15000);
  }
}
