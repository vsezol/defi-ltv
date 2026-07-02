export function shortAddress(address) {
  if (!address || typeof address !== "string") return "?";
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function formatUsd(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return (
    "$" +
    num.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    })
  );
}

export function formatPercent(value, digits = 2) {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return `${num.toFixed(digits)}%`;
}

export function formatNumber(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return num.toLocaleString("en-US");
}
