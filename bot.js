import { Telegraf, Markup } from "telegraf";
import { fetchMarkets, scanAllMarketsForWallet, checkSpecificMarkets } from "./kamino.js";
import { fetchAaveMarketsAll, scanAaveMarketsForWallet, checkAaveMarkets } from "./aave.js";
import { loadDb, getUser, setUser, deleteUser, getUserCount, getAllUsers } from "./db.js";
import { logger } from "./logger.js";

const BOT_TOKEN = process.env.BOT_TOKEN;

if (!BOT_TOKEN) {
  logger.error("BOT_TOKEN not set");
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

const CHECK_INTERVAL = 10 * 60 * 1000;

// Code-level fallbacks. Used when neither the wallet nor the global defaults set a value.
const DEFAULT_WARNING_HEALTH_FACTOR = 1.5;
const DEFAULT_DANGER_HEALTH_FACTOR = 1.3;
const DEFAULT_WARNING_BORROW_RATE = 10; // %
const DEFAULT_DANGER_BORROW_RATE = 15; // %

// Maps short callback/command codes to threshold fields.
// kind "hf"   -> alert when value is BELOW the threshold (lower health factor = riskier)
// kind "rate" -> alert when value is ABOVE the threshold (higher borrow rate = costlier)
const THRESHOLD_FIELDS = {
  whf: { key: "warningHealthFactor", label: "Warning HF", kind: "hf" },
  dhf: { key: "dangerHealthFactor", label: "Danger HF", kind: "hf" },
  wbr: { key: "warningBorrowRate", label: "Warning Rate", kind: "rate" },
  dbr: { key: "dangerBorrowRate", label: "Danger Rate", kind: "rate" }
};

loadDb();

async function deleteMessage(ctx, messageId) {
  try {
    await ctx.deleteMessage(messageId);
  } catch {
    // ignore if message already deleted
  }
}

async function editMessage(ctx, messageId, text) {
  try {
    await bot.telegram.editMessageText(ctx.chat.id, messageId, null, text);
  } catch {
    // ignore if message already deleted
  }
}

function isEvmAddress(address) {
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}

function isSolanaAddress(address) {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address);
}

function detectWalletType(address) {
  if (isEvmAddress(address)) return "evm";
  if (isSolanaAddress(address)) return "solana";
  return "unknown";
}

function ensureUser(chatId) {
  let user = getUser(chatId);
  if (!user) user = {};
  if (!user.wallets) user.wallets = {};
  if (!user.settings) user.settings = {};
  if (!user.ui) user.ui = {};
  return user;
}

// User-configurable global defaults, falling back to code constants.
function getGlobalDefaults(user) {
  const s = user?.settings || {};
  return {
    warningHealthFactor: s.warningHealthFactor ?? DEFAULT_WARNING_HEALTH_FACTOR,
    dangerHealthFactor: s.dangerHealthFactor ?? DEFAULT_DANGER_HEALTH_FACTOR,
    warningBorrowRate: s.warningBorrowRate ?? DEFAULT_WARNING_BORROW_RATE,
    dangerBorrowRate: s.dangerBorrowRate ?? DEFAULT_DANGER_BORROW_RATE
  };
}

// Effective thresholds for a wallet: per-wallet override -> global default -> constant.
function getWalletThresholds(user, wallet) {
  const defaults = getGlobalDefaults(user);
  const w = user?.wallets?.[wallet]?.settings || {};
  return {
    warningHealthFactor: w.warningHealthFactor ?? defaults.warningHealthFactor,
    dangerHealthFactor: w.dangerHealthFactor ?? defaults.dangerHealthFactor,
    warningBorrowRate: w.warningBorrowRate ?? defaults.warningBorrowRate,
    dangerBorrowRate: w.dangerBorrowRate ?? defaults.dangerBorrowRate
  };
}

