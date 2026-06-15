import { logger } from "./logger.js";

const TRON_APIS = ["https://api.trongrid.io", "https://tron-mainnet.gateway.tatum.io"];
const RPC_RETRY_ROUNDS = 3;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function tronPost(path, body) {
  let lastError;
  for (let round = 0; round < RPC_RETRY_ROUNDS; round += 1) {
    if (round > 0) await sleep(2000 * round);
    for (const base of TRON_APIS) {
      try {
        const response = await fetch(`${base}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...body, visible: true }),
          signal: AbortSignal.timeout(20000)
        });
        if (!response.ok) throw new Error(`Tron API ${response.status}`);
        return await response.json();
      } catch (error) {
        lastError = error;
        logger.warn({ base, path, error: error.message }, "Tron API attempt failed");
      }
    }
  }
  throw lastError;
}

// Reclaim status of the wallet's outgoing delegations.
// A delegation can be reclaimed once its lock expires (expireAt <= now);
// expireAt of 0 means it was delegated without a lock (reclaimable anytime).
export function tronReclaimInfo(res, now) {
  let reclaimableNow = false;
  let nextReclaimAt = null;
  for (const d of res.delegations || []) {
    if (!d.expireAt || d.expireAt <= now) {
      reclaimableNow = true;
    } else if (nextReclaimAt == null || d.expireAt < nextReclaimAt) {
      nextReclaimAt = d.expireAt;
    }
  }
  return { reclaimableNow, nextReclaimAt };
}

// Actionable flags for notifications:
// - reclaim:  a delegation is unlocked AND there's enough bandwidth to send the reclaim tx
// - delegate: free energy + full bandwidth + nothing currently delegated
export function computeTronFlags(res, now = Date.now()) {
  const { reclaimableNow } = tronReclaimInfo(res, now);
  return {
    reclaim: reclaimableNow && res.bandwidthFree > 500,
    delegate: res.energyFree > 0 && res.bandwidthFree > 500 && !res.hasDelegation
  };
}

export async function getTronResources(address) {
  // Sequential (with small gaps) to stay under TronGrid's free-tier rate limit.
  const account = await tronPost("/wallet/getaccount", { address });
  await sleep(300);
  const resource = await tronPost("/wallet/getaccountresource", { address });
  await sleep(300);
  const index = await tronPost("/wallet/getdelegatedresourceaccountindexv2", { value: address });

  const energyTotal = resource.EnergyLimit || 0;
  const energyUsed = resource.EnergyUsed || 0;
  const energyFree = Math.max(0, energyTotal - energyUsed);

  const freeNetLimit = resource.freeNetLimit || 0;
  const freeNetUsed = resource.freeNetUsed || 0;
  const netLimit = resource.NetLimit || 0;
  const netUsed = resource.NetUsed || 0;
  const bandwidthTotal = freeNetLimit + netLimit;
  const bandwidthFree = Math.max(0, freeNetLimit - freeNetUsed) + Math.max(0, netLimit - netUsed);

  const energyPerTrx = resource.TotalEnergyWeight
    ? resource.TotalEnergyLimit / resource.TotalEnergyWeight
    : 0;
  const bandwidthPerTrx = resource.TotalNetWeight
    ? resource.TotalNetLimit / resource.TotalNetWeight
    : 0;

  const accountResource = account.account_resource || {};
  const delegatedEnergySun =
    accountResource.delegated_frozenV2_balance_for_energy ||
    account.delegated_frozenV2_balance_for_energy ||
    0;
  const delegatedBandwidthSun =
    account.delegated_frozenV2_balance_for_bandwidth ||
    accountResource.delegated_frozenV2_balance_for_bandwidth ||
    0;

  const delegatedEnergyTrx = delegatedEnergySun / 1e6;
  const delegatedBandwidthTrx = delegatedBandwidthSun / 1e6;

  const delegations = [];
  for (const to of index.toAccounts || []) {
    await sleep(300);
    const dr = await tronPost("/wallet/getdelegatedresourcev2", {
      fromAddress: address,
      toAddress: to
    });
    for (const d of dr.delegatedResource || []) {
      if (d.frozen_balance_for_energy) {
        delegations.push({ type: "energy", expireAt: d.expire_time_for_energy || 0 });
      }
      if (d.frozen_balance_for_bandwidth) {
        delegations.push({ type: "bandwidth", expireAt: d.expire_time_for_bandwidth || 0 });
      }
    }
  }

  const hasDelegation =
    delegatedEnergySun > 0 || delegatedBandwidthSun > 0 || delegations.length > 0;

  return {
    energyFree,
    energyTotal,
    bandwidthFree,
    bandwidthTotal,
    delegatedEnergy: Math.round(delegatedEnergyTrx * energyPerTrx),
    delegatedEnergyTrx,
    delegatedBandwidth: Math.round(delegatedBandwidthTrx * bandwidthPerTrx),
    delegatedBandwidthTrx,
    delegations,
    hasDelegation
  };
}
