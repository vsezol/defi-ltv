// Transient per-chat UI state (pending input, wallet menu index snapshot,
// currently opened wallet). Held in an in-memory Map — losing it on restart
// only forgets an unfinished menu flow, nothing durable.

import type { Context } from "telegraf";
import type { ThresholdCode } from "./menus.js";

export type PendingInput =
  | { action: "addwallet" }
  | { action: "setdefault"; field: ThresholdCode }
  | { action: "setwallet"; field: ThresholdCode; wallet: string };

export interface SessionData {
  pending?: PendingInput | null;
  /** Wallet addresses snapshot backing the numbered wallet-menu buttons. */
  walletMenu?: string[];
  /** Wallet whose settings menu is currently open. */
  currentWallet?: string;
}

export interface BotContext extends Context {
  session: SessionData;
}

// Telegraf's SessionStore<T> is structurally satisfied by Map (default session
// key is `${fromId}:${chatId}`, i.e. per chat in private conversations).
export function createSessionStore(): Map<string, SessionData> {
  return new Map<string, SessionData>();
}