// 0 = ok, 1 = warning, 2 = danger. Worst of the health-factor and borrow-rate checks.
function positionSeverity(thresholds, healthFactor, borrowRate) {
  let level = 0;

  const hf = parseFloat(healthFactor);
  if (Number.isFinite(hf)) {
    if (hf <= thresholds.dangerHealthFactor) level = Math.max(level, 2);
    else if (hf <= thresholds.warningHealthFactor) level = Math.max(level, 1);
  }

  const br = parseFloat(borrowRate);
  if (Number.isFinite(br)) {
    if (br >= thresholds.dangerBorrowRate) level = Math.max(level, 2);
    else if (br >= thresholds.warningBorrowRate) level = Math.max(level, 1);
  }

  return level;
}

function formatThresholdValue(field, value) {
  return field.kind === "rate" ? `${value}%` : `${value}`;
}

function mainMenu() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("Kamino", "menu:protocol:kamino"),
      Markup.button.callback("Aave", "menu:protocol:aave")
    ],
    [
      Markup.button.callback("Check All", "action:check:all"),
      Markup.button.callback("Refresh All", "action:refresh:all")
    ],
    [Markup.button.callback("Wallets", "menu:wallets")],
    [Markup.button.callback("Settings", "menu:settings")]
  ]);
}

function protocolMenu(protocol) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("Check", `action:check:${protocol}`),
      Markup.button.callback("Refresh Markets", `action:refresh:${protocol}`)
    ],
    [Markup.button.callback("Back", "menu:main")]
  ]);
}

function settingsMenu(user) {
  const d = getGlobalDefaults(user);
  return Markup.inlineKeyboard([
    [
      Markup.button.callback(`Warning HF: ${d.warningHealthFactor}`, "def:set:whf"),
      Markup.button.callback(`Danger HF: ${d.dangerHealthFactor}`, "def:set:dhf")
    ],
    [
      Markup.button.callback(`Warning Rate: ${d.warningBorrowRate}%`, "def:set:wbr"),
      Markup.button.callback(`Danger Rate: ${d.dangerBorrowRate}%`, "def:set:dbr")
    ],
    [Markup.button.callback("Back", "menu:main")]
  ]);
}

function formatWalletLabel(wallet) {
  if (!wallet || wallet.length <= 12) return wallet;
  return `${wallet.slice(0, 6)}...${wallet.slice(-4)}`;
}

function walletMenu(user) {
  const rows = [];
  const wallets = Object.keys(user?.wallets || {});
  user.ui.walletMenu = wallets;
  for (let i = 0; i < wallets.length; i += 1) {
    const wallet = wallets[i];
    rows.push([
      Markup.button.callback(formatWalletLabel(wallet), `wallet:open:${i}`),
      Markup.button.callback("✖", `wallet:remove:${i}`)
    ]);
  }
  rows.push([Markup.button.callback("Add Wallet", "action:addwallet")]);
  rows.push([Markup.button.callback("Back", "menu:main")]);
  return Markup.inlineKeyboard(rows);
}

function walletSettingsMenu(user, wallet) {
  const t = getWalletThresholds(user, wallet);
  return Markup.inlineKeyboard([
    [
      Markup.button.callback(`Warning HF: ${t.warningHealthFactor}`, "wallet:set:whf"),
      Markup.button.callback(`Danger HF: ${t.dangerHealthFactor}`, "wallet:set:dhf")
    ],
    [
      Markup.button.callback(`Warning Rate: ${t.warningBorrowRate}%`, "wallet:set:wbr"),
      Markup.button.callback(`Danger Rate: ${t.dangerBorrowRate}%`, "wallet:set:dbr")
    ],
    [Markup.button.callback("Reset to defaults", "wallet:reset")],
    [Markup.button.callback("Back", "wallet:back")]
  ]);
}

function formatWalletSettings(user, wallet) {
  const t = getWalletThresholds(user, wallet);
  const overrides = user?.wallets?.[wallet]?.settings || {};
  const mark = (key) => (overrides[key] != null ? "" : " (default)");
  return [
    "Wallet settings",
    `\`${wallet}\``,
    "",
    `Warning HF: ${t.warningHealthFactor}${mark("warningHealthFactor")}`,
    `Danger HF: ${t.dangerHealthFactor}${mark("dangerHealthFactor")}`,
    `Warning Rate: ${t.warningBorrowRate}%${mark("warningBorrowRate")}`,
    `Danger Rate: ${t.dangerBorrowRate}%${mark("dangerBorrowRate")}`
  ].join("\n");
}

