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

const POSITION_MANAGER_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function tokenOfOwnerByIndex(address,uint256) view returns (uint256)",
  "function positions(uint256) view returns (uint96 nonce,address operator,address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint128 liquidity,uint256 feeGrowthInside0LastX128,uint256 feeGrowthInside1LastX128,uint128 tokensOwed0,uint128 tokensOwed1)"
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
      const [slot0, token0, token1] = await Promise.all([
        pool.slot0(),
        getTokenMeta(networkKey, provider, position.token0),
        getTokenMeta(networkKey, provider, position.token1)
      ]);

      const inRange = slot0.tick >= position.tickLower && slot0.tick < position.tickUpper;
      const feePct = parseFloat((position.fee / 10000).toFixed(4));
      results.push({
        id: `uniswap:${networkKey}:${tokenId.toString()}`,
        platform: "uniswap",
        pool: `${token0.symbol}/${token1.symbol} ${feePct}% (${deployment.label})`,
        inRange,
        lowerPrice: tickToPrice(position.tickLower, token0.decimals, token1.decimals),
        upperPrice: tickToPrice(position.tickUpper, token0.decimals, token1.decimals),
        currentPrice: tickToPrice(slot0.tick, token0.decimals, token1.decimals),
        priceLabel: `${token1.symbol} per ${token0.symbol}`,
        isFullRange: false
      });
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
