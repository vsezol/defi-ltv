import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { providers, utils } = require("ethers");
const addressBook = require("@bgd-labs/aave-address-book");
const { IPool__factory } = require("@aave/contract-helpers/dist/cjs/v3-pool-contract/typechain/IPool__factory.js");
const { UiPoolDataProvider } = require("@aave/contract-helpers");
import { logger } from "./logger.js";
import { marketsCache } from "./cache.js";

const marketsKey = (networkKey) => `aave:${networkKey}`;

export const NETWORKS = [
  {
    key: "eth",
    name: "AaveV3Ethereum",
    label: "Aave V3 Ethereum",
    defaultRpcUrls: [
      "https://ethereum-rpc.publicnode.com",
      "https://cloudflare-eth.com",
      "https://rpc.ankr.com/eth",
      "https://eth.llamarpc.com"
    ]
  },
  {
    key: "arb",
    name: "AaveV3Arbitrum",
    label: "Aave V3 Arbitrum",
    defaultRpcUrls: [
      "https://arb1.arbitrum.io/rpc",
      "https://arbitrum-one.publicnode.com",
      "https://rpc.ankr.com/arbitrum"
    ]
  },
  {
    key: "base",
    name: "AaveV3Base",
    label: "Aave V3 Base",
    defaultRpcUrls: [
      "https://mainnet.base.org",
      "https://base-rpc.publicnode.com",
      "https://rpc.ankr.com/base"
    ]
  },
  {
    key: "polygon",
    name: "AaveV3Polygon",
    label: "Aave V3 Polygon",
    defaultRpcUrls: [
      "https://polygon-bor-rpc.publicnode.com",
      "https://polygon-rpc.com",
      "https://polygon.drpc.org"
    ]
  }
];

function normalizeRpcUrls(defaults) {
  const urls = [];
  if (urls.length === 0) urls.push(...defaults);
  return Array.from(new Set(urls));
}

function getNetworkConfig(key) {
  const network = NETWORKS.find((item) => item.key === key);
  if (!network) {
    throw new Error(`Unknown Aave network: ${key}`);
  }
  return network;
}

function getRpcUrlsForNetwork(key) {
  const network = getNetworkConfig(key);
  return normalizeRpcUrls(network.defaultRpcUrls);
}

function getMarketConfig(key) {
  const network = getNetworkConfig(key);
  const config = addressBook[network.name];
  if (!config) {
    throw new Error(`Aave market not found: ${network.name}`);
  }
  return config;
}

function createMarketClients(key, provider) {
  const config = getMarketConfig(key);
  const pool = IPool__factory.connect(config.POOL, provider);
  const ui = new UiPoolDataProvider({
    uiPoolDataProviderAddress: config.UI_POOL_DATA_PROVIDER,
    provider,
    chainId: config.CHAIN_ID
  });
  return { config, pool, ui };
}

