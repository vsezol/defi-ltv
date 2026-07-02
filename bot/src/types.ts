// Shared data shapes of the core (monolith) API. The bot never computes these —
// it only renders what the core returns.

export interface Thresholds {
  warningHealthFactor: number;
  dangerHealthFactor: number;
  warningBorrowRate: number;
  dangerBorrowRate: number;
  warningSupplyRate: number;
}

export interface LendingBorrow {
  token: string;
  rate: number;
}

export interface LendingPosition {
  market: string;
  ltv?: string;
  liquidationLtv?: string;
  healthFactor?: number;
  borrows?: LendingBorrow[];
  borrowRate?: number | null;
  /** 0 = ok, 1 = warning, 2 = danger. Computed by the core against the wallet's effective thresholds. */
  severity?: 0 | 1 | 2;
  platform?: string;
}

export interface SupplyPosition {
  id: string;
  platform: string;
  market: string;
  asset: string;
  amount?: number | null;
  amountUsd?: number | null;
  supplyApy?: number | null;
  below?: boolean;
}

export interface PoolPosition {
  id: string;
  platform: string;
  pool: string;
  inRange: boolean;
  lowerPrice?: number;
  upperPrice?: number;
  currentPrice?: number;
  priceLabel?: string;
  isFullRange?: boolean;
  valueUsd?: number;
  pendingFeesUsd?: number;
}

export interface TronDelegation {
  type: string; // "energy" | "bandwidth"
  /** ms epoch of the delegation lock expiry; 0 = no lock (reclaimable anytime). */
  expireAt: number;
}

export interface TronResources {
  energyFree: number;
  energyTotal: number;
  bandwidthFree: number;
  bandwidthTotal: number;
  delegatedEnergy: number;
  delegatedEnergyTrx: number;
  delegatedBandwidth: number;
  delegatedBandwidthTrx: number;
  delegations: TronDelegation[];
  hasDelegation: boolean;
}

export interface LpCandidate {
  chain: string;
  version: string;
  feeLabel: string;
  tvl: number;
  vol30d: number;
  symbol: string;
  category: string;
  score: number;
  url: string | null;
}

// ---- Core API request/response shapes ----

export interface WalletState {
  address: string;
  protocol: string;
  thresholds: Partial<Thresholds>;
  effective: Thresholds;
}

export interface StateResponse {
  defaults: Thresholds;
  wallets: WalletState[];
}

export interface AddedWallet {
  address: string;
  protocol: string;
  positions: LendingPosition[];
  supplies: SupplyPosition[];
  pools: PoolPosition[];
  tron: TronResources | null;
}

export interface SkippedWallet {
  address: string;
  reason: string;
}

export interface AddWalletsResponse {
  added: AddedWallet[];
  skipped: SkippedWallet[];
}

export interface OkResponse {
  ok: boolean;
}

export interface SettingsResponse {
  ok: boolean;
  defaults: Thresholds;
}

export interface PositionsWallet {
  address: string;
  protocol: string;
  lending: LendingPosition[];
  supplies: SupplyPosition[];
  pools: PoolPosition[];
  tron: TronResources | null;
  errors: string[];
  thresholds?: Thresholds;
}

export interface PositionsTotals {
  supplyUsd: number;
  lpValueUsd: number;
  lpFeesUsd: number;
}

export interface PositionsResponse {
  wallets: PositionsWallet[];
  totals: PositionsTotals;
}

export interface RefreshWallet {
  address: string;
  protocol: string;
  positions: LendingPosition[];
  /** Set when the rescan for this wallet failed (positions will be empty). */
  error?: string;
}

export interface RefreshResponse {
  wallets: RefreshWallet[];
}

export interface TopLpChain {
  name: string;
  tvl: number;
}

export interface TopLpResponse {
  chains: TopLpChain[];
  btc: LpCandidate[];
  eth: LpCandidate[];
}

// ---- Push notifications (core -> bot, POST /notify) ----

export type NotifyEvent =
  | { type: "lending-alert"; wallet: string; protocol: string; positions: LendingPosition[] }
  | { type: "supply-transition"; wallet: string; threshold: number; transitions: SupplyPosition[] }
  | { type: "pool-transition"; wallet: string; transitions: PoolPosition[] }
  | { type: "tron-transition"; wallet: string; notes: string[]; resources: TronResources };

export interface NotifyRequest {
  chatId: string;
  event: NotifyEvent;
}
