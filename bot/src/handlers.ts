// Telegram command / callback / text handlers. Thin UI layer: every action is
// forwarded to the core API and the response is rendered with the formatters.

import type { Telegraf } from "telegraf";
import { message } from "telegraf/filters";
import type { CoreApi } from "./api.js";
import {
  fmtUsdExact,
  formatPoolPosition,
  formatPosition,
  formatResultsByWallet,
  formatSupplyPosition,
  formatTopLpMessages,
  formatTronResources,
  formatWalletLabel,
  formatWalletSettings,
  type WalletBuckets
} from "./format.js";
import {
  formatThresholdValue,
  isThresholdCode,
  mainMenu,
  protocolMenu,
  settingsMenu,
  THRESHOLD_FIELDS,
  walletMenu,
  walletSettingsMenu
} from "./menus.js";
import type { BotContext } from "./session.js";
import type { AddedWallet, PositionsResponse, RefreshResponse, StateResponse } from "./types.js";

// Mirrors the core's code-level fallback; only used if a wallet entry is
// somehow missing its effective thresholds in an API response.
const FALLBACK_WARNING_SUPPLY_RATE = 3;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function deleteMessage(ctx: BotContext, messageId: number): Promise<void> {
  try {
    await ctx.deleteMessage(messageId);
  } catch {
    // ignore if message already deleted
  }
}

// ---- Wallet address detection (pure string logic, duplicated from core so the
// bot can stay silent on non-address chat messages and pick status texts) ----