function resolveWalletArg(user, arg) {
  const wallets = Object.keys(user?.wallets || {});
  if (/^\d+$/.test(arg)) {
    return wallets[Number(arg) - 1] || null;
  }
  return wallets.includes(arg) ? arg : null;
}

function formatResultsByWallet(resultsByWallet) {
  const output = [];
  const protocolsOrder = ["kamino", "aave"];
  for (const [wallet, protocols] of resultsByWallet.entries()) {
    output.push(`\`${wallet}\``);
    const protocolKeys = Object.keys(protocols);
    protocolKeys.sort((a, b) => {
      const aIdx = protocolsOrder.indexOf(a);
      const bIdx = protocolsOrder.indexOf(b);
      if (aIdx === -1 && bIdx === -1) return a.localeCompare(b);
      if (aIdx === -1) return 1;
      if (bIdx === -1) return -1;
      return aIdx - bIdx;
    });
    for (const protocol of protocolKeys) {
      const label = protocol === "aave" ? "*AAVE*" : "*KAMINO*";
      output.push(label);
      output.push(protocols[protocol].join("\n"));
    }
  }
  return output.join("\n\n");
}

async function addWallet(ctx, wallet) {
  if (!wallet || wallet.length < 32) {
    return ctx.reply("Usage: /add <wallet_address>");
  }
  const chatId = String(ctx.chat.id);
  const walletType = detectWalletType(wallet);
  if (walletType === "unknown") {
    return ctx.reply("Unsupported wallet format");
  }
  const protocol = walletType === "evm" ? "aave" : "kamino";
  const statusMsg = await ctx.reply(protocol === "aave" ? "Checking Aave..." : "Scanning all markets...");
  try {
    let positions;
    if (protocol === "aave") {
      positions = await scanAaveMarketsForWallet(wallet);
    } else {
      positions = await scanAllMarketsForWallet(wallet, (marketCheck) => {
        editMessage(ctx, statusMsg.message_id, `Scanning market ${marketCheck.current + 1} of ${marketCheck.total}...`);
      });
    }
    await deleteMessage(ctx, statusMsg.message_id);
    if (!positions || positions.length === 0) {
      return ctx.reply("No positions found for this wallet");
    }
    const user = ensureUser(chatId);
    const marketNames = positions.map(p => p.market);
    user.wallets[wallet] = {
      markets: marketNames,
      protocol,
      settings: {}
    };
    setUser(chatId, user);
    logger.info({ chatId, wallet, markets: marketNames }, "Wallet added");
    const lines = positions.map(p => formatPosition({ user, wallet, position: p }));
    ctx.reply(`Wallet added!\n\n\`${wallet}\`\n\n${lines.join("\n")}`, { parse_mode: "Markdown" });
  } catch (error) {
    await deleteMessage(ctx, statusMsg.message_id);
    logger.error({ chatId, wallet, error: error.message }, "Failed to add wallet");
    ctx.reply(`Error: ${error.message}`);
  }
}

function removeWallet(ctx, wallet) {
  if (!wallet) {
    return ctx.reply("Usage: /remove <wallet_address>");
  }
  const chatId = String(ctx.chat.id);
  const user = getUser(chatId);
  if (!user || !user.wallets || !user.wallets[wallet]) {
    return ctx.reply("Wallet not found");
  }
  delete user.wallets[wallet];
  if (Object.keys(user.wallets).length === 0) {
    deleteUser(chatId);
  } else {
    setUser(chatId, user);
  }
  logger.info({ chatId, wallet }, "Wallet removed");
  ctx.reply(`Wallet removed\n\n\`${wallet}\``, { parse_mode: "Markdown" });
}

