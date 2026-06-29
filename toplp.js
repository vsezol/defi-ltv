import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { utils } = require("ethers");
import { logger } from "./logger.js";

const DEFILLAMA_CHAINS = "https://api.llama.fi/v2/chains";
const DEFILLAMA_POOLS = "https://yields.llama.fi/pools";

const TOP_CHAINS = 5;
const MIN_TVL_USD = 100_000;
const DISPLAY_LIMIT = 10;

const UNISWAP_V3 = "uniswap-v3";
const UNISWAP_V4 = "uniswap-v4";

const BTC_SYMBOLS = new Set(["WBTC", "CBBTC"]);
const ETH_SYMBOLS = new Set(["WETH", "ETH"]);
// USDC / USDT and their common bridged/omnichain variants (USDC.e, USDbC, USDT0, ...).
const isStable = (sym) => /^USD[CT]/.test(sym) || sym === "USDBC";

// Uniswap v3 pool addresses are deterministic (CREATE2), so a direct explore link
// can be built from token pair + fee without any extra API call.
const UNI_V3_INIT_HASH = "0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54";
const UNI_V3_FACTORY = {
  Ethereum: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
  Arbitrum: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
  Polygon: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
  "OP Mainnet": "0x1F98431c8aD98523631AE4a59f267346ea31F984",
  Base: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD",
  BSC: "0xdB1d10011AD0Ff90774D0C6Bb92e5C5c8b4461F7",
  Avalanche: "0x740b1c1de25031C31FF4fC9A62f554A55cdC1baD"
};
const UNI_EXPLORE_SLUG = {
  Ethereum: "ethereum",
  Arbitrum: "arbitrum",
  Polygon: "polygon",
  "OP Mainnet": "optimism",
  Base: "base",
  BSC: "bnb",
  Avalanche: "avalanche",
  Unichain: "unichain"
};

async function fetchJson(url, timeout = 30000) {
  const response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(timeout) });
  if (!response.ok) throw new Error(`${url} -> ${response.status}`);
  return response.json();
}

function parseFeeBps(poolMeta) {
  const m = String(poolMeta || "").match(/([\d.]+)\s*%/);
  return m ? Math.round(parseFloat(m[1]) * 10000) : null;
}

function uniswapV3PoolAddress(factory, a, b, feeBps) {
  const [t0, t1] = a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];
  const salt = utils.keccak256(utils.defaultAbiCoder.encode(["address", "address", "uint24"], [t0, t1, feeBps]));
  return utils.getCreate2Address(factory, salt, UNI_V3_INIT_HASH);
}

function buildPoolUrl(chain, version, tokens, feeBps) {
  const slug = UNI_EXPLORE_SLUG[chain];
  if (!slug || !Array.isArray(tokens) || tokens.length !== 2) return null;
  if (version === "v3") {
    const factory = UNI_V3_FACTORY[chain];
    if (!factory || feeBps == null) return null;
    const address = uniswapV3PoolAddress(factory, tokens[0], tokens[1], feeBps);
    return `https://app.uniswap.org/explore/pools/${slug}/${address}`;
  }
  // v4 has no per-pool address (singleton manager); deep-link to liquidity creation.
  return `https://app.uniswap.org/positions/create/v4?currencyA=${tokens[0]}&currencyB=${tokens[1]}&chain=${slug}`;
}

// Top EVM chains by TVL (numeric chainId = EVM); names match the yields endpoint.
async function getTopEvmChains(exclude) {
  const chains = await fetchJson(DEFILLAMA_CHAINS);
  return chains
    .filter((c) => Number.isFinite(c.chainId) && Number.isFinite(c.tvl) && !exclude.has(c.name))
    .sort((a, b) => b.tvl - a.tvl)
    .slice(0, TOP_CHAINS)
    .map((c) => ({ name: c.name, tvl: c.tvl }));
}

// Only pools pairing a BTC or ETH token WITH a stablecoin qualify.
// BTC/ETH pairs and non-stable pairs are excluded.
function categoryOf(symbolParts) {
  if (symbolParts.length !== 2) return null;
  const hasBtc = symbolParts.some((s) => BTC_SYMBOLS.has(s));
  const hasEth = symbolParts.some((s) => ETH_SYMBOLS.has(s));
  const hasStable = symbolParts.some((s) => isStable(s));
  if (!hasStable) return null;
  if (hasBtc) return "btc";
  if (hasEth) return "eth";
  return null;
}

function buildCandidate(pool) {
  const symbolParts = String(pool.symbol || "").toUpperCase().split(/[-/]/).map((s) => s.trim());
  const version = pool.project === UNISWAP_V4 ? "v4" : "v3";
  const feeBps = parseFeeBps(pool.poolMeta);
  return {
    chain: pool.chain,
    version,
    feeLabel: pool.poolMeta || "?",
    tvl: pool.tvlUsd,
    vol7d: pool.volumeUsd7d,
    symbol: symbolParts.join("/"),
    category: categoryOf(symbolParts),
    ratio: pool.tvlUsd > 0 ? pool.volumeUsd7d / pool.tvlUsd : -1,
    url: buildPoolUrl(pool.chain, version, pool.underlyingTokens, feeBps)
  };
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
  const chainNames = new Set(chains.map((c) => c.name));

  const poolsResp = await fetchJson(DEFILLAMA_POOLS);
  const candidates = (poolsResp.data || [])
    .filter(
      (p) =>
        (p.project === UNISWAP_V3 || p.project === UNISWAP_V4) &&
        chainNames.has(p.chain) &&
        Number.isFinite(p.tvlUsd) &&
        p.tvlUsd > MIN_TVL_USD &&
        Number.isFinite(p.volumeUsd7d) &&
        p.volumeUsd7d > 0 &&
        Array.isArray(p.underlyingTokens) &&
        p.underlyingTokens.length === 2
    )
    .map(buildCandidate)
    .filter((c) => c.category);

  logger.info({ chains: chains.map((c) => c.name), candidates: candidates.length }, "Top LP scan");

  return {
    chains,
    btc: topByRatio(candidates, "btc"),
    eth: topByRatio(candidates, "eth")
  };
}
