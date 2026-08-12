import { logger } from "./logger.js";

// Meteora DLMM positions via the datapi host — returns a wallet's positions with
// human-unit prices already computed (tokenY per tokenX), no Solana RPC needed.
// Two calls: /portfolio/open lists pools with open positions (symbols, baseFee),
// /positions/{pool}/pnl gives each position's min/max/active price + in-range flag.
const DLMM_API = "https://dlmm.datapi.meteora.ag";
const MAX_PAGES = 20;

async function getMeteoraJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`Meteora API ${response.status}`);
  return response.json();
}

async function fetchPaged(path, key) {
  const items = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const sep = path.includes("?") ? "&" : "?";
    const data = await getMeteoraJson(`${DLMM_API}${path}${sep}page=${page}&pageSize=100`);
    items.push(...(data[key] || []));
    if (!data.hasNext) break;
  }
  return items;
}

// Array of the unified pool-position shape. Throws on any API failure so the
// caller can treat Meteora as a failed source and keep previous alert state
// (rather than pruning positions it couldn't see this cycle).
export async function getMeteoraPositionsForWallet(walletAddress) {
  const pools = await fetchPaged(`/portfolio/open?user=${walletAddress}`, "pools");
  if (pools.length === 0) return [];

  const perPool = await Promise.all(
    pools.map(async (pool) => {
      const symX = pool.tokenX || `${(pool.tokenXMint || "").slice(0, 4)}…`;
      const symY = pool.tokenY || `${(pool.tokenYMint || "").slice(0, 4)}…`;
      const feePct = pool.baseFee; // already a percentage (0.04 => "0.04%")
      const positions = await fetchPaged(`/positions/${pool.poolAddress}/pnl?user=${walletAddress}`, "positions");
      return positions
        .filter((p) => !p.isClosed)
        .map((p) => ({
          id: `meteora:${p.positionAddress}`,
          platform: "meteora",
          pool: `${symX}/${symY} ${feePct}% (Solana)`,
          inRange: !p.isOutOfRange,
          lowerPrice: Number(p.minPrice),
          upperPrice: Number(p.maxPrice),
          currentPrice: Number(p.poolActivePrice),
          priceLabel: `${symY} per ${symX}`,
          isFullRange: false // DLMM positions are always bounded bin ranges
        }));
    })
  );

  const positions = perPool.flat();
  logger.info({ walletAddress, positions: positions.length }, "Meteora scan");
  return positions;
}