async function checkWallets(ctx, user, protocolFilter) {
  const wallets = Object.entries(user.wallets || {}).filter(([_, data]) => {
    if (!protocolFilter || protocolFilter === "all") return true;
    return (data.protocol || "kamino") === protocolFilter;
  });
  if (wallets.length === 0) {
    return ctx.reply("No wallets configured");
  }
  const statusMsg = await ctx.reply("Checking...");
  const grouped = new Map();
  for (const [wallet, walletData] of wallets) {
    try {
      const protocol = walletData.protocol || "kamino";
      const markets = walletData.markets || [];
      if (protocol === "kamino" && markets.length === 0) {
        if (!grouped.has(wallet)) grouped.set(wallet, {});
        grouped.get(wallet)[protocol] = ["No markets cached. Use /refreshmarkets"];
        continue;
      }
      let positions;
      if (protocol === "aave") {
        positions = await checkAaveMarkets(wallet);
      } else {
        positions = await checkSpecificMarkets(wallet, markets);
      }
      if (positions && positions.length > 0) {
        const lines = positions.map(p => formatPosition({ user, wallet, position: p }));
        if (!grouped.has(wallet)) grouped.set(wallet, {});
        grouped.get(wallet)[protocol] = lines;
      } else {
        if (!grouped.has(wallet)) grouped.set(wallet, {});
        grouped.get(wallet)[protocol] = ["No positions"];
      }
    } catch (error) {
      logger.error({ wallet, error: error.message }, "Check failed");
      if (!grouped.has(wallet)) grouped.set(wallet, {});
      grouped.get(wallet)[walletData.protocol || "kamino"] = [`Error: ${error.message}`];
    }
  }
  await deleteMessage(ctx, statusMsg.message_id);
  ctx.reply(formatResultsByWallet(grouped), { parse_mode: "Markdown" });
}

async function refreshMarketsForUser(ctx, user, protocolFilter) {
  const wallets = Object.entries(user.wallets || {}).filter(([_, data]) => {
    if (!protocolFilter || protocolFilter === "all") return true;
    return (data.protocol || "kamino") === protocolFilter;
  });
  if (wallets.length === 0) {
    return ctx.reply("No wallets configured");
  }
  const statusMsg = await ctx.reply("Rescanning markets...");
  const grouped = new Map();
  for (const [wallet, walletData] of wallets) {
    try {
      const protocol = walletData.protocol || "kamino";
      let positions;
      if (protocol === "aave") {
        positions = await scanAaveMarketsForWallet(wallet);
      } else {
        positions = await scanAllMarketsForWallet(wallet);
      }
      if (positions && positions.length > 0) {
        const marketNames = positions.map(p => p.market);
        walletData.markets = marketNames;
        const lines = positions.map(p => formatPosition({ user, wallet, position: p }));
        if (!grouped.has(wallet)) grouped.set(wallet, {});
        grouped.get(wallet)[protocol] = lines;
      } else {
        walletData.markets = [];
        if (!grouped.has(wallet)) grouped.set(wallet, {});
        grouped.get(wallet)[protocol] = ["No positions found"];
      }
    } catch (error) {
      logger.error({ wallet, error: error.message }, "Refresh failed");
      if (!grouped.has(wallet)) grouped.set(wallet, {});
      grouped.get(wallet)[walletData.protocol || "kamino"] = [`Error: ${error.message}`];
    }
  }
  setUser(String(ctx.chat.id), user);
  await deleteMessage(ctx, statusMsg.message_id);
  ctx.reply(`Markets refreshed\n\n${formatResultsByWallet(grouped)}`, { parse_mode: "Markdown" });
}

bot.start((ctx) => {
  ctx.reply(
    "LTV Watch Bot\n\n" +
    "/menu - open menu\n" +
    "/add <wallet> - add wallet to monitor\n" +
    "/remove <wallet> - remove wallet\n" +
    "/list - show your wallets and thresholds\n" +
    "/check - check positions for your wallets\n" +
    "/refreshmarkets - rescan markets for your wallets\n" +
    "/setwarning <wallet|index|default> <value> - set warning health factor\n" +
    "/setdanger <wallet|index|default> <value> - set danger health factor\n" +
    "/setratewarning <wallet|index|default> <value> - set warning borrow rate (%)\n" +
    "/setratedanger <wallet|index|default> <value> - set danger borrow rate (%)\n" +
    "/settings - show your current settings\n" +
    "/stop - stop monitoring and remove all wallets"
  );
});

