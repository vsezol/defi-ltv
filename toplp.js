import { logger } from "./logger.js";

const DEFILLAMA_CHAINS = "https://api.llama.fi/v2/chains";
// Uniswap's own GraphQL gateway (powers app.uniswap.org). No key needed, but it
// requires the app Origin header. Provides v3 AND v4 pools with real volume.
const UNISWAP_GQL = "https://interface.gateway.uniswap.org/v1/graphql";
const UNISWAP_HEADERS = {
  "content-type": "application/json",
  accept: "application/json",
  Origin: "https://app.uniswap.org"
};

const TOP_CHAINS = 5;
const MIN_TVL_USD = 100_000;
const DISPLAY_LIMIT = 10;
const POOLS_PER_QUERY = 100; // API max per request
const DYNAMIC_FEE_FLAG = 0x800000; // v4 dynamic-fee sentinel

// DefiLlama chain name -> { uni: Uniswap Chain enum, slug: explore-URL slug }.
const CHAIN_MAP = {
  Ethereum: { uni: "ETHEREUM", slug: "ethereum" },
  BSC: { uni: "BNB", slug: "bnb" },
  Base: { uni: "BASE", slug: "base" },
  Arbitrum: { uni: "ARBITRUM", slug: "arbitrum" },
  Polygon: { uni: "POLYGON", slug: "polygon" },
  "OP Mainnet": { uni: "OPTIMISM", slug: "optimism" },
  Avalanche: { uni: "AVALANCHE", slug: "avalanche" },
  Unichain: { uni: "UNICHAIN", slug: "unichain" }
};

const BTC_SYMBOLS = new Set(["WBTC", "CBBTC"]);
const ETH_SYMBOLS = new Set(["WETH", "ETH"]);
// USDC / USDT and their common bridged/omnichain variants (USDC.e, USDbC, USDT0, ...).
const isStable = (sym) => /^USD[CT]/.test(sym) || sym === "USDBC";

async function fetchJson(url, timeout = 30000) {
  const response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(timeout) });
  if (!response.ok) throw new Error(`${url} -> ${response.status}`);
  return response.json();
}

async function uniswapQuery(query) {
  const response = await fetch(UNISWAP_GQL, {
    method: "POST",
    headers: UNISWAP_HEADERS,
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(20000)
  });
  if (!response.ok) throw new Error(`Uniswap API ${response.status}`);
  const data = await response.json();
  if (data.errors?.length) throw new Error(data.errors[0].message);
  return data.data;
}

function poolsQuery(op, chainEnum) {
  const idField = op === "topV4Pools" ? "poolId" : "address";
  return `query { ${op}(chain: ${chainEnum}, first: ${POOLS_PER_QUERY}) {
    protocolVersion feeTier ${idField}
    token0 { symbol } token1 { symbol }
    totalLiquidity { value }
    volume: cumulativeVolume(duration: MONTH) { value }
  } }`;
}

// Top EVM chains by TVL that Uniswap is deployed on (and we can map).
async function getTopEvmChains(exclude) {
  const chains = await fetchJson(DEFILLAMA_CHAINS);
  return chains
    .filter((c) => Number.isFinite(c.chainId) && Number.isFinite(c.tvl) && CHAIN_MAP[c.name] && !exclude.has(c.name))
    .sort((a, b) => b.tvl - a.tvl)
    .slice(0, TOP_CHAINS)
    .map((c) => ({ name: c.name, tvl: c.tvl, ...CHAIN_MAP[c.name] }));
}

// Only pools pairing a BTC or ETH token WITH a stablecoin qualify.
function categoryOf(a, b) {
  if (!(isStable(a) || isStable(b))) return null;
  if (BTC_SYMBOLS.has(a) || BTC_SYMBOLS.has(b)) return "btc";
  if (ETH_SYMBOLS.has(a) || ETH_SYMBOLS.has(b)) return "eth";
  return null;
}

function formatFee(feeTier) {
  if (feeTier === DYNAMIC_FEE_FLAG) return "dynamic";
  return `${parseFloat((feeTier / 10000).toFixed(4))}%`;
}

function buildCandidate(pool, chain) {
  const a = (pool.token0?.symbol || "").toUpperCase();
  const b = (pool.token1?.symbol || "").toUpperCase();
  const category = categoryOf(a, b);
  if (!category) return null;

  const tvl = pool.totalLiquidity?.value;
  const vol30d = pool.volume?.value;
  if (!Number.isFinite(tvl) || tvl <= MIN_TVL_USD || !Number.isFinite(vol30d)) return null;

  const version = pool.protocolVersion === "V4" ? "v4" : "v3";
  const id = version === "v4" ? pool.poolId : pool.address;
  return {
    chain: chain.name,
    version,
    feeLabel: formatFee(pool.feeTier),
    tvl,
    vol30d,
    symbol: `${a}/${b}`,
    category,
    ratio: tvl > 0 ? vol30d / tvl : -1,
    url: id ? `https://app.uniswap.org/explore/pools/${chain.slug}/${id}` : null
  };
}

async function fetchChainCandidates(chain) {
  try {
    const [v3, v4] = await Promise.all([
      uniswapQuery(poolsQuery("topV3Pools", chain.uni)),
      uniswapQuery(poolsQuery("topV4Pools", chain.uni))
    ]);
    return [...(v3.topV3Pools || []), ...(v4.topV4Pools || [])]
      .map((p) => buildCandidate(p, chain))
      .filter(Boolean);
  } catch (error) {
    logger.warn({ chain: chain.name, error: error.message }, "Uniswap pools fetch failed");
    return [];
  }
}

function topByRatio(candidates, category) {
  return candidates
    .filter((c) => c.category === category)
    .sort((a, b) => b.ratio - a.ratio)
    .slice(0, DISPLAY_LIMIT);
}

export async function getTopLpPools(options = {}) {
  const exclude = new Set(options.excludeChains || []);
  const chains = await getTopEvmChains(exclude);
  if (chains.length === 0) throw new Error("No supported EVM chains resolved");

  const candidates = (await Promise.all(chains.map(fetchChainCandidates))).flat();
  logger.info({ chains: chains.map((c) => c.name), candidates: candidates.length }, "Top LP scan");

  return {
    chains,
    btc: topByRatio(candidates, "btc"),
    eth: topByRatio(candidates, "eth")
  };
}