function isEvmAddress(address: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58Decode(str: string): number[] | null {
  if (!str || /[^123456789A-HJ-NP-Za-km-z]/.test(str)) return null;
  let num = 0n;
  for (const ch of str) {
    num = num * 58n + BigInt(BASE58_ALPHABET.indexOf(ch));
  }
  const bytes: number[] = [];
  while (num > 0n) {
    bytes.unshift(Number(num & 0xffn));
    num >>= 8n;
  }
  for (const ch of str) {
    if (ch === "1") bytes.unshift(0);
    else break;
  }
  return bytes;
}

// Tron decodes to 25 bytes (0x41 prefix + checksum); Solana pubkeys to 32 bytes.
export function detectWalletType(address: string): "evm" | "tron" | "solana" | "unknown" {
  if (isEvmAddress(address)) return "evm";
  const bytes = base58Decode(address);
  if (bytes) {
    if (bytes.length === 25 && bytes[0] === 0x41) return "tron";
    if (bytes.length === 32) return "solana";
  }
  return "unknown";
}

// ---- Rendering of core API responses (layouts identical to bot.js) ----

function pushBucketLine(buckets: WalletBuckets, key: string, line: string): void {
  (buckets[key] ??= []).push(line);
}

function renderPositionsMessage(result: PositionsResponse): string {
  const grouped = new Map<string, WalletBuckets>();
  let supplyCount = 0;
  let lpCount = 0;

  for (const w of result.wallets) {
    const buckets: WalletBuckets = {};
    grouped.set(w.address, buckets);

    if (w.protocol === "tron") {
      if (w.tron) buckets["tron"] = [formatTronResources(w.tron)];
      for (const error of w.errors) pushBucketLine(buckets, "tron", `Error: ${error}`);
      continue;
    }

    for (const position of w.lending) {
      pushBucketLine(buckets, position.platform ?? w.protocol, formatPosition(position));
    }
    const threshold = w.thresholds?.warningSupplyRate ?? FALLBACK_WARNING_SUPPLY_RATE;
    for (const supply of w.supplies) {
      pushBucketLine(buckets, supply.platform, formatSupplyPosition(supply, threshold));
      supplyCount += 1;
    }
    for (const pool of w.pools) {
      pushBucketLine(buckets, pool.platform, formatPoolPosition(pool));
      lpCount += 1;
    }
    for (const error of w.errors) {
      pushBucketLine(buckets, w.protocol, `Error: ${error}`);
    }
  }

  let text = formatResultsByWallet(grouped);
  if (text && supplyCount > 0) {
    text +=
      `\n\n💰 *Deposits total (${supplyCount} position${supplyCount === 1 ? "" : "s"})*\n` +
      `Supplied: ${fmtUsdExact(result.totals.supplyUsd)}`;
  }
  if (text && lpCount > 0) {
    text +=
      `\n\n💧 *LP total (${lpCount} position${lpCount === 1 ? "" : "s"})*\n` +
      `Deposited: ${fmtUsdExact(result.totals.lpValueUsd)} · Pending fees: ${fmtUsdExact(result.totals.lpFeesUsd)}`;
  }
  return text || "No positions found";
}

function renderRefreshMessage(result: RefreshResponse): string {
  const grouped = new Map<string, WalletBuckets>();
  for (const w of result.wallets) {
    grouped.set(w.address, {
      [w.protocol]:
        w.positions.length > 0
          ? w.positions.map((p) => formatPosition(p))
          : [w.error ? `Error: ${w.error}` : "No positions found"]
    });
  }
  return `Markets refreshed\n\n${formatResultsByWallet(grouped)}`;
}

function renderAddedWallet(added: AddedWallet, supplyThreshold: number): string {
  if (added.protocol === "tron" && added.tron) {
    return `Wallet added!\n\n\`${added.address}\`\n\n*TRON*\n${formatTronResources(added.tron)}`;
  }
  const lines = added.positions.map((p) => formatPosition(p));
  lines.push(...added.supplies.map((s) => formatSupplyPosition(s, supplyThreshold)));
  lines.push(...added.pools.map((p) => formatPoolPosition(p)));
  return `Wallet added!\n\n\`${added.address}\`\n\n${lines.join("\n")}`;
}

function skippedReasonMessage(reason: string): string {
  if (reason === "no positions found") return "No positions found for this wallet";
  if (reason === "unsupported format") return "Unsupported wallet format";
  return `Error: ${reason}`;
}

function effectiveSupplyThreshold(state: StateResponse | null, address: string): number {
  if (!state) return FALLBACK_WARNING_SUPPLY_RATE;
  const wallet = state.wallets.find((w) => w.address === address);
  return wallet?.effective.warningSupplyRate ?? state.defaults.warningSupplyRate;
}

// ---- Flows ----

async function runCheck(api: CoreApi, ctx: BotContext, protocol: string): Promise<void> {
  const statusMsg = await ctx.reply("Checking...");
  try {
    const result = await api.getPositions(String(ctx.chat?.id), protocol);
    await deleteMessage(ctx, statusMsg.message_id);
    if (result.wallets.length === 0) {
      await ctx.reply("No wallets configured");
      return;
    }
    await ctx.reply(renderPositionsMessage(result), { parse_mode: "Markdown" });
  } catch (error) {
    await deleteMessage(ctx, statusMsg.message_id);
    await ctx.reply(`Error: ${errorMessage(error)}`);
  }
}

async function runRefresh(api: CoreApi, ctx: BotContext, protocol: string): Promise<void> {
  const statusMsg = await ctx.reply("Rescanning markets...");
  try {
    const result = await api.refresh(String(ctx.chat?.id), protocol === "all" ? undefined : protocol);
    await deleteMessage(ctx, statusMsg.message_id);
    if (result.wallets.length === 0) {
      await ctx.reply("No wallets configured");
      return;
    }
    await ctx.reply(renderRefreshMessage(result), { parse_mode: "Markdown" });
  } catch (error) {
    await deleteMessage(ctx, statusMsg.message_id);
    await ctx.reply(`Error: ${errorMessage(error)}`);
  }
}

async function runTopLp(api: CoreApi, ctx: BotContext, l2: boolean, title: string): Promise<void> {
  const statusMsg = await ctx.reply("Scanning top chains & Uniswap pools...");
  try {
    const result = await api.getTopLp(String(ctx.chat?.id), l2);
    await deleteMessage(ctx, statusMsg.message_id);
    for (const msg of formatTopLpMessages(result, title)) {
      await ctx.reply(msg, { parse_mode: "Markdown", link_preview_options: { is_disabled: true } });
    }
  } catch (error) {
    await deleteMessage(ctx, statusMsg.message_id);
    await ctx.reply(`Error: ${errorMessage(error)}`);
  }
}

// Accepts one or many addresses (whitespace / newline / comma separated) and
// forwards them to the core in a single request. Unrecognised tokens are
// ignored client-side so random chat text stays silent.
async function addWallets(
  api: CoreApi,
  ctx: BotContext,
  rawText: string,
  opts: { silentIfNone?: boolean } = {}
): Promise<void> {
  const tokens = rawText
    .split(/[\s,]+/)
    .map((w) => w.trim())
    .filter(Boolean);
  const wallets = [...new Set(tokens.filter((w) => detectWalletType(w) !== "unknown"))];

  if (wallets.length === 0) {
    if (!opts.silentIfNone) await ctx.reply("Send a wallet address (or several, one per line)");
    return;
  }

  const chatId = String(ctx.chat?.id);
  let statusMessageId: number | null = null;
  if (wallets.length === 1) {
    const walletType = detectWalletType(wallets[0] ?? "");
    const statusText =
      walletType === "tron"
        ? "Checking Tron resources..."
        : walletType === "evm"
          ? "Checking Aave..."
          : "Scanning all markets...";
    statusMessageId = (await ctx.reply(statusText)).message_id;
  } else {
    await ctx.reply(`Adding ${wallets.length} wallets...`);
  }

  try {
    const result = await api.addWallets(chatId, wallets.join("\n"));
    if (statusMessageId != null) await deleteMessage(ctx, statusMessageId);

    let state: StateResponse | null = null;
    if (result.added.some((a) => a.supplies.length > 0)) {
      try {
        state = await api.getState(chatId);
      } catch {
        state = null; // fall back to the code-level default threshold
      }
    }

    for (const added of result.added) {
      await ctx.reply(renderAddedWallet(added, effectiveSupplyThreshold(state, added.address)), {
        parse_mode: "Markdown"
      });
    }
    for (const skipped of result.skipped) {
      await ctx.reply(skippedReasonMessage(skipped.reason));
    }
  } catch (error) {
    if (statusMessageId != null) await deleteMessage(ctx, statusMessageId);
    await ctx.reply(`Error: ${errorMessage(error)}`);
  }
}

async function showWalletSettings(api: CoreApi, ctx: BotContext, wallet: string): Promise<void> {
  const state = await api.getState(String(ctx.chat?.id));
  const entry = state.wallets.find((w) => w.address === wallet);
  if (!entry) {
    await ctx.reply("Wallet not found");
    return;
  }
  ctx.session.currentWallet = wallet;
  await ctx.editMessageText(formatWalletSettings(wallet, entry.effective, entry.thresholds), {
    parse_mode: "Markdown",
    ...walletSettingsMenu(entry.effective)
  });
}

async function showWalletsMenu(api: CoreApi, ctx: BotContext): Promise<void> {
  const state = await api.getState(String(ctx.chat?.id));
  const addresses = state.wallets.map((w) => w.address);
  ctx.session.walletMenu = addresses;
  await ctx.editMessageText("Wallets", walletMenu(addresses));
}

const START_TEXT =
  "LTV Watch Bot\n\n" +
  "Monitors for your wallets:\n" +
  "• Health Factor / LTV / borrow rate (Kamino, Aave)\n" +
  "• Lending deposits & supply APY (Kamino Earn, Aave, Fluid) — alerts when APY drops\n" +
  "• LP position ranges (Orca, Uniswap V3)\n" +
  "• Tron resources: energy/bandwidth, delegation & reclaim\n\n" +
  "Send wallet address(es) — one per line — to start monitoring them.\n\n" +
  "/menu - open menu (wallets, thresholds, checks)\n" +
  "/checkall - check all positions (lending + pools + Tron)\n" +
  "/toplp - top Uniswap LP pools (BTC/ETH vs stables) by 30d fee-weighted score\n" +
  "/toplpl2 - same, excluding Ethereum L1 (lower gas chains only)";

export const BOT_COMMANDS = [
  { command: "menu", description: "Open menu" },
  { command: "checkall", description: "Check all positions (lending + pools + Tron)" },
  { command: "toplp", description: "Top Uniswap LP pools (BTC/ETH vs stables) by 30d vol/TVL x fee" },
  { command: "toplpl2", description: "Top LP excluding Ethereum L1 (L2/sidechains only)" }
];

export function registerHandlers(bot: Telegraf<BotContext>, api: CoreApi): void {
  bot.start((ctx) => ctx.reply(START_TEXT));

  bot.command("menu", (ctx) => ctx.reply("Menu", mainMenu()));

  bot.command("checkall", async (ctx) => {
    await runCheck(api, ctx, "all");
  });

  bot.command("toplp", (ctx) => runTopLp(api, ctx, false, "Top LP"));
  bot.command("toplpl2", (ctx) => runTopLp(api, ctx, true, "Top LP (L2 only)"));

  bot.action("action:toplp", async (ctx) => {
    await ctx.answerCbQuery();
    await runTopLp(api, ctx, false, "Top LP");
  });

  bot.action("action:toplpl2", async (ctx) => {
    await ctx.answerCbQuery();
    await runTopLp(api, ctx, true, "Top LP (L2 only)");
  });

  bot.action("menu:main", async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.editMessageText("Menu", mainMenu());
  });

  bot.action("menu:settings", async (ctx) => {
    await ctx.answerCbQuery();
    try {
      const state = await api.getState(String(ctx.chat?.id));
      await ctx.editMessageText(
        "Global default thresholds.\nApplied to wallets that don't override them.",
        settingsMenu(state.defaults)
      );
    } catch (error) {
      await ctx.reply(`Error: ${errorMessage(error)}`);
    }
  });

  bot.action("menu:wallets", async (ctx) => {
    await ctx.answerCbQuery();
    try {
      await showWalletsMenu(api, ctx);
    } catch (error) {
      await ctx.reply(`Error: ${errorMessage(error)}`);
    }
  });

  bot.action(/menu:protocol:(.+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const protocol = ctx.match[1];
    if (!protocol) return;
    await ctx.editMessageText(`${protocol.toUpperCase()} menu`, protocolMenu(protocol));
  });

  bot.action(/action:check:(.+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const protocol = ctx.match[1];
    if (!protocol) return;
    await runCheck(api, ctx, protocol);
  });

  bot.action(/action:refresh:(.+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const protocol = ctx.match[1];
    if (!protocol) return;
    await runRefresh(api, ctx, protocol);
  });

  bot.action("action:addwallet", async (ctx) => {
    await ctx.answerCbQuery();
    ctx.session.pending = { action: "addwallet" };
    await ctx.reply("Send wallet address to add (or several, one per line)");
  });

  bot.action(/wallet:open:(\d+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const index = Number(ctx.match[1]);
    const wallet = ctx.session.walletMenu?.[index];
    if (!wallet) {
      await ctx.reply("Wallet not found");
      return;
    }
    try {
      await showWalletSettings(api, ctx, wallet);
    } catch (error) {
      await ctx.reply(`Error: ${errorMessage(error)}`);
    }
  });

  bot.action(/wallet:remove:(\d+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const index = Number(ctx.match[1]);
    const wallet = ctx.session.walletMenu?.[index];
    if (!wallet) {
      await ctx.reply("Wallet not found");
      return;
    }
    try {
      await api.deleteWallet(String(ctx.chat?.id), wallet);
      await ctx.reply(`Wallet removed\n\n\`${wallet}\``, { parse_mode: "Markdown" });
      await showWalletsMenu(api, ctx);
    } catch (error) {
      await ctx.reply(`Error: ${errorMessage(error)}`);
    }
  });

  bot.action(/wallet:set:(whf|dhf|wbr|dbr|wsr)/, async (ctx) => {
    await ctx.answerCbQuery();
    const code = ctx.match[1] ?? "";
    if (!isThresholdCode(code)) return;
    const wallet = ctx.session.currentWallet;
    if (!wallet) {
      await ctx.reply("Wallet not found");
      return;
    }
    ctx.session.pending = { action: "setwallet", field: code, wallet };
    await ctx.reply(`Send ${THRESHOLD_FIELDS[code].label} for ${formatWalletLabel(wallet)}`);
  });

  bot.action("wallet:reset", async (ctx) => {
    await ctx.answerCbQuery();
    const wallet = ctx.session.currentWallet;
    if (!wallet) {
      await ctx.reply("Wallet not found");
      return;
    }
    try {
      await api.resetWalletThresholds(String(ctx.chat?.id), wallet);
      await showWalletSettings(api, ctx, wallet);
    } catch (error) {
      await ctx.reply(`Error: ${errorMessage(error)}`);
    }
  });

  bot.action("wallet:back", async (ctx) => {
    await ctx.answerCbQuery();
    try {
      await showWalletsMenu(api, ctx);
    } catch (error) {
      await ctx.reply(`Error: ${errorMessage(error)}`);
    }
  });

  bot.action(/def:set:(whf|dhf|wbr|dbr|wsr)/, async (ctx) => {
    await ctx.answerCbQuery();
    const code = ctx.match[1] ?? "";
    if (!isThresholdCode(code)) return;
    ctx.session.pending = { action: "setdefault", field: code };
    await ctx.reply(`Send ${THRESHOLD_FIELDS[code].label} (global default)`);
  });

  bot.on(message("text"), async (ctx, next) => {
    const text = ctx.message.text;
    if (text.startsWith("/")) return next();
    const chatId = String(ctx.chat.id);
    const pending = ctx.session.pending;

    if (pending?.action === "addwallet") {
      ctx.session.pending = null;
      await addWallets(api, ctx, text);
      return;
    }

    if (pending?.action === "setwallet" || pending?.action === "setdefault") {
      const value = parseFloat(text);
      const field = THRESHOLD_FIELDS[pending.field];
      if (!Number.isFinite(value) || value <= 0) {
        await ctx.reply("Send a positive number");
        return;
      }

      ctx.session.pending = null;

      if (pending.action === "setdefault") {
        try {
          await api.setGlobalThreshold(chatId, field.key, value);
          await ctx.reply(`Default ${field.label} set to ${formatThresholdValue(field, value)}`);
        } catch (error) {
          await ctx.reply(`Error: ${errorMessage(error)}`);
        }
        return;
      }

      try {
        await api.setWalletThreshold(chatId, pending.wallet, field.key, value);
        await ctx.reply(
          `${field.label} for ${formatWalletLabel(pending.wallet)} set to ${formatThresholdValue(field, value)}`
        );
      } catch (error) {
        const msg = errorMessage(error);
        await ctx.reply(msg === "wallet not found" ? "Wallet not found" : `Error: ${msg}`);
      }
      return;
    }

    // No pending step — a plain message containing wallet address(es) is an add.
    await addWallets(api, ctx, text, { silentIfNone: true });
  });
}