bot.command("menu", (ctx) => {
  ctx.reply("Menu", mainMenu());
});

bot.action("menu:main", async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText("Menu", mainMenu());
});

bot.action("menu:settings", async (ctx) => {
  await ctx.answerCbQuery();
  const chatId = String(ctx.chat.id);
  const user = ensureUser(chatId);
  await ctx.editMessageText(
    "Global default thresholds.\nApplied to wallets that don't override them.",
    settingsMenu(user)
  );
  setUser(chatId, user);
});

bot.action("menu:wallets", async (ctx) => {
  await ctx.answerCbQuery();
  const chatId = String(ctx.chat.id);
  const user = ensureUser(chatId);
  await ctx.editMessageText("Wallets", walletMenu(user));
  setUser(chatId, user);
});

bot.action(/menu:protocol:(.+)/, async (ctx) => {
  await ctx.answerCbQuery();
  const protocol = ctx.match[1];
  const chatId = String(ctx.chat.id);
  const user = ensureUser(chatId);
  user.ui.protocol = protocol;
  setUser(chatId, user);
  await ctx.editMessageText(`${protocol.toUpperCase()} menu`, protocolMenu(protocol));
});

bot.action(/action:check:(.+)/, async (ctx) => {
  await ctx.answerCbQuery();
  const protocol = ctx.match[1];
  const chatId = String(ctx.chat.id);
  const user = ensureUser(chatId);
  await checkWallets(ctx, user, protocol);
});

bot.action(/action:refresh:(.+)/, async (ctx) => {
  await ctx.answerCbQuery();
  const protocol = ctx.match[1];
  const chatId = String(ctx.chat.id);
  const user = ensureUser(chatId);
  await refreshMarketsForUser(ctx, user, protocol);
});

bot.action("action:addwallet", async (ctx) => {
  await ctx.answerCbQuery();
  const chatId = String(ctx.chat.id);
  const user = ensureUser(chatId);
  user.ui.pending = { action: "addwallet" };
  setUser(chatId, user);
  await ctx.reply("Send wallet address to add");
});

bot.action(/wallet:open:(\d+)/, async (ctx) => {
  await ctx.answerCbQuery();
  const chatId = String(ctx.chat.id);
  const user = ensureUser(chatId);
  const index = Number(ctx.match[1]);
  const wallet = user.ui.walletMenu?.[index];
  if (!wallet || !user.wallets[wallet]) {
    return ctx.reply("Wallet not found");
  }
  user.ui.currentWallet = wallet;
  setUser(chatId, user);
  await ctx.editMessageText(formatWalletSettings(user, wallet), {
    parse_mode: "Markdown",
    ...walletSettingsMenu(user, wallet)
  });
});

bot.action(/wallet:remove:(\d+)/, async (ctx) => {
  await ctx.answerCbQuery();
  const chatId = String(ctx.chat.id);
  let user = ensureUser(chatId);
  const index = Number(ctx.match[1]);
  const wallet = user.ui.walletMenu?.[index];
  if (!wallet) {
    return ctx.reply("Wallet not found");
  }
  removeWallet(ctx, wallet);
  user = ensureUser(chatId);
  await ctx.editMessageText("Wallets", walletMenu(user));
  setUser(chatId, user);
});

bot.action(/wallet:set:(whf|dhf|wbr|dbr)/, async (ctx) => {
  await ctx.answerCbQuery();
  const chatId = String(ctx.chat.id);
  const user = ensureUser(chatId);
  const field = ctx.match[1];
  const wallet = user.ui.currentWallet;
  if (!wallet || !user.wallets[wallet]) {
    return ctx.reply("Wallet not found");
  }
  user.ui.pending = { action: "setwallet", field, wallet };
  setUser(chatId, user);
  await ctx.reply(`Send ${THRESHOLD_FIELDS[field].label} for ${formatWalletLabel(wallet)}`);
});

