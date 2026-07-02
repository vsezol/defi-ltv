import { logger } from "./logger.js";

const ORCA_API = "https://api.orca.so/v2/solana";
// Many public RPCs now block getTokenAccountsByOwner with a programId filter
// ("Request blocked"). Set SOLANA_RPC_URL (comma-separated allowed) to a private
// endpoint for best reliability; the keyless defaults below still allow the method.
const ENV_RPCS = (process.env.SOLANA_RPC_URL || "")
  .split(",")
  .map((url) => url.trim())
  .filter(Boolean);
const SOLANA_RPCS = [
  ...ENV_RPCS,
  "https://solana.lava.build",
  "https://rpc.magicblock.app/mainnet",
  "https://api.mainnet-beta.solana.com",
  "https://solana-rpc.publicnode.com"
];
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const MINTS_PER_REQUEST = 40;

const RPC_RETRY_ROUNDS = 2;

async function solanaRpc(method, params) {
  let lastError;
  for (let round = 0; round < RPC_RETRY_ROUNDS; round += 1) {
    if (round > 0) await new Promise((resolve) => setTimeout(resolve, 2000));
    for (const url of SOLANA_RPCS) {
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
          signal: AbortSignal.timeout(30000)
        });
        const data = await response.json();
        if (data.error) throw new Error(`${method}: ${JSON.stringify(data.error)}`);
        return data.result;
      } catch (error) {
        lastError = error;
        logger.warn({ url, method, error: error.message }, "Solana RPC attempt failed");
      }
    }
  }
  throw lastError;
}

// Orca position NFTs: token accounts holding exactly 1 unit of a 0-decimals mint.
async function getWalletNftMints(walletAddress) {
  const mints = [];
  for (const programId of [TOKEN_PROGRAM, TOKEN_2022_PROGRAM]) {
    const result = await solanaRpc("getTokenAccountsByOwner", [
      walletAddress,
      { programId },
      { encoding: "jsonParsed" }
    ]);
    for (const item of result.value || []) {
      const info = item.account?.data?.parsed?.info;
      if (info?.tokenAmount?.amount === "1" && info?.tokenAmount?.decimals === 0) {
        mints.push(info.mint);
      }
    }
  }
  return mints;
}

// The positions endpoint accepts position NFT mint addresses and silently
// ignores mints that are not Orca positions.
async function fetchOrcaPositions(mints) {
  const positions = [];
  const whirlpools = {};
  const tokens = [];
  for (let i = 0; i < mints.length; i += MINTS_PER_REQUEST) {
    const chunk = mints.slice(i, i + MINTS_PER_REQUEST);
    const response = await fetch(`${ORCA_API}/positions?addresses=${chunk.join(",")}`, {
      signal: AbortSignal.timeout(30000)
    });
    if (!response.ok) throw new Error(`Orca API error: ${response.status}`);
    const data = await response.json();
    positions.push(...(data.data?.positions || []));
    Object.assign(whirlpools, data.data?.whirlpools || {});
    tokens.push(...(data.data?.tokens || []));
  }
  return { positions, whirlpools, tokens };
}

export async function getOrcaPositionsForWallet(walletAddress) {
  const mints = await getWalletNftMints(walletAddress);
  if (mints.length === 0) return [];

  const { positions, whirlpools, tokens } = await fetchOrcaPositions(mints);
  if (positions.length === 0) return [];

  const symbolByMint = new Map(tokens.map((t) => [t.address, t.metadata?.symbol]));
  const sym = (mint) => symbolByMint.get(mint) || `${mint.slice(0, 4)}…`;

  return positions
    .filter((p) => p.position?.liquidity && p.position.liquidity !== "0")
    .map((p) => {
      const whirlpool = whirlpools[p.whirlpoolAddress];
      const inRange = typeof whirlpool?.tickCurrentIndex === "number"
        ? whirlpool.tickCurrentIndex >= p.position.tickLowerIndex &&
          whirlpool.tickCurrentIndex < p.position.tickUpperIndex
        : p.meta.currentPrice >= p.meta.lowerPrice && p.meta.currentPrice <= p.meta.upperPrice;
      const feePct = parseFloat((p.meta.feeRate / 10000).toFixed(4));
      // balanceSnapshot is priced in the API's ref asset (USD): totalBalance =
      // deployed liquidity value, totalYield = uncollected fees + rewards.
      const snapshot = p.meta.balanceSnapshot;
      return {
        id: `orca:${p.address}`,
        platform: "orca",
        pool: `${sym(p.tokenA)}/${sym(p.tokenB)} ${feePct}% (Solana)`,
        inRange: p.meta.isFullRange ? true : inRange,
        lowerPrice: p.meta.lowerPrice,
        upperPrice: p.meta.upperPrice,
        currentPrice: p.meta.currentPrice,
        priceLabel: `${sym(p.tokenB)} per ${sym(p.tokenA)}`,
        isFullRange: !!p.meta.isFullRange,
        valueUsd: parseFloat(snapshot?.totalBalance?.balanceInRefAsset),
        pendingFeesUsd: parseFloat(snapshot?.totalYield?.balanceInRefAsset)
      };
    });
}