export async function withRpcFallback(key, fn) {
  const urls = getRpcUrlsForNetwork(key);
  let lastError;
  for (const url of urls) {
    const provider = new providers.JsonRpcProvider(url);
    try {
      return await fn(provider, url);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

async function fetchAaveMarketsForNetwork(key) {
  return withRpcFallback(key, async (provider, url) => {
    const { config, ui } = createMarketClients(key, provider);
    const reserves = await ui.getReservesHumanized({
      lendingPoolAddressProvider: config.POOL_ADDRESSES_PROVIDER
    });
    const markets = reserves.reservesData.map((reserve) => ({
      symbol: reserve.symbol,
      underlyingAsset: reserve.underlyingAsset,
      decimals: reserve.decimals
    }));
    await marketsCache.set(marketsKey(key), markets);
    return markets;
  });
}

export async function fetchAaveMarketsAll() {
  const results = [];
  for (const network of NETWORKS) {
    try {
      const markets = await fetchAaveMarketsForNetwork(network.key);
      results.push({ network: network.key, markets });
    } catch (error) {
      logger.error({ network: network.key, error: error.message }, "Failed to fetch Aave markets");
    }
  }
  return results;
}

async function getCachedAaveMarkets(key) {
  const cached = await marketsCache.get(marketsKey(key));
  if (cached && cached.length > 0) return cached;
  return fetchAaveMarketsForNetwork(key);
}

async function getAavePositionsForNetwork(key, walletAddress) {
  const [accountData, userData, cachedMarkets, reservesData] = await withRpcFallback(
    key,
    async (provider) => {
      const { config, pool, ui } = createMarketClients(key, provider);
      return Promise.all([
        pool.getUserAccountData(walletAddress),
        ui.getUserReservesHumanized({
          lendingPoolAddressProvider: config.POOL_ADDRESSES_PROVIDER,
          user: walletAddress
        }),
        getCachedAaveMarkets(key),
        ui.getReservesHumanized({
          lendingPoolAddressProvider: config.POOL_ADDRESSES_PROVIDER
        })
      ]);
    }
  );

  if (accountData.totalDebtBase.isZero() || accountData.totalCollateralBase.isZero()) {
    return [];
  }

  const currentLtv =
    accountData.totalDebtBase.mul(10000).div(accountData.totalCollateralBase).toNumber() / 100;
  const liquidationLtv = accountData.currentLiquidationThreshold.toNumber() / 100;
  const healthFactor = Number(utils.formatUnits(accountData.healthFactor, 18));

  if (!Number.isFinite(healthFactor) || healthFactor <= 0) {
    return [];
  }

  const marketByAsset = new Map(
    cachedMarkets.map((market) => [market.underlyingAsset.toLowerCase(), market])
  );
  // variableBorrowRate is an APR expressed in ray (1e27). Convert to a percentage.
  const borrowRateByAsset = new Map(
    (reservesData?.reservesData || []).map((reserve) => [
      reserve.underlyingAsset.toLowerCase(),
      Math.round((Number(reserve.variableBorrowRate) / 1e27) * 100 * 100) / 100
    ])
  );
  const label = getNetworkConfig(key).label;

  return userData.userReserves
    .filter((reserve) => Number(reserve.scaledVariableDebt) > 0)
    .map((reserve) => {
      const asset = reserve.underlyingAsset.toLowerCase();
      const market = marketByAsset.get(asset);
      const marketLabel = market ? `${label} ${market.symbol}` : label;
      const token = market ? market.symbol : "?";
      const borrowRate = borrowRateByAsset.has(asset) ? borrowRateByAsset.get(asset) : null;
      return {
        market: marketLabel,
        ltv: currentLtv.toFixed(2),
        liquidationLtv: liquidationLtv.toFixed(2),
        healthFactor: Math.round(healthFactor * 100) / 100,
        borrows: borrowRate == null ? [] : [{ token, rate: borrowRate }],
        borrowRate
      };
    });
}

const RAY = 1e27;
const SECONDS_PER_YEAR = 31536000;

// Supply (deposit) positions. Deliberately separate from the borrow flow:
// getAavePositionsForNetwork early-returns [] when there's no debt, which is
// exactly the supply-only case this scanner must catch.
async function getAaveSuppliesForNetwork(key, walletAddress) {
  const [userData, reservesData] = await withRpcFallback(key, async (provider) => {
    const { config, ui } = createMarketClients(key, provider);
    return Promise.all([
      ui.getUserReservesHumanized({
        lendingPoolAddressProvider: config.POOL_ADDRESSES_PROVIDER,
        user: walletAddress
      }),
      ui.getReservesHumanized({
        lendingPoolAddressProvider: config.POOL_ADDRESSES_PROVIDER
      })
    ]);
  });

  const reserveByAsset = new Map(
    reservesData.reservesData.map((reserve) => [reserve.underlyingAsset.toLowerCase(), reserve])
  );
  const base = reservesData.baseCurrencyData;
  const label = getNetworkConfig(key).label;

  return userData.userReserves
    .filter((reserve) => Number(reserve.scaledATokenBalance) > 0)
    .map((reserve) => {
      const info = reserveByAsset.get(reserve.underlyingAsset.toLowerCase());
      if (!info) return null;
      // scaledATokenBalance × liquidityIndex (ray) = underlying balance.
      const amount =
        (Number(reserve.scaledATokenBalance) / 10 ** info.decimals) * (Number(info.liquidityIndex) / RAY);
      const priceUsd =
        (Number(info.priceInMarketReferenceCurrency) / 10 ** base.marketReferenceCurrencyDecimals) *
        (Number(base.marketReferenceCurrencyPriceInUsd) / 1e8);
      // liquidityRate is the supply APR in ray; Aave compounds supply per second.
      const apr = Number(info.liquidityRate) / RAY;
      const apy = Math.pow(1 + apr / SECONDS_PER_YEAR, SECONDS_PER_YEAR) - 1;
      return {
        id: `aave:${key}:${info.symbol}`,
        platform: "aave",
        market: label,
        asset: info.symbol,
        amount,
        amountUsd: amount * priceUsd,
        supplyApy: Math.round(apy * 100 * 100) / 100
      };
    })
    .filter(Boolean);
}

// Returns { positions, failures } — failures lists the id prefix of each network
// whose scan failed, so callers can keep previous alert state instead of pruning.
export async function scanAaveSuppliesForWallet(walletAddress) {
  const positions = [];
  const failures = [];
  for (const network of NETWORKS) {
    try {
      positions.push(...(await getAaveSuppliesForNetwork(network.key, walletAddress)));
    } catch (error) {
      failures.push(`aave:${network.key}:`);
      logger.error({ network: network.key, walletAddress, error: error.message }, "Aave supply scan failed");
    }
  }
  return { positions, failures };
}

export async function scanAaveMarketsForWallet(walletAddress) {
  const results = [];
  for (const network of NETWORKS) {
    try {
      const positions = await getAavePositionsForNetwork(network.key, walletAddress);
      results.push(...positions);
    } catch (error) {
      logger.error({ network: network.key, walletAddress, error: error.message }, "Aave scan failed");
    }
  }
  return results;
}

export async function checkAaveMarkets(walletAddress) {
  return scanAaveMarketsForWallet(walletAddress);
}