bot.action("wallet:reset", async (ctx) => {
  await ctx.answerCbQuery();
  const chatId = String(ctx.chat.id);
  const user = ensureUser(chatId);
  const wallet = user.ui.currentWallet;
  if (!wallet || !user.wallets[wallet]) {
    return ctx.reply("Wallet not found");
  }
  user.wallets[wallet].settings = {};
  setUser(chatId, user);
  await ctx.editMessageText(formatWalletSettings(user, wallet), {
    parse_mode: "Markdown",
    ...walletSettingsMenu(user, wallet)
  });
});

bot.action("wallet:back", async (ctx) => {
  await ctx.answerCbQuery();
  const chatId = String(ctx.chat.id);
  const user = ensureUser(chatId);
  await ctx.editMessageText("Wallets", walletMenu(user));
  setUser(chatId, user);
});

bot.action(/def:set:(whf|dhf|wbr|dbr)/, async (ctx) => {
  await ctx.answerCbQuery();
  const chatId = String(ctx.chat.id);
  const user = ensureUser(chatId);
  const field = ctx.match[1];
  user.ui.pending = { action: "setdefault", field };
  setUser(chatId, user);
  await ctx.reply(`Send ${THRESHOLD_FIELDS[field].label} (global default)`);
});

bot.on("text", async (ctx) => {
  const text = ctx.message.text;
  if (text.startsWith("/")) return;
  const chatId = String(ctx.chat.id);
  const user = ensureUser(chatId);
  const pending = user.ui?.pending;
  if (!pending) return;

  if (pending.action === "addwallet") {
    user.ui.pending = null;
    setUser(chatId, user);
    return addWallet(ctx, text.trim());
  }

  if (pending.action === "removewallet") {
    user.ui.pending = null;
    setUser(chatId, user);
    return removeWallet(ctx, text.trim());
  }

  if (pending.action === "setwallet" || pending.action === "setdefault") {
    const value = parseFloat(text);
    const field = THRESHOLD_FIELDS[pending.field];
    if (!field) {
      user.ui.pending = null;
      setUser(chatId, user);
      return ctx.reply("Unknown setting");
    }
    if (!Number.isFinite(value) || value <= 0) {
      return ctx.reply("Send a positive number");
    }

    user.ui.pending = null;

    if (pending.action === "setdefault") {
      user.settings[field.key] = value;
      setUser(chatId, user);
      logger.info({ chatId, field: field.key, value }, "Global default set");
      return ctx.reply(`Default ${field.label} set to ${formatThresholdValue(field, value)}`);
    }

    const wallet = pending.wallet;
    if (!wallet || !user.wallets[wallet]) {
      setUser(chatId, user);
      return ctx.reply("Wallet not found");
    }
    if (!user.wallets[wallet].settings) user.wallets[wallet].settings = {};
    user.wallets[wallet].settings[field.key] = value;
    setUser(chatId, user);
    logger.info({ chatId, wallet, field: field.key, value }, "Wallet threshold set");
    return ctx.reply(`${field.label} for ${formatWalletLabel(wallet)} set to ${formatThresholdValue(field, value)}`);
  }
});

bot.command("add", async (ctx) => {
  const wallet = ctx.message.text.split(" ")[1];
  await addWallet(ctx, wallet);
});

bot.command("remove", (ctx) => {
  const wallet = ctx.message.text.split(" ")[1];
  removeWallet(ctx, wallet);
});

bot.command("list", (ctx) => {
  const chatId = String(ctx.chat.id);
  const user = getUser(chatId);

  if (!user || !user.wallets || Object.keys(user.wallets).length === 0) {
    return ctx.reply("No wallets configured");
  }

  const wallets = Object.keys(user.wallets);
  const lines = wallets.map((w, i) => {
    const t = getWalletThresholds(user, w);
    return `${i + 1}. \`${w}\`\n   HF ${t.warningHealthFactor}/${t.dangerHealthFactor}, Rate ${t.warningBorrowRate}%/${t.dangerBorrowRate}%`;
  });
  ctx.reply(`Your wallets (warning/danger):\n\n${lines.join("\n")}`, { parse_mode: "Markdown" });
});

