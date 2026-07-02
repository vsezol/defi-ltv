// Message formatters ported 1:1 from the monolith's bot.js. Pure functions —
// everything they render comes from the core API payloads.

import type {
  LendingPosition,
  LpCandidate,
  PoolPosition,
  SupplyPosition,
  Thresholds,
  TopLpResponse,
  TronResources
} from "./types.js";

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function fmtUsdExact(n: number | null | undefined): string {
  if (!isFiniteNumber(n)) return "?";
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function fmtUsd(n: number | null | undefined): string {
  if (!isFiniteNumber(n)) return "?";
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${Math.round(n)}`;
}

export function fmtNum(n: number | null | undefined): string {
  if (!isFiniteNumber(n)) return "?";
  return Math.round(n).toLocaleString("en-US");
}

export function fmtTrx(n: number | null | undefined): string {
  if (!isFiniteNumber(n)) return "?";
  return (Math.round(n * 100) / 100).toLocaleString("en-US");
}

export function formatWalletLabel(wallet: string): string {
  if (wallet.length <= 12) return wallet;
  return `${wallet.slice(0, 6)}...${wallet.slice(-4)}`;
}

export function formatBorrowRates(position: LendingPosition): string {
  const borrows = Array.isArray(position.borrows)
    ? position.borrows.filter((b) => b && Number.isFinite(Number(b.rate)))
    : [];

  if (borrows.length === 0) {
    return position.borrowRate == null ? "Borrow Rate: n/a" : `Borrow Rate: ${position.borrowRate}%`;
  }

  const lines = borrows.map((b) => `  ${b.token}: ${b.rate}%`);
  return `Borrow Rate:\n${lines.join("\n")}`;
}

// Severity (0 = ok, 1 = warning, 2 = danger) comes from the core API — the bot
// does NOT compute it, it only picks the emoji.
export function formatPosition(position: LendingPosition): string {
  const level = position.severity ?? 0;
  const prefix = level === 2 ? "☠️ " : level === 1 ? "⚠️ " : "✅ ";
  return `${prefix}${position.market}:\nLTV: ${position.ltv}%\nLiquidation LTV: ${position.liquidationLtv}%\nHealth Factor: ${position.healthFactor}\n${formatBorrowRates(position)}`;
}

export function isSupplyBelow(position: SupplyPosition, threshold: number): boolean {
  return isFiniteNumber(position.supplyApy) && position.supplyApy < threshold;
}

export function formatSupplyPosition(position: SupplyPosition, threshold: number, transition = false): string {
  const below = isSupplyBelow(position, threshold);
  const prefix = below ? "🔻 " : "💰 ";
  const apy = isFiniteNumber(position.supplyApy) ? `${position.supplyApy}%` : "?";
  let line = `Deposited: ${fmtUsdExact(position.amountUsd)} · APY ${apy}`;
  if (transition) {
    line += below ? ` (dropped below ${threshold}%)` : ` (recovered above ${threshold}%)`;
  }
  return `${prefix}${position.asset} — ${position.market}:\n${line}`;
}

export function formatPoolPrice(value: number | undefined): string {
  if (!isFiniteNumber(value)) return "?";
  if (value >= 1) return value.toFixed(2);
  return value.toPrecision(4);
}

// Normalized position of the current price inside the range:
// 0..1 in range (0 = lower bound, 1 = upper bound), <0 below, >1 above (shown as +X).
export function formatRangeCoord(position: PoolPosition): string {
  const lower = position.lowerPrice ?? NaN;
  const upper = position.upperPrice ?? NaN;
  const current = position.currentPrice ?? NaN;
  const span = upper - lower;
  if (!Number.isFinite(span) || span <= 0) return "";
  const coord = (current - lower) / span;
  if (!Number.isFinite(coord)) return "";
  return ` ${coord > 1 ? "+" : ""}${coord.toFixed(2)}`;
}

export function formatPoolPosition(position: PoolPosition, transition = false): string {
  const prefix = position.inRange ? "✅ " : "🔴 ";
  let status = position.inRange ? "IN RANGE" : "OUT OF RANGE";
  if (!position.isFullRange) {
    status += formatRangeCoord(position);
  }
  if (transition) {
    status += position.inRange ? " (was out of range)" : " (was in range)";
  }
  const range = position.isFullRange
    ? "Full range"
    : `Range: ${formatPoolPrice(position.lowerPrice)} — ${formatPoolPrice(position.upperPrice)} ${position.priceLabel}`;
  const money =
    isFiniteNumber(position.valueUsd) || isFiniteNumber(position.pendingFeesUsd)
      ? `\nDeposited: ${fmtUsdExact(position.valueUsd)} · Fees: ${fmtUsdExact(position.pendingFeesUsd)}`
      : "";
  return `${prefix}${position.pool}:\nStatus: ${status}\n${range}${money}`;
}

// Reclaim status of the wallet's outgoing delegations. Mirrors tron.js
// tronReclaimInfo in the core: a delegation can be reclaimed once its lock
// expires (expireAt <= now); expireAt of 0 means no lock (reclaimable anytime).
export function tronReclaimInfo(
  res: TronResources,
  now: number
): { reclaimableNow: boolean; nextReclaimAt: number | null } {
  let reclaimableNow = false;
  let nextReclaimAt: number | null = null;
  for (const d of res.delegations) {
    if (!d.expireAt || d.expireAt <= now) {
      reclaimableNow = true;
    } else if (nextReclaimAt == null || d.expireAt < nextReclaimAt) {
      nextReclaimAt = d.expireAt;
    }
  }
  return { reclaimableNow, nextReclaimAt };
}

export function formatTronResources(res: TronResources, now: number = Date.now()): string {
  const lines = [
    `⚡ Energy: ${fmtNum(res.energyFree)} / ${fmtNum(res.energyTotal)} free`,
    `📶 Bandwidth: ${fmtNum(res.bandwidthFree)} / ${fmtNum(res.bandwidthTotal)} free`
  ];

  if (res.hasDelegation) {
    const parts: string[] = [];
    if (res.delegatedEnergy > 0) {
      parts.push(`${fmtNum(res.delegatedEnergy)} energy (${fmtTrx(res.delegatedEnergyTrx)} TRX)`);
    }
    if (res.delegatedBandwidth > 0) {
      parts.push(`${fmtNum(res.delegatedBandwidth)} bandwidth (${fmtTrx(res.delegatedBandwidthTrx)} TRX)`);
    }
    lines.push(`Delegated out: ${parts.join(", ") || "yes"}`);

    const { reclaimableNow, nextReclaimAt } = tronReclaimInfo(res, now);
    if (reclaimableNow) {
      lines.push("Reclaimable: now ✅");
    } else if (nextReclaimAt) {
      const days = Math.ceil((nextReclaimAt - now) / 86400000);
      lines.push(
        `Reclaimable: ${new Date(nextReclaimAt).toISOString().slice(0, 10)} (in ${days} day${days === 1 ? "" : "s"})`
      );
    }
  } else {
    lines.push("Delegated out: none");
  }

  return lines.join("\n");
}

export function formatLpPool(c: LpCandidate, i: number): string {
  const name = c.url ? `[${c.symbol}](${c.url})` : c.symbol;
  const scoreVal = c.score >= 0 ? c.score.toFixed(2) : "?";
  return (
    `${i + 1}. ${name}  ${c.feeLabel} ${c.version} · ${c.chain}\n` +
    `score *${scoreVal}* · 30d ${fmtUsd(c.vol30d)} · TVL ${fmtUsd(c.tvl)}`
  );
}

export function formatLpList(pools: LpCandidate[]): string {
  return pools.length ? pools.map((c, i) => formatLpPool(c, i)).join("\n\n") : "none";
}

// Three messages (chains, BTC, ETH) — keeps each under Telegram's size limit
// and reads better on mobile.
export function formatTopLpMessages(result: TopLpResponse, title: string): string[] {
  const chainsList = result.chains.map((c, i) => `${i + 1}. ${c.name} — ${fmtUsd(c.tvl)}`).join("\n");
  return [
    `*${title} — score = 30d vol / TVL × fee%*\n\nTop chains by TVL:\n${chainsList}`,
    `*BTC / stablecoin*\n\n${formatLpList(result.btc)}`,
    `*ETH / stablecoin*\n\n${formatLpList(result.eth)}`
  ];
}

export function formatWalletSettings(wallet: string, effective: Thresholds, overrides: Partial<Thresholds>): string {
  const mark = (key: keyof Thresholds): string => (overrides[key] != null ? "" : " (default)");
  return [
    "Wallet settings",
    `\`${wallet}\``,
    "",
    `Warning HF: ${effective.warningHealthFactor}${mark("warningHealthFactor")}`,
    `Danger HF: ${effective.dangerHealthFactor}${mark("dangerHealthFactor")}`,
    `Warning Rate: ${effective.warningBorrowRate}%${mark("warningBorrowRate")}`,
    `Danger Rate: ${effective.dangerBorrowRate}%${mark("dangerBorrowRate")}`,
    `Warning Supply APY: ${effective.warningSupplyRate}%${mark("warningSupplyRate")}`
  ].join("\n");
}

