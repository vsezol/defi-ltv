import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { Contract } = require("ethers");
import { logger } from "./logger.js";
import { NETWORKS, withRpcFallback } from "./aave.js";

// Canonical Uniswap V3 deployments on the networks the app already supports.
const DEPLOYMENTS = {
  eth: {
    label: "Ethereum",
    positionManager: "0xC36442b4a4522E871399CD717aBDD847Ab11FE88",
    factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984"
  },
  arb: {
    label: "Arbitrum",
    positionManager: "0xC36442b4a4522E871399CD717aBDD847Ab11FE88",
    factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984"
  },
  base: {
    label: "Base",
    positionManager: "0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1",
    factory: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD"
  },
  polygon: {
    label: "Polygon",
    positionManager: "0xC36442b4a4522E871399CD717aBDD847Ab11FE88",
    factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984"
  }
};

const MAX_POSITIONS_PER_NETWORK = 25;
const MAX_UINT128 = "0xffffffffffffffffffffffffffffffff";

// DefiLlama coins API chain slugs for the supported networks (keyless).
const LLAMA_SLUGS = { eth: "ethereum", arb: "arbitrum", base: "base", polygon: "polygon" };
const LLAMA_PRICES = "https://coins.llama.fi/prices/current/";

const POSITION_MANAGER_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function tokenOfOwnerByIndex(address,uint256) view returns (uint256)",
  "function positions(uint256) view returns (uint96 nonce,address operator,address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint128 liquidity,uint256 feeGrowthInside0LastX128,uint256 feeGrowthInside1LastX128,uint128 tokensOwed0,uint128 tokensOwed1)",
  "function collect((uint256 tokenId,address recipient,uint128 amount0Max,uint128 amount1Max)) payable returns (uint256 amount0,uint256 amount1)"
];
const FACTORY_ABI = ["function getPool(address,address,uint24) view returns (address)"];
const POOL_ABI = [
  "function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16 observationIndex,uint16 observationCardinality,uint16 observationCardinalityNext,uint8 feeProtocol,bool unlocked)"
];
const ERC20_ABI = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)"
];

// symbol/decimals never change — cache per chain+address for the process lifetime.
const tokenMetaCache = new Map();

async function getTokenMeta(networkKey, provider, address) {
  const cacheKey = `${networkKey}:${address.toLowerCase()}`;
  if (tokenMetaCache.has(cacheKey)) return tokenMetaCache.get(cacheKey);
  const erc20 = new Contract(address, ERC20_ABI, provider);
  const [symbol, decimals] = await Promise.all([erc20.symbol(), erc20.decimals()]);
  const meta = { symbol, decimals };
  tokenMetaCache.set(cacheKey, meta);
  return meta;
}

// Price of token0 in units of token1.
function tickToPrice(tick, decimals0, decimals1) {
  return Math.pow(1.0001, tick) * Math.pow(10, decimals0 - decimals1);
}

// Token amounts currently backing the position, in raw token units. Float math —
// display-precision USD estimates, not settlement amounts.
function positionTokenAmounts(liquidity, sqrtPriceX96, tickLower, tickUpper) {
  const L = Number(liquidity.toString());
  const sp = Number(sqrtPriceX96.toString()) / 2 ** 96;
  const sl = Math.sqrt(Math.pow(1.0001, tickLower));
  const su = Math.sqrt(Math.pow(1.0001, tickUpper));
  if (sp <= sl) return { amount0: L * (1 / sl - 1 / su), amount1: 0 };
  if (sp >= su) return { amount0: 0, amount1: L * (su - sl) };
  return { amount0: L * (1 / sp - 1 / su), amount1: L * (sp - sl) };
}

// Uncollected fees via a simulated collect() (eth_call from the owner) — this
// includes fees accrued since the last on-chain poke, unlike raw tokensOwed.
async function getPendingFeeAmounts(positionManager, tokenId, walletAddress) {
  try {
    const collected = await positionManager.callStatic.collect(
      { tokenId, recipient: walletAddress, amount0Max: MAX_UINT128, amount1Max: MAX_UINT128 },
      { from: walletAddress }
    );
    return { fee0: Number(collected.amount0.toString()), fee1: Number(collected.amount1.toString()) };
  } catch (error) {
    logger.warn({ tokenId: tokenId.toString(), error: error.message }, "Uniswap fee simulation failed");
    return null;
  }
}

