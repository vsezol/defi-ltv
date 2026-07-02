async function request(path, options = {}) {
  const initData = window.Telegram?.WebApp?.initData || "";
  let res;
  try {
    res = await fetch(path, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        Authorization: "tma " + initData,
        ...(options.headers || {})
      }
    });
  } catch (err) {
    throw new Error("Network error: " + (err?.message || "request failed"));
  }

  let body = null;
  try {
    body = await res.json();
  } catch {
    // non-JSON response body, ignore
  }

  if (!res.ok) {
    const message =
      (body && (body.error || body.message)) || `Request failed (HTTP ${res.status})`;
    throw new Error(message);
  }
  return body;
}

export const api = {
  getState: () => request("/api/state"),

  getPositions: () => request("/api/positions"),

  addWallets: (addresses) =>
    request("/api/wallets", {
      method: "POST",
      body: JSON.stringify({ addresses })
    }),

  deleteWallet: (address) =>
    request(`/api/wallets/${encodeURIComponent(address)}`, { method: "DELETE" }),

  updateDefault: (field, value) =>
    request("/api/settings", {
      method: "PUT",
      body: JSON.stringify({ field, value })
    }),

  updateWalletThreshold: (address, field, value) =>
    request(`/api/wallets/${encodeURIComponent(address)}/thresholds`, {
      method: "PUT",
      body: JSON.stringify({ field, value })
    }),

  resetWalletThresholds: (address) =>
    request(`/api/wallets/${encodeURIComponent(address)}/thresholds`, {
      method: "DELETE"
    })
};
