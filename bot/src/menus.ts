// Inline keyboards and threshold-field metadata — callback data identical to
// the monolith bot.js so existing chats keep working mid-migration.

import { Markup } from "telegraf";
import { formatWalletLabel } from "./format.js";
import type { Thresholds } from "./types.js";

export type ThresholdCode = "whf" | "dhf" | "wbr" | "dbr" | "wsr";

export interface ThresholdField {
  key: keyof Thresholds;
  label: string;
  kind: "hf" | "rate";
}

// Maps short callback/command codes to threshold fields.
// kind "hf"   -> alert when value is BELOW the threshold (lower health factor = riskier)
// kind "rate" -> alert when value is ABOVE the threshold (higher borrow rate = costlier)
// warningSupplyRate is a "rate" for formatting, but alerts fire when the deposit
// APY falls BELOW it (lower supply yield = worse).
export const THRESHOLD_FIELDS: Record<ThresholdCode, ThresholdField> = {
  whf: { key: "warningHealthFactor", label: "Warning HF", kind: "hf" },
  dhf: { key: "dangerHealthFactor", label: "Danger HF", kind: "hf" },
  wbr: { key: "warningBorrowRate", label: "Warning Rate", kind: "rate" },
  dbr: { key: "dangerBorrowRate", label: "Danger Rate", kind: "rate" },
  wsr: { key: "warningSupplyRate", label: "Warning Supply APY", kind: "rate" }
};

export function isThresholdCode(value: string): value is ThresholdCode {
  return Object.prototype.hasOwnProperty.call(THRESHOLD_FIELDS, value);
}

export function formatThresholdValue(field: ThresholdField, value: number): string {
  return field.kind === "rate" ? `${value}%` : `${value}`;
}

export function mainMenu() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("Kamino", "menu:protocol:kamino"),
      Markup.button.callback("Aave", "menu:protocol:aave")
    ],
    [
      Markup.button.callback("Check All", "action:check:all"),
      Markup.button.callback("Refresh All", "action:refresh:all")
    ],
    [
      Markup.button.callback("Top LP", "action:toplp"),
      Markup.button.callback("Top LP (L2)", "action:toplpl2")
    ],
    [Markup.button.callback("Wallets", "menu:wallets")],
    [Markup.button.callback("Settings", "menu:settings")]
  ]);
}

export function protocolMenu(protocol: string) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("Check", `action:check:${protocol}`),
      Markup.button.callback("Refresh Markets", `action:refresh:${protocol}`)
    ],
    [Markup.button.callback("Back", "menu:main")]
  ]);
}

export function settingsMenu(d: Thresholds) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback(`Warning HF: ${d.warningHealthFactor}`, "def:set:whf"),
      Markup.button.callback(`Danger HF: ${d.dangerHealthFactor}`, "def:set:dhf")
    ],
    [
      Markup.button.callback(`Warning Rate: ${d.warningBorrowRate}%`, "def:set:wbr"),
      Markup.button.callback(`Danger Rate: ${d.dangerBorrowRate}%`, "def:set:dbr")
    ],
    [Markup.button.callback(`Warning Supply APY: ${d.warningSupplyRate}%`, "def:set:wsr")],
    [Markup.button.callback("Back", "menu:main")]
  ]);
}

export function walletMenu(wallets: string[]) {
  const rows = [];
  for (let i = 0; i < wallets.length; i += 1) {
    const wallet = wallets[i];
    if (!wallet) continue;
    rows.push([
      Markup.button.callback(formatWalletLabel(wallet), `wallet:open:${i}`),
      Markup.button.callback("✖", `wallet:remove:${i}`)
    ]);
  }
  rows.push([Markup.button.callback("Add Wallet", "action:addwallet")]);
  rows.push([Markup.button.callback("Back", "menu:main")]);
  return Markup.inlineKeyboard(rows);
}

export function walletSettingsMenu(t: Thresholds) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback(`Warning HF: ${t.warningHealthFactor}`, "wallet:set:whf"),
      Markup.button.callback(`Danger HF: ${t.dangerHealthFactor}`, "wallet:set:dhf")
    ],
    [
      Markup.button.callback(`Warning Rate: ${t.warningBorrowRate}%`, "wallet:set:wbr"),
      Markup.button.callback(`Danger Rate: ${t.dangerBorrowRate}%`, "wallet:set:dbr")
    ],
    [Markup.button.callback(`Warning Supply APY: ${t.warningSupplyRate}%`, "wallet:set:wsr")],
    [Markup.button.callback("Reset to defaults", "wallet:reset")],
    [Markup.button.callback("Back", "wallet:back")]
  ]);
}
