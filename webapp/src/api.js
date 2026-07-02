const TOKEN_KEY = "authToken";

// --- auth state ---------------------------------------------------------

const authListeners = new Set();

function notifyAuthChange() {
  const mode = getAuthMode();
  for (const listener of authListeners) listener(mode);
}

/** Subscribe to auth mode changes (token set/cleared, incl. 401s). Returns unsubscribe. */
export function onAuthChange(listener) {
  authListeners.add(listener);
  return () => authListeners.delete(listener);
}

function getTelegramInitData() {
  const initData = window.Telegram?.WebApp?.initData;
  return typeof initData === "string" && initData.length > 0 ? initData : null;
}

function getToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) || null;
  } catch {
    return null;
  }
}

export function setToken(token) {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // storage unavailable (private mode etc.) — auth won't persist, but continue
  }
  notifyAuthChange();
}

export function clearToken() {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    // ignore
  }
  notifyAuthChange();
}

/** 'telegram' (Mini App initData) | 'token' (Bearer JWT) | 'none' (unauthenticated) */
export function getAuthMode() {
  if (getTelegramInitData()) return "telegram";
  if (getToken()) return "token";
  return "none";
}

export class UnauthorizedError extends Error {
  constructor(message) {
    super(message || "Unauthorized");
    this.name = "UnauthorizedError";
    this.unauthorized = true;
  }
}

function authHeader() {
  const initData = getTelegramInitData();
  if (initData) return { Authorization: "tma " + initData };
  const token = getToken();
  if (token) return { Authorization: "Bearer " + token };
  return {};
}

// --- requests -----------------------------------------------------------

async function doFetch(path, options, extraHeaders) {
  let res;
  try {
    res = await fetch(path, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...extraHeaders,
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
  return { res, body };
}

function errorMessage(res, body) {
  return (body && (body.error || body.message)) || `Request failed (HTTP ${res.status})`;
}

/** Authenticated request. On 401: clears the token, notifies the app, throws UnauthorizedError. */
async function request(path, options = {}) {
  const { res, body } = await doFetch(path, options, authHeader());

  if (res.status === 401) {
    // Session invalid/expired — drop the token so the app returns to the login screen.
    clearToken();
    throw new UnauthorizedError(errorMessage(res, body));
  }
  if (!res.ok) {
    throw new Error(errorMessage(res, body));
  }
  return body;
}

/** Public (unauthenticated) request — no auth header, 401 does NOT clear the token. */
async function publicRequest(path, options = {}) {
  const { res, body } = await doFetch(path, options, {});
  if (!res.ok) {
    throw new Error(errorMessage(res, body));
  }
  return body;
}

export const api = {
  // public endpoints
  getConfig: () => publicRequest("/api/config"),

  loginWithWidget: (user) =>
    publicRequest("/api/auth/telegram-widget", {
      method: "POST",
      body: JSON.stringify(user)
    }),

  // authenticated endpoints
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