bot.command("check", async (ctx) => {
  const chatId = String(ctx.chat.id);
  const user = getUser(chatId);
  if (!user || !user.wallets || Object.keys(user.wallets).length === 0) {
    return ctx.reply("No wallets configured. Use /add <wallet>");
  }
  const protocol = ctx.message.text.split(" ")[1];
  await checkWallets(ctx, user, protocol);
});

bot.command("refreshmarkets", async (ctx) => {
  const chatId = String(ctx.chat.id);
  const user = getUser(chatId);
  if (!user || !user.wallets || Object.keys(user.wallets).length === 0) {
    return ctx.reply("No wallets configured. Use /add <wallet>");
  }
  const protocol = ctx.message.text.split(" ")[1];
  await refreshMarketsForUser(ctx, user, protocol);
});

function handleSetThreshold(ctx, command, fieldCode) {
  const parts = ctx.message.text.trim().split(/\s+/);
  const target = parts[1];
  const value = parseFloat(parts[2]);
  const field = THRESHOLD_FIELDS[fieldCode];
  const chatId = String(ctx.chat.id);
  const user = ensureUser(chatId);

  if (!target || !Number.isFinite(value) || value <= 0) {
    return ctx.reply(
      `Usage: /${command} <wallet|index|default> <positive_number>\n` +
      `Example: /${command} 1 ${field.kind === "rate" ? "12" : "1.4"}`
    );
  }

  if (target.toLowerCase() === "default") {
    user.settings[field.key] = value;
    setUser(chatId, user);
    logger.info({ chatId, field: field.key, value }, "Global default set");
    return ctx.reply(`Default ${field.label} set to ${formatThresholdValue(field, value)}`);
  }

  const wallet = resolveWalletArg(user, target);
  if (!wallet) {
    return ctx.reply("Wallet not found. Use /list to see wallets.");
  }
  if (!user.wallets[wallet].settings) user.wallets[wallet].settings = {};
  user.wallets[wallet].settings[field.key] = value;
  setUser(chatId, user);
  logger.info({ chatId, wallet, field: field.key, value }, "Wallet threshold set");
  return ctx.reply(`${field.label} for ${formatWalletLabel(wallet)} set to ${formatThresholdValue(field, value)}`);
}

bot.command("setwarning", (ctx) => handleSetThreshold(ctx, "setwarning", "whf"));
bot.command("setdanger", (ctx) => handleSetThreshold(ctx, "setdanger", "dhf"));
bot.command("setratewarning", (ctx) => handleSetThreshold(ctx, "setratewarning", "wbr"));
bot.command("setratedanger", (ctx) => handleSetThreshold(ctx, "setratedanger", "dbr"));

bot.command("settings", (ctx) => {
  const chatId = String(ctx.chat.id);
  const user = ensureUser(chatId);
  const d = getGlobalDefaults(user);
  const lines = [
    "Global defaults (warning/danger):",
    `HF: ${d.warningHealthFactor}/${d.dangerHealthFactor}`,
    `Borrow Rate: ${d.warningBorrowRate}%/${d.dangerBorrowRate}%`
  ];
  const wallets = Object.keys(user.wallets || {});
  if (wallets.length > 0) {
    lines.push("", "Wallets:");
    wallets.forEach((w, i) => {
      const t = getWalletThresholds(user, w);
      lines.push(
        `${i + 1}. ${formatWalletLabel(w)} — HF ${t.warningHealthFactor}/${t.dangerHealthFactor}, Rate ${t.warningBorrowRate}%/${t.dangerBorrowRate}%`
      );
    });
  }
  ctx.reply(lines.join("\n"));
});

bot.command("stop", (ctx) => {
  const chatId = String(ctx.chat.id);
  deleteUser(chatId);
  logger.info({ chatId }, "User stopped monitoring");
  ctx.reply("Monitoring stopped, all wallets removed");
});

async function refreshMarketsBackground() {
  try {
    await fetchMarkets();
    await fetchAaveMarketsAll();
  } catch (error) {
    logger.error({ error: error.message }, "Failed to refresh markets in background");
  }
}