async function getTokenPricesUsd(networkKey, addresses) {
  const slug = LLAMA_SLUGS[networkKey];
  if (!slug || addresses.length === 0) return {};
  const keys = addresses.map((a) => `${slug}:${a}`).join(",");
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(LLAMA_PRICES + keys, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(15000)
      });
      if (!response.ok) throw new Error(`prices -> ${response.status}`);
      const data = await response.json();
      const prices = {};
      for (const [key, value] of Object.entries(data.coins || {})) {
        prices[key.split(":")[1].toLowerCase()] = value.price;
      }
      return prices;
    } catch (error) {
      logger.warn({ networkKey, attempt, error: error.message }, "Token price fetch failed");
    }
  }
  return {};
}

async function getUniswapPositionsForNetwork(networkKey, walletAddress) {
  const deployment = DEPLOYMENTS[networkKey];
  if (!deployment) return [];

  return withRpcFallback(networkKey, async (provider) => {
    const positionManager = new Contract(deployment.positionManager, POSITION_MANAGER_ABI, provider);
    const factory = new Contract(deployment.factory, FACTORY_ABI, provider);

    const balance = (await positionManager.balanceOf(walletAddress)).toNumber();
    if (balance === 0) return [];
    if (balance > MAX_POSITIONS_PER_NETWORK) {
      logger.warn(
        { walletAddress, network: networkKey, balance },
        `Wallet has more than ${MAX_POSITIONS_PER_NETWORK} Uniswap positions, checking first ${MAX_POSITIONS_PER_NETWORK}`
      );
    }

    const results = [];
    const count = Math.min(balance, MAX_POSITIONS_PER_NETWORK);
    for (let i = 0; i < count; i += 1) {
      const tokenId = await positionManager.tokenOfOwnerByIndex(walletAddress, i);
      const position = await positionManager.positions(tokenId);
      if (position.liquidity.isZero()) continue;

      const poolAddress = await factory.getPool(position.token0, position.token1, position.fee);
      const pool = new Contract(poolAddress, POOL_ABI, provider);
      const [slot0, token0, token1, fees] = await Promise.all([
        pool.slot0(),
        getTokenMeta(networkKey, provider, position.token0),
        getTokenMeta(networkKey, provider, position.token1),
        getPendingFeeAmounts(positionManager, tokenId, walletAddress)
      ]);

      const inRange = slot0.tick >= position.tickLower && slot0.tick < position.tickUpper;
      const feePct = parseFloat((position.fee / 10000).toFixed(4));
      const { amount0, amount1 } = positionTokenAmounts(
        position.liquidity, slot0.sqrtPriceX96, position.tickLower, position.tickUpper
      );
      results.push({
        id: `uniswap:${networkKey}:${tokenId.toString()}`,
        platform: "uniswap",
        pool: `${token0.symbol}/${token1.symbol} ${feePct}% (${deployment.label})`,
        inRange,
        lowerPrice: tickToPrice(position.tickLower, token0.decimals, token1.decimals),
        upperPrice: tickToPrice(position.tickUpper, token0.decimals, token1.decimals),
        currentPrice: tickToPrice(slot0.tick, token0.decimals, token1.decimals),
        priceLabel: `${token1.symbol} per ${token0.symbol}`,
        isFullRange: false,
        _pricing: {
          token0: position.token0.toLowerCase(),
          token1: position.token1.toLowerCase(),
          decimals0: token0.decimals,
          decimals1: token1.decimals,
          amount0,
          amount1,
          fees
        }
      });
    }

    // One price lookup per network covers every position's tokens.
    const tokenAddresses = [...new Set(results.flatMap((r) => [r._pricing.token0, r._pricing.token1]))];
    const priceOf = await getTokenPricesUsd(networkKey, tokenAddresses);
    for (const result of results) {
      const { token0, token1, decimals0, decimals1, amount0, amount1, fees } = result._pricing;
      delete result._pricing;
      const price0 = priceOf[token0];
      const price1 = priceOf[token1];
      if (!Number.isFinite(price0) || !Number.isFinite(price1)) continue;
      result.valueUsd = (amount0 / 10 ** decimals0) * price0 + (amount1 / 10 ** decimals1) * price1;
      if (fees) {
        result.pendingFeesUsd = (fees.fee0 / 10 ** decimals0) * price0 + (fees.fee1 / 10 ** decimals1) * price1;
      }
    }
    return results;
  });
}

export async function getUniswapPositionsForWallet(walletAddress) {
  const results = [];
  for (const network of NETWORKS) {
    try {
      const positions = await getUniswapPositionsForNetwork(network.key, walletAddress);
      results.push(...positions);
    } catch (error) {
      logger.error({ network: network.key, walletAddress, error: error.message }, "Uniswap scan failed");
    }
  }
  return results;
}
