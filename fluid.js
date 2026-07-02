import { logger } from "./logger.js";

// Fluid (by Instadapp) public API — no key needed. Lending positions are fTokens
// (ERC4626); the API returns every fToken on the chain with the user's balance.
const FLUID_API = "https://api.fluid.instadapp.io";

const CHAINS = [
  { chainId: 1, label: "Ethereum" },
  { chainId: 42161, label: "Arbitrum" },
  { chainId: 8453, label: "Base" },
  { chainId: 137, label: "Polygon" }
];

async function fetchFluidChain(chain, walletAddress) {
  const url = `${FLUID_API}/v2/lending/${chain.chainId}/users/${walletAddress}/positions`;
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(20000)
      });
      if (!response.ok) throw new Error(`Fluid API ${response.status}`);
      return (await response.json()).data || [];
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

// Supply positions: { positions: [{ id, platform, market, asset, amount, amountUsd,
// supplyApy }], failures: ["fluid:<chainId>:"...] }. `failures` lists the id prefix
// of every chain whose scan failed, so the alert checker can keep (not prune) the
// previous state of positions it couldn't see this cycle.
// totalShares/totalUnderlyingAssets include fTokens staked in the rewards contract;
// plain `shares` would miss them. `underlyingBalance` is the user's WALLET balance
// of the underlying token, not a deposit — never use it for detection.
export async function getFluidSuppliesForWallet(walletAddress) {
  const positions = [];
  const failures = [];
  await Promise.all(
    CHAINS.map(async (chain) => {
      try {
        const entries = await fetchFluidChain(chain, walletAddress);
        for (const p of entries) {
          if (!p || (p.totalShares ?? p.shares) === "0") continue;
          const asset = p.token?.asset;
          if (!asset) continue;
          const amount = Number(p.totalUnderlyingAssets ?? p.underlyingAssets) / 10 ** asset.decimals;
          if (!Number.isFinite(amount) || amount <= 0) continue;
          const price = Number(asset.price);
          // totalRate = supplyRate + in-protocol rewards, APR in percent*100 (586 = 5.86%).
          const rate = Number(p.token.totalRate ?? p.token.supplyRate);
          positions.push({
            id: `fluid:${chain.chainId}:${p.token.address}`,
            platform: "fluid",
            market: `Fluid ${chain.label}`,
            asset: asset.symbol,
            amount,
            amountUsd: Number.isFinite(price) ? amount * price : null,
            supplyApy: Number.isFinite(rate) ? Math.round(rate) / 100 : null
          });
        }
      } catch (error) {
        failures.push(`fluid:${chain.chainId}:`);
        logger.error({ chain: chain.label, walletAddress, error: error.message }, "Fluid scan failed");
      }
    })
  );
  return { positions, failures };
}
