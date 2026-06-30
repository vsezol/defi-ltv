import { logger } from "./logger.js";
import { marketsCache } from "./cache.js";

const MARKETS_KEY = "kamino";

const KAMINO_API = "https://api.kamino.finance";
const NULL_PUBKEY = "11111111111111111111111111111111";

export async function fetchMarkets() {
  logger.info("Fetching markets from Kamino API");
  
  const response = await fetch(`${KAMINO_API}/v2/kamino-market`);
  
  if (!response.ok) {
    throw new Error(`Failed to fetch markets: ${response.status}`);
  }
  
  const markets = await response.json();
  await marketsCache.set(MARKETS_KEY, markets);

  logger.info({ count: markets.length }, "Markets loaded and saved");
  return markets;
}

export async function getCachedMarkets() {
  return marketsCache.get(MARKETS_KEY);
}

export async function getObligations(marketPubkey, walletAddress) {
  const url = `${KAMINO_API}/kamino-market/${marketPubkey}/users/${walletAddress}/obligations`;
  const response = await fetch(url);

  if (!response.ok) {
    if (response.status === 404) return [];
    throw new Error(`API Error: ${response.status}`);
  }

  return response.json();
}

export async function getReservesMetrics(marketPubkey) {
  const url = `${KAMINO_API}/kamino-market/${marketPubkey}/reserves/metrics`;
  const response = await fetch(url);

  if (!response.ok) {
    if (response.status === 404) return [];
    throw new Error(`API Error: ${response.status}`);
  }

  return response.json();
}

function buildBorrowApyMap(metrics) {
  return new Map(
    (metrics || []).map((m) => [m.reserve, { token: m.liquidityToken, apy: parseFloat(m.borrowApy) }])
  );
}

// Per-asset borrow rates of a Kamino obligation: [{ token, rate }] for each borrowed reserve.
function computeBorrows(obl, borrowApyByReserve) {
  const borrows = obl?.state?.borrows;
  if (!Array.isArray(borrows)) return [];

  const result = [];
  for (const b of borrows) {
    if (!b || b.borrowReserve === NULL_PUBKEY) continue;
    if (b.borrowedAmountSf && parseFloat(b.borrowedAmountSf) <= 0) continue;
    const meta = borrowApyByReserve.get(b.borrowReserve);
    if (!meta || !Number.isFinite(meta.apy)) continue;
    result.push({ token: meta.token || "?", rate: Math.round(meta.apy * 100 * 100) / 100 });
  }
  return result;
}

function maxRate(borrows) {
  let max = null;
  for (const b of borrows) {
    if (max == null || b.rate > max) max = b.rate;
  }
  return max;
}

function parseObligation(obl, marketName, borrowApyByReserve) {
  const stats = obl.refreshedStats;

  if (!stats || parseFloat(stats.userTotalBorrow) <= 0) {
    return null;
  }

  const ltv = parseFloat(stats.loanToValue) * 100;
  const liquidationLtv = parseFloat(stats.liquidationLtv) * 100;
  const borrows = computeBorrows(obl, borrowApyByReserve || new Map());

  return {
    market: marketName,
    ltv: ltv.toFixed(2),
    liquidationLtv: liquidationLtv.toFixed(2),
    borrowed: parseFloat(stats.userTotalBorrow).toFixed(2),
    deposited: parseFloat(stats.userTotalDeposit).toFixed(2),
    netValue: parseFloat(stats.netAccountValue).toFixed(2),
    tag: obl.humanTag,
    healthFactor: Math.round(liquidationLtv / ltv * 100) / 100,
    borrows,
    borrowRate: maxRate(borrows)
  };
}

export async function scanAllMarketsForWallet(walletAddress, marketCheckCallback) {
  const markets = await getCachedMarkets();

  if (!markets || markets.length === 0) {
    throw new Error("Markets not loaded");
  }

  const results = [];

  let index = 0;
  for (const market of markets) {
    try {
      const [obligations, metrics] = await Promise.all([
        getObligations(market.lendingMarket, walletAddress),
        getReservesMetrics(market.lendingMarket)
      ]);
      const borrowApyByReserve = buildBorrowApyMap(metrics);

      for (const obl of obligations) {
        const pos = parseObligation(obl, market.name, borrowApyByReserve);
        if (pos) {
          results.push(pos);
        }
      }
    } catch (error) {
      logger.warn({ market: market.name, error: error.message }, "Failed to check market");
    }

    marketCheckCallback?.({current: index++, total: markets.length});
  }

  return results;
}

export async function checkSpecificMarkets(walletAddress, marketNames) {
  const allMarkets = await getCachedMarkets();

  if (!allMarkets || allMarkets.length === 0) {
    throw new Error("Markets not loaded");
  }
  
  const marketsToCheck = allMarkets.filter(m => marketNames.includes(m.name));
  const results = [];

  logger.info({ walletAddress, marketNames }, `Markets to check size: ${marketsToCheck.length}`);
  
  for (const market of marketsToCheck) {
    try {
      const [obligations, metrics] = await Promise.all([
        getObligations(market.lendingMarket, walletAddress),
        getReservesMetrics(market.lendingMarket)
      ]);
      const borrowApyByReserve = buildBorrowApyMap(metrics);

      logger.info({ walletAddress, market: market.name, obligations: obligations.length }, "Obligations");

      for (const obl of obligations) {
        const pos = parseObligation(obl, market.name, borrowApyByReserve);
        if (pos) {
          results.push(pos);
        }
      }
    } catch (error) {
      logger.warn({ market: market.name, error: error.message }, "Failed to check market");
    }
  }
  
  return results;
}