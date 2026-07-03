import { useEffect, useState } from "react";
import {
  Badge,
  Button,
  Cell,
  Info,
  List,
  Placeholder,
  Section,
  Skeleton
} from "@telegram-apps/telegram-ui";
import { api } from "../api.js";
import { formatNumber, formatPercent, shortAddress } from "../format.js";

// Module-level cache: survives tab switches (component unmounts) without refetching.
let cachedData = null;

function formatPrice(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return num.toLocaleString("en-US", { maximumFractionDigits: 6 });
}

function formatDate(value) {
  if (value == null) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function borrowRatesText(position) {
  const rates = position?.borrows;
  if (rates == null) return null;
  let parts;
  if (Array.isArray(rates)) {
    parts = rates.map((entry) => {
      if (entry && typeof entry === "object") {
        const token = entry.token || entry.asset || "";
        const rate = formatPercent(entry.rate);
        return [token, rate].filter(Boolean).join(" ");
      }
      return formatPercent(entry);
    });
  } else if (typeof rates === "object") {
    parts = Object.entries(rates).map(([token, rate]) =>
      [token, formatPercent(rate) ?? String(rate)].filter(Boolean).join(" ")
    );
  } else {
    parts = [String(rates)];
  }
  parts = parts.filter(Boolean);
  return parts.length ? `Borrows: ${parts.join(" · ")}` : null;
}

// Map a lending position severity to a text color CSS variable.
// The API sends a numeric level from positionSeverity: 0 = ok, 1 = warning, 2 = danger.
function severityColor(severity) {
  if (severity >= 2) return "var(--tgui--destructive_text_color)";
  if (severity >= 1) return "var(--tgui--orange, #f5a623)";
  return undefined;
}

function RangeBadge({ inRange }) {
  return inRange ? (
    <Badge type="number" mode="primary" style={{ background: "var(--tgui--green)" }}>
      In range
    </Badge>
  ) : (
    <Badge type="number" mode="critical">
      Out of range
    </Badge>
  );
}

function LendingCell({ position }) {
  const parts = [];
  const ltv = formatPercent(position.ltv);
  if (ltv) parts.push(`LTV ${ltv}`);
  const liqLtv = formatPercent(position.liquidationLtv);
  if (liqLtv) parts.push(`Liq ${liqLtv}`);
  const borrowRate = formatPercent(position.borrowRate);
  if (borrowRate) parts.push(`Borrow ${borrowRate}`);
  const detail = borrowRatesText(position);
  const hf = Number(position.healthFactor);
  const color = severityColor(position.severity);

  return (
    <Cell
      style={color ? { color } : undefined}
      subhead={position.platform || undefined}
      subtitle={parts.join(" · ") || undefined}
      description={detail || undefined}
      after={
        Number.isFinite(hf) ? (
          <Info type="text" subtitle="HF">
            {hf}
          </Info>
        ) : undefined
      }
    >
      {position.market || position.platform || "Lending"}
    </Cell>
  );
}

function PoolCell({ pool }) {
  let range = null;
  if (pool.isFullRange) {
    range = "Full range";
  } else {
    const lower = formatPrice(pool.lowerPrice);
    const upper = formatPrice(pool.upperPrice);
    const current = formatPrice(pool.currentPrice);
    const parts = [];
    if (lower && upper) parts.push(`${lower} – ${upper}`);
    if (current) parts.push(`now ${current}`);
    range = parts.join(" · ") || null;
    if (range && pool.priceLabel) range += ` ${pool.priceLabel}`;
  }

  return (
    <Cell
      subhead={pool.platform || undefined}
      subtitle={range || undefined}
      after={pool.inRange != null ? <RangeBadge inRange={!!pool.inRange} /> : undefined}
    >
      {pool.pool || pool.platform || "Pool"}
    </Cell>
  );
}

function TronCells({ tron }) {
  const pair = (free, total) =>
    `${formatNumber(free) ?? "—"} / ${formatNumber(total) ?? "—"}`;
  const delegated = [];
  if (Number(tron.delegatedEnergy) > 0) {
    delegated.push(`Energy ${formatNumber(tron.delegatedEnergy)}`);
  }
  if (Number(tron.delegatedBandwidth) > 0) {
    delegated.push(`Bandwidth ${formatNumber(tron.delegatedBandwidth)}`);
  }
  return (
    <>
      <Cell subhead="Tron" after={<Info type="text">{pair(tron.energyFree, tron.energyTotal)}</Info>}>
        Energy
      </Cell>
      <Cell after={<Info type="text">{pair(tron.bandwidthFree, tron.bandwidthTotal)}</Info>}>
        Bandwidth
      </Cell>
      {delegated.length > 0 && <Cell subtitle={delegated.join(" · ")}>Delegated</Cell>}
      {tron.reclaimAt != null && (
        <Cell after={<Info type="text">{formatDate(tron.reclaimAt)}</Info>}>Reclaim</Cell>
      )}
    </>
  );
}

function WalletSection({ wallet }) {
  const lending = wallet.lending || [];
  const pools = wallet.pools || [];
  const errors = wallet.errors || [];
  const tron = wallet.tron || null;
  const isEmpty =
    lending.length === 0 && pools.length === 0 && !tron && errors.length === 0;

  const header = [shortAddress(wallet.address), wallet.protocol].filter(Boolean).join(" · ");

  return (
    <Section header={header}>
      {lending.map((position, i) => (
        <LendingCell key={`lending-${i}`} position={position} />
      ))}
      {pools.map((pool, i) => (
        <PoolCell key={`pool-${i}`} pool={pool} />
      ))}
      {tron && <TronCells tron={tron} />}
      {errors.map((err, i) => (
        <Cell
          key={`error-${i}`}
          style={{ color: "var(--tgui--destructive_text_color)" }}
          subtitle={String(err)}
        >
          Error
        </Cell>
      ))}
      {isEmpty && <Cell subtitle="No positions found">Empty</Cell>}
    </Section>
  );
}

function PositionsSkeleton() {
  const placeholderCell = (key) => (
    <Cell
      key={key}
      subtitle="Loading…"
      after={<Info type="text">—</Info>}
    >
      ●●●●●●
    </Cell>
  );
  return (
    <Skeleton visible>
      <List>
        <Section header="Scanning chains…">
          {[0, 1, 2].map((i) => placeholderCell(`s0-${i}`))}
        </Section>
        <Section header="Scanning chains…">
          {[0, 1].map((i) => placeholderCell(`s1-${i}`))}
        </Section>
      </List>
    </Skeleton>
  );
}

export default function Positions() {
  const [data, setData] = useState(cachedData);
  const [loading, setLoading] = useState(!cachedData);
  const [error, setError] = useState(null);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const result = await api.getPositions();
      cachedData = result;
      setData(result);
    } catch (err) {
      setError(err?.message || "Failed to load positions");
    } finally {
      setLoading(false);
    }
  }

  // Auto-load on first entry (no cached data yet). Switching tabs keeps the
  // module-level cache, so this only fetches once per app session.
  useEffect(() => {
    if (!cachedData) {
      refresh();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Show the skeleton on the very first scan (no data to display yet).
  if (loading && !data) {
    return <PositionsSkeleton />;
  }

  if (error && !data) {
    return (
      <Placeholder
        header="Failed to load positions"
        description={error}
        action={
          <Button size="m" onClick={refresh}>
            Try again
          </Button>
        }
      />
    );
  }

  const wallets = data?.wallets || [];

  return (
    <List>
      <div style={{ padding: "12px 20px 0" }}>
        <Button size="m" mode="bezeled" stretched loading={loading} onClick={refresh}>
          {loading ? "Scanning chains…" : "Refresh"}
        </Button>
      </div>
      {error && (
        <Section>
          <Cell style={{ color: "var(--tgui--destructive_text_color)" }} subtitle={error}>
            Refresh failed
          </Cell>
        </Section>
      )}
      {wallets.length === 0 && (
        <Section>
          <Cell subtitle="Add wallets on the Wallets tab to start monitoring">No wallets yet</Cell>
        </Section>
      )}
      {wallets.map((wallet, i) => (
        <WalletSection key={wallet.address || i} wallet={wallet} />
      ))}
    </List>
  );
}
