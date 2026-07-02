// HTTP client for the core (monolith) API. Every request carries the shared
// internal token and the acting Telegram chat id.

import type {
  AddWalletsResponse,
  OkResponse,
  PositionsResponse,
  RefreshResponse,
  SettingsResponse,
  StateResponse,
  Thresholds,
  TopLpResponse
} from "./types.js";

export type ThresholdKey = keyof Thresholds;

// Position scans / market rescans walk chains and can take a while.
const SLOW_TIMEOUT_MS = 120_000;
const FAST_TIMEOUT_MS = 30_000;

interface RequestOptions {
  body?: unknown;
  slow?: boolean;
}

async function extractErrorMessage(response: Response): Promise<string> {
  let message = `HTTP ${response.status}`;
  try {
    const data: unknown = await response.json();
    if (data !== null && typeof data === "object" && "error" in data) {
      const err = (data as { error: unknown }).error;
      if (typeof err === "string" && err.length > 0) message = err;
    }
  } catch {
    // non-JSON error body — keep the status fallback
  }
  return message;
}

export class CoreApi {
  private readonly baseUrl: string;
  private readonly token: string;

  constructor(baseUrl: string, token: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.token = token;
  }

  private async request<T>(chatId: string, method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Internal ${this.token}`,
      "X-Chat-Id": chatId
    };
    let body: string | undefined;
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(options.body);
    }
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(options.slow ? SLOW_TIMEOUT_MS : FAST_TIMEOUT_MS)
    });
    if (!response.ok) {
      throw new Error(await extractErrorMessage(response));
    }
    return (await response.json()) as T;
  }

  getState(chatId: string): Promise<StateResponse> {
    return this.request<StateResponse>(chatId, "GET", "/api/state");
  }

  /** SLOW: the core scans chains for every address in the list. */
  addWallets(chatId: string, addresses: string): Promise<AddWalletsResponse> {
    return this.request<AddWalletsResponse>(chatId, "POST", "/api/wallets", {
      body: { addresses },
      slow: true
    });
  }

  deleteWallet(chatId: string, address: string): Promise<OkResponse> {
    return this.request<OkResponse>(chatId, "DELETE", `/api/wallets/${encodeURIComponent(address)}`);
  }

  setGlobalThreshold(chatId: string, field: ThresholdKey, value: number): Promise<SettingsResponse> {
    return this.request<SettingsResponse>(chatId, "PUT", "/api/settings", { body: { field, value } });
  }

  setWalletThreshold(chatId: string, address: string, field: ThresholdKey, value: number): Promise<OkResponse> {
    return this.request<OkResponse>(chatId, "PUT", `/api/wallets/${encodeURIComponent(address)}/thresholds`, {
      body: { field, value }
    });
  }

  resetWalletThresholds(chatId: string, address: string): Promise<OkResponse> {
    return this.request<OkResponse>(chatId, "DELETE", `/api/wallets/${encodeURIComponent(address)}/thresholds`);
  }

  /** SLOW: scans lending + supplies + pools + Tron for every wallet. */
  getPositions(chatId: string, protocol: string): Promise<PositionsResponse> {
    return this.request<PositionsResponse>(chatId, "GET", `/api/positions?protocol=${encodeURIComponent(protocol)}`, {
      slow: true
    });
  }

  /** SLOW: rescans lending markets for every wallet. Omit protocol to refresh all. */
  refresh(chatId: string, protocol?: string): Promise<RefreshResponse> {
    return this.request<RefreshResponse>(chatId, "POST", "/api/refresh", {
      body: protocol ? { protocol } : {},
      slow: true
    });
  }

  getTopLp(chatId: string, l2: boolean): Promise<TopLpResponse> {
    return this.request<TopLpResponse>(chatId, "GET", l2 ? "/api/toplp?l2=1" : "/api/toplp");
  }
}