async function checkAllUsers() {
  for (const [chatId, user] of getAllUsers()) {
    logger.info({ chatId }, "Checking user positions on background");

    if (!user.wallets) continue;

    for (const [wallet, walletData] of Object.entries(user.wallets)) {
      const protocol = walletData.protocol || "kamino";
      const markets = walletData.markets || [];
      const thresholds = getWalletThresholds(user, wallet);

      if (protocol === "kamino" && markets.length === 0) continue;

      try {
        let positions;
        if (protocol === "aave") {
          positions = await checkAaveMarkets(wallet);
        } else {
          positions = await checkSpecificMarkets(wallet, markets);
        }

        if (!positions || positions.length === 0) continue;

        const breaching = positions.filter(
          (p) => positionSeverity(thresholds, p.healthFactor, p.borrowRate) >= 1
        );
        if (breaching.length === 0) continue;

        logger.info(
          { chatId, wallet, protocol, breaching: breaching.map((p) => p.market), thresholds },
          "Threshold breached"
        );

        const grouped = new Map();
        grouped.set(wallet, {
          [protocol]: positions.map((p) => formatPosition({ user, wallet, position: p }))
        });
        await bot.telegram.sendMessage(chatId, formatResultsByWallet(grouped), { parse_mode: "Markdown" });
      } catch (error) {
        logger.error({ chatId, wallet, error: error.message }, "Check failed");
      }
    }
  }
}

async function init() {
  try {
    await fetchMarkets();
    await fetchAaveMarketsAll();
  } catch (error) {
    logger.error({ error: error.message }, "Failed to load markets on startup");
  }

  setInterval(refreshMarketsBackground, CHECK_INTERVAL);
  setInterval(checkAllUsers, CHECK_INTERVAL);

  try {
    await bot.telegram.setMyCommands([
      { command: "menu", description: "Open menu" },
      { command: "add", description: "Add wallet" },
      { command: "remove", description: "Remove wallet" },
      { command: "list", description: "List wallets and thresholds" },
      { command: "check", description: "Check positions (all/aave/kamino)" },
      { command: "refreshmarkets", description: "Refresh markets (all/aave/kamino)" },
      { command: "setwarning", description: "Warning HF <wallet|index|default> <value>" },
      { command: "setdanger", description: "Danger HF <wallet|index|default> <value>" },
      { command: "setratewarning", description: "Warning rate <wallet|index|default> <value>" },
      { command: "setratedanger", description: "Danger rate <wallet|index|default> <value>" },
      { command: "settings", description: "Show settings" },
      { command: "stop", description: "Stop monitoring" }
    ]);
  } catch (error) {
    logger.error({ error: error.message }, "Failed to set bot commands");
  }

  const userCount = getUserCount();
  if (userCount > 0) {
    logger.info({ count: userCount }, "Users loaded");
    setTimeout(checkAllUsers, 5000);
  }

  bot.launch();
  logger.info("Bot started");
}

init();

process.once("SIGINT", () => {
  logger.info("Shutting down (SIGINT)");
  bot.stop("SIGINT");
});

process.once("SIGTERM", () => {
  logger.info("Shutting down (SIGTERM)");
  bot.stop("SIGTERM");
});

function formatBorrowRates(position) {
  const borrows = Array.isArray(position.borrows)
    ? position.borrows.filter((b) => b && Number.isFinite(parseFloat(b.rate)))
    : [];

  if (borrows.length === 0) {
    return position.borrowRate == null ? "Borrow Rate: n/a" : `Borrow Rate: ${position.borrowRate}%`;
  }

  const lines = borrows.map((b) => `  ${b.token}: ${b.rate}%`);
  return `Borrow Rate:\n${lines.join("\n")}`;
}

function formatPosition({ user, wallet, position }) {
  const thresholds = getWalletThresholds(user, wallet);
  const level = positionSeverity(thresholds, position.healthFactor, position.borrowRate);

  const prefix = level === 2 ? "☠️ " : level === 1 ? "⚠️ " : "✅ ";

  return `${prefix}${position.market}:\nLTV: ${position.ltv}%\nLiquidation LTV: ${position.liquidationLtv}%\nHealth Factor: ${position.healthFactor}\n${formatBorrowRates(position)}`;
}