export const PLATFORM_LABELS: Record<string, string> = {
  kamino: "*KAMINO*",
  aave: "*AAVE*",
  fluid: "*FLUID*",
  orca: "*ORCA*",
  uniswap: "*UNISWAP*",
  tron: "*TRON*"
};

export type WalletBuckets = Record<string, string[]>;

export function formatResultsByWallet(resultsByWallet: Map<string, WalletBuckets>): string {
  const output: string[] = [];
  const protocolsOrder = ["kamino", "aave", "fluid", "orca", "uniswap", "tron"];
  for (const [wallet, protocols] of resultsByWallet.entries()) {
    const protocolKeys = Object.keys(protocols);
    if (protocolKeys.length === 0) continue;
    output.push(`\`${wallet}\``);
    protocolKeys.sort((a, b) => {
      const aIdx = protocolsOrder.indexOf(a);
      const bIdx = protocolsOrder.indexOf(b);
      if (aIdx === -1 && bIdx === -1) return a.localeCompare(b);
      if (aIdx === -1) return 1;
      if (bIdx === -1) return -1;
      return aIdx - bIdx;
    });
    for (const protocol of protocolKeys) {
      const lines = protocols[protocol];
      if (!lines) continue;
      output.push(PLATFORM_LABELS[protocol] ?? `*${protocol.toUpperCase()}*`);
      output.push(lines.join("\n"));
    }
  }
  return output.join("\n\n");
}
