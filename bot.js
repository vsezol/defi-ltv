import { Telegraf, Markup, session } from "telegraf";
import { fetchMarkets, scanAllMarketsForWallet, checkSpecificMarkets } from "./kamino.js";
import { fetchAaveMarketsAll, scanAaveMarketsForWallet, checkAaveMarkets } from "./aave.js";
import { getTronResources, tronReclaimInfo, computeTronFlags } from "./tron.js";
import { getTopLpPools } from "./toplp.js";
import {
  getGlobalDefaults,
  getWalletThresholds,
  detectWalletType,
  scanPoolsForWallet,
  scanSuppliesForWallet,
  isSupplyBelow,
  addWalletCore
} from "./core.js";
import { startWebServer } from "./server.js";
import {
  initDb,
  closeDb,
  getUser,
  getAllUsers,
  getUserCount,
  deleteWallet,
  setGlobalThreshold,
  setWalletThreshold,
  resetWalletThresholds,
  setWalletMarkets,
  setWalletPoolStates,
  setWalletSupplyStates,
  setWalletTronState
} from "./db.js";
import { uiCache } from "./cache.js";
import { logger } from "./logger.js";

const BOT_TOKEN = process.env.BOT_TOKEN;

if (!BOT_TOKEN) {
  logger.error("BOT_TOKEN not set");
  process.exit(1);
}

// handlerTimeout: /checkall scans many chains and can legitimately run for
// minutes; Telegraf's default 90s would kill the handler mid-flight.
const bot = new Telegraf(BOT_TOKEN, { handlerTimeout: 15 * 60 * 1000 });

// A handler error (including a timeout) must NEVER crash the process — without
// bot.catch Telegraf rethrows into an unhandled rejection and the whole bot dies
// (then crash-loops on Railway while users see no replies).
bot.catch((error, ctx) => {
  logger.error(
    { updateType: ctx?.updateType, chatId: ctx?.chat?.id, error: error?.message || String(error) },
    "Unhandled bot handler error"
  );
});

// Last-resort safety net: log stray rejections from background/network code
// instead of letting Node kill the process.
process.on("unhandledRejection", (reason) => {
  logger.error({ error: reason?.message || String(reason) }, "Unhandled promise rejection");
});

// Transient per-chat UI state (pending input, menu index, current wallet) lives in
// ctx.session, backed by the swappable keyv store (in-memory now, Redis via REDIS_URL).
bot.use(session({ store: uiCache, defaultSession: () => ({}) }));

const CHECK_INTERVAL = 10 * 60 * 1000;
const TRON_CHECK_INTERVAL = 60 * 60 * 1000;

// Maps short callback/command codes to threshold fields.
// kind "hf"   -> alert when value is BELOW the threshold (lower health factor = riskier)
// kind "rate" -> alert when value is ABOVE the threshold (higher borrow rate = costlier)
// warningSupplyRate is a "rate" for formatting, but alerts fire when the deposit
// APY falls BELOW it (lower supply yield = worse).
const THRESHOLD_FIELDS = {
  whf: { key: "warningHealthFactor", label: "Warning HF", kind: "hf" },
  dhf: { key: "dangerHealthFactor", label: "Danger HF", kind: "hf" },
  wbr: { key: "warningBorrowRate", label: "Warning Rate", kind: "rate" },
  dbr: { key: "dangerBorrowRate", label: "Danger Rate", kind: "rate" },
  wsr: { key: "warningSupplyRate", label: "Warning Supply APY", kind: "rate" }
};

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

// Durable data (wallets, settings) comes from Postgres. Transient UI state lives
// in ctx.session, so handlers read/write ctx.session.* directly (no manual save).
async function ensureUser(chatId) {
  const user = (await getUser(chatId)) || {};
  if (!user.wallets) user.wallets = {};
  if (!user.settings) user.settings = {};
  return user;
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

function formatSupplyPosition(position, threshold, transition) {
  const below = isSupplyBelow(position, threshold);
  const prefix = below ? "🔻 " : "💰 ";
  const apy = Number.isFinite(position.supplyApy) ? `${position.supplyApy}%` : "?";
  let line = `Deposited: ${fmtUsdExact(position.amountUsd)} · APY ${apy}`;
  if (transition) {
    line += below ? ` (dropped below ${threshold}%)` : ` (recovered above ${threshold}%)`;
  }
  return `${prefix}${position.asset} — ${position.market}:\n${line}`;
}

function formatPoolPrice(value) {
  if (!Number.isFinite(value)) return "?";
  if (value >= 1) return value.toFixed(2);
  return value.toPrecision(4);
}

// Normalized position of the current price inside the range:
// 0..1 in range (0 = lower bound, 1 = upper bound), <0 below, >1 above (shown as +X).
function formatRangeCoord(position) {
  const span = position.upperPrice - position.lowerPrice;
  if (!Number.isFinite(span) || span <= 0) return "";
  const coord = (position.currentPrice - position.lowerPrice) / span;
  if (!Number.isFinite(coord)) return "";
  return ` ${coord > 1 ? "+" : ""}${coord.toFixed(2)}`;
}

function fmtUsdExact(n) {
  if (!Number.isFinite(n)) return "?";
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatPoolPosition(position, transition) {
  const prefix = position.inRange ? "✅ " : "🔴 ";
  let status = position.inRange ? "IN RANGE" : "OUT OF RANGE";
  if (!position.isFullRange) {
    status += formatRangeCoord(position);
  }
  if (transition) {
    status += position.inRange ? " (was out of range)" : " (was in range)";
  }
  const range = position.isFullRange
    ? "Full range"
    : `Range: ${formatPoolPrice(position.lowerPrice)} — ${formatPoolPrice(position.upperPrice)} ${position.priceLabel}`;
  const money = Number.isFinite(position.valueUsd) || Number.isFinite(position.pendingFeesUsd)
    ? `\nDeposited: ${fmtUsdExact(position.valueUsd)} · Fees: ${fmtUsdExact(position.pendingFeesUsd)}`
    : "";
  return `${prefix}${position.pool}:\nStatus: ${status}\n${range}${money}`;
}

function fmtUsd(n) {
  if (!Number.isFinite(n)) return "?";
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${Math.round(n)}`;
}

function formatLpPool(c, i) {
  const name = c.url ? `[${c.symbol}](${c.url})` : c.symbol;
  const scoreVal = c.score >= 0 ? c.score.toFixed(2) : "?";
  return (
    `${i + 1}. ${name}  ${c.feeLabel} ${c.version} · ${c.chain}\n` +
    `score *${scoreVal}* · 30d ${fmtUsd(c.vol30d)} · TVL ${fmtUsd(c.tvl)}`
  );
}

function formatLpList(pools) {
  return pools.length ? pools.map(formatLpPool).join("\n\n") : "none";
}

// Three messages (chains, BTC, ETH) — keeps each under Telegram's size limit
// and reads better on mobile.
function formatTopLpMessages(result, title) {
  const chainsList = result.chains.map((c, i) => `${i + 1}. ${c.name} — ${fmtUsd(c.tvl)}`).join("\n");
  return [
    `*${title} — score = 30d vol / TVL × fee%*\n\nTop chains by TVL:\n${chainsList}`,
    `*BTC / stablecoin*\n\n${formatLpList(result.btc)}`,
    `*ETH / stablecoin*\n\n${formatLpList(result.eth)}`
  ];
}

function fmtNum(n) {
  if (!Number.isFinite(n)) return "?";
  return Math.round(n).toLocaleString("en-US");
}

function fmtTrx(n) {
  if (!Number.isFinite(n)) return "?";
  return (Math.round(n * 100) / 100).toLocaleString("en-US");
}

function formatTronResources(res, now = Date.now()) {
  const lines = [
    `⚡ Energy: ${fmtNum(res.energyFree)} / ${fmtNum(res.energyTotal)} free`,
    `📶 Bandwidth: ${fmtNum(res.bandwidthFree)} / ${fmtNum(res.bandwidthTotal)} free`
  ];

  if (res.hasDelegation) {
    const parts = [];
    if (res.delegatedEnergy > 0) {
      parts.push(`${fmtNum(res.delegatedEnergy)} energy (${fmtTrx(res.delegatedEnergyTrx)} TRX)`);
    }
    if (res.delegatedBandwidth > 0) {
      parts.push(`${fmtNum(res.delegatedBandwidth)} bandwidth (${fmtTrx(res.delegatedBandwidthTrx)} TRX)`);
    }
    lines.push(`Delegated out: ${parts.join(", ") || "yes"}`);

    const { reclaimableNow, nextReclaimAt } = tronReclaimInfo(res, now);
    if (reclaimableNow) {
      lines.push("Reclaimable: now ✅");
    } else if (nextReclaimAt) {
      const days = Math.ceil((nextReclaimAt - now) / 86400000);
      lines.push(`Reclaimable: ${new Date(nextReclaimAt).toISOString().slice(0, 10)} (in ${days} day${days === 1 ? "" : "s"})`);
    }
  } else {
    lines.push("Delegated out: none");
  }

  return lines.join("\n");
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
    [
      Markup.button.callback("Top LP", "action:toplp"),
      Markup.button.callback("Top LP (L2)", "action:toplpl2")
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
    [Markup.button.callback(`Warning Supply APY: ${d.warningSupplyRate}%`, "def:set:wsr")],
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
    [Markup.button.callback(`Warning Supply APY: ${t.warningSupplyRate}%`, "wallet:set:wsr")],
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
    `Danger Rate: ${t.dangerBorrowRate}%${mark("dangerBorrowRate")}`,
    `Warning Supply APY: ${t.warningSupplyRate}%${mark("warningSupplyRate")}`
  ].join("\n");
}

const PLATFORM_LABELS = {
  kamino: "*KAMINO*",
  aave: "*AAVE*",
  fluid: "*FLUID*",
  orca: "*ORCA*",
  uniswap: "*UNISWAP*",
  tron: "*TRON*"
};

function formatResultsByWallet(resultsByWallet) {
  const output = [];
  const protocolsOrder = ["kamino", "aave", "fluid", "orca", "uniswap", "tron"];
  for (const [wallet, protocols] of resultsByWallet.entries()) {
    const protocolKeys = Object.keys(protocols);
    if (protocolKeys.length === 0) continue;
    output.push(`\`${wallet}\``);
    protocolKeys.sort((a, b) => {
      const aIdx = protocolsOrder.indexOf(a);
      const bIdx = protocolsOrder.indexOf(b);
      if (aIdx === -1 && bIdx === -1) return a.localeCompare(b);
      if (aIdx === -1) return 1;
      if (bIdx === -1) return -1;
      return aIdx - bIdx;
    });
    for (const protocol of protocolKeys) {
      const label = PLATFORM_LABELS[protocol] || `*${protocol.toUpperCase()}*`;
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
  if (walletType === "tron") {
    return addTronWallet(ctx, wallet);
  }
  const protocol = walletType === "evm" ? "aave" : "kamino";
  const statusMsg = await ctx.reply(protocol === "aave" ? "Checking Aave..." : "Scanning all markets...");
  try {
    const result = await addWalletCore(chatId, wallet, {
      onKaminoProgress: (marketCheck) => {
        editMessage(ctx, statusMsg.message_id, `Scanning market ${marketCheck.current + 1} of ${marketCheck.total}...`);
      }
    });
    await deleteMessage(ctx, statusMsg.message_id);
    if (result.empty) {
      return ctx.reply("No positions found for this wallet");
    }
    const user = await getUser(chatId);
    const threshold = getWalletThresholds(user, wallet).warningSupplyRate;
    const lines = result.positions.map(p => formatPosition({ user, wallet, position: p }));
    lines.push(...result.supplies.map(s => formatSupplyPosition(s, threshold)));
    lines.push(...result.pools.map(p => formatPoolPosition(p)));
    ctx.reply(`Wallet added!\n\n\`${wallet}\`\n\n${lines.join("\n")}`, { parse_mode: "Markdown" });
  } catch (error) {
    await deleteMessage(ctx, statusMsg.message_id);
    logger.error({ chatId, wallet, error: error.message }, "Failed to add wallet");
    if (error.stage === "save") {
      return ctx.reply(`Scanned ${formatWalletLabel(wallet)} but couldn't save it — please try again.`);
    }
    ctx.reply(`Error: ${error.message}`);
  }
}

async function addTronWallet(ctx, wallet) {
  const chatId = String(ctx.chat.id);
  const statusMsg = await ctx.reply("Checking Tron resources...");
  try {
    const result = await addWalletCore(chatId, wallet);
    await deleteMessage(ctx, statusMsg.message_id);
    logger.info({ chatId, wallet }, "Tron wallet added");
    ctx.reply(`Wallet added!\n\n\`${wallet}\`\n\n*TRON*\n${formatTronResources(result.tron)}`, { parse_mode: "Markdown" });
  } catch (error) {
    await deleteMessage(ctx, statusMsg.message_id);
    logger.error({ chatId, wallet, error: error.message }, "Failed to add Tron wallet");
    if (error.stage === "save") {
      return ctx.reply(`Checked ${formatWalletLabel(wallet)} but couldn't save it — please try again.`);
    }
    ctx.reply(`Error: ${error.message}`);
  }
}

const ADD_BATCH_SIZE = 5;

// Accepts one or many addresses (whitespace / newline / comma separated) and adds
// each. Unrecognised tokens are ignored. Parallel in batches so a pasted list is
// added quickly; each add is an atomic per-row UPSERT, so concurrent commits don't
// race, and addWallet swallows its own errors so one failure can't sink the batch.
async function addWallets(ctx, rawText, opts = {}) {
  const tokens = String(rawText || "").split(/[\s,]+/).map((w) => w.trim()).filter(Boolean);
  const wallets = [...new Set(tokens.filter((w) => detectWalletType(w) !== "unknown"))];

  if (wallets.length === 0) {
    if (!opts.silentIfNone) await ctx.reply("Send a wallet address (or several, one per line)");
    return;
  }
  if (wallets.length === 1) {
    return addWallet(ctx, wallets[0]);
  }

  await ctx.reply(`Adding ${wallets.length} wallets...`);
  for (let i = 0; i < wallets.length; i += ADD_BATCH_SIZE) {
    await Promise.all(wallets.slice(i, i + ADD_BATCH_SIZE).map((w) => addWallet(ctx, w)));
  }
}

async function removeWallet(ctx, wallet) {
  if (!wallet) {
    return ctx.reply("Usage: /remove <wallet_address>");
  }
  const chatId = String(ctx.chat.id);
  const user = await getUser(chatId);
  if (!user || !user.wallets || !user.wallets[wallet]) {
    return ctx.reply("Wallet not found");
  }
  await deleteWallet(chatId, wallet);
  logger.info({ chatId, wallet }, "Wallet removed");
  ctx.reply(`Wallet removed\n\n\`${wallet}\``, { parse_mode: "Markdown" });
}

// One wallet's full scan: lending, supplies and pools run concurrently; results
// are merged into buckets in a fixed order afterwards (lending cards first, then
// deposits, then pools) so the output is deterministic despite the parallelism.
async function scanWalletForCheck(user, wallet, walletData, includePools) {
  const protocol = walletData.protocol || "kamino";
  const markets = walletData.markets || [];
  const totals = { supplyUsd: 0, supplyCount: 0, lpValueUsd: 0, lpFeesUsd: 0, lpCount: 0 };

  if (protocol === "tron") {
    try {
      const res = await getTronResources(wallet);
      return { buckets: { tron: [formatTronResources(res)] }, totals };
    } catch (error) {
      logger.error({ wallet, error: error.message }, "Tron check failed");
      return { buckets: { tron: [`Error: ${error.message}`] }, totals };
    }
  }

  let lendingLines = null;
  let supplies = [];
  let pools = [];
  let poolError = null;

  await Promise.all([
    (async () => {
      try {
        if (protocol === "kamino" && markets.length === 0) {
          lendingLines = ["No markets cached. Use Refresh All"];
          return;
        }
        const positions =
          protocol === "aave" ? await checkAaveMarkets(wallet) : await checkSpecificMarkets(wallet, markets);
        if (positions && positions.length > 0) {
          lendingLines = positions.map(p => formatPosition({ user, wallet, position: p }));
        }
      } catch (error) {
        logger.error({ wallet, error: error.message }, "Check failed");
        lendingLines = [`Error: ${error.message}`];
      }
    })(),
    (async () => {
      if (!includePools) return;
      try {
        supplies = (await scanSuppliesForWallet(wallet)).positions;
      } catch (error) {
        logger.error({ wallet, error: error.message }, "Supply check failed");
      }
    })(),
    (async () => {
      if (!includePools) return;
      try {
        pools = (await scanPoolsForWallet(wallet)).positions;
      } catch (error) {
        logger.error({ wallet, error: error.message }, "Pool check failed");
        poolError = error.message;
      }
    })()
  ]);

  const buckets = {};
  if (lendingLines) buckets[protocol] = lendingLines;

  const threshold = getWalletThresholds(user, wallet).warningSupplyRate;
  for (const supply of supplies) {
    (buckets[supply.platform] ||= []).push(formatSupplyPosition(supply, threshold));
    totals.supplyCount += 1;
    if (Number.isFinite(supply.amountUsd)) totals.supplyUsd += supply.amountUsd;
  }

  if (poolError) {
    const platform = detectWalletType(wallet) === "solana" ? "orca" : "uniswap";
    buckets[platform] = [`Error: ${poolError}`];
  } else if (pools.length > 0) {
    buckets[pools[0].platform] = pools.map(p => formatPoolPosition(p));
    for (const pool of pools) {
      totals.lpCount += 1;
      if (Number.isFinite(pool.valueUsd)) totals.lpValueUsd += pool.valueUsd;
      if (Number.isFinite(pool.pendingFeesUsd)) totals.lpFeesUsd += pool.pendingFeesUsd;
    }
  }

  return { buckets, totals };
}

async function checkWallets(ctx, user, protocolFilter) {
  const includePools = !protocolFilter || protocolFilter === "all";
  const wallets = Object.entries(user.wallets || {}).filter(([_, data]) => {
    if (!protocolFilter || protocolFilter === "all") return true;
    return (data.protocol || "kamino") === protocolFilter;
  });
  if (wallets.length === 0) {
    return ctx.reply("No wallets configured");
  }
  const statusMsg = await ctx.reply("Checking...");

  // All wallets scanned in parallel (and each wallet's sources in parallel too):
  // sequential scanning used to overrun Telegraf's handler timeout on /checkall.
  const results = await Promise.all(
    wallets.map(([wallet, walletData]) => scanWalletForCheck(user, wallet, walletData, includePools))
  );

  const grouped = new Map();
  const lpTotals = { valueUsd: 0, feesUsd: 0, count: 0 };
  const supplyTotals = { usd: 0, count: 0 };
  wallets.forEach(([wallet], index) => {
    const { buckets, totals } = results[index];
    grouped.set(wallet, buckets);
    supplyTotals.count += totals.supplyCount;
    supplyTotals.usd += totals.supplyUsd;
    lpTotals.count += totals.lpCount;
    lpTotals.valueUsd += totals.lpValueUsd;
    lpTotals.feesUsd += totals.lpFeesUsd;
  });

  await deleteMessage(ctx, statusMsg.message_id);
  let text = formatResultsByWallet(grouped);
  if (text && supplyTotals.count > 0) {
    text +=
      `\n\n💰 *Deposits total (${supplyTotals.count} position${supplyTotals.count === 1 ? "" : "s"})*\n` +
      `Supplied: ${fmtUsdExact(supplyTotals.usd)}`;
  }
  if (text && lpTotals.count > 0) {
    text +=
      `\n\n💧 *LP total (${lpTotals.count} position${lpTotals.count === 1 ? "" : "s"})*\n` +
      `Deposited: ${fmtUsdExact(lpTotals.valueUsd)} · Pending fees: ${fmtUsdExact(lpTotals.feesUsd)}`;
  }
  ctx.reply(text || "No positions found", { parse_mode: "Markdown" });
}

async function refreshMarketsForUser(ctx, user, protocolFilter) {
  const wallets = Object.entries(user.wallets || {}).filter(([_, data]) => {
    if (!protocolFilter || protocolFilter === "all") return true;
    return (data.protocol || "kamino") === protocolFilter;
  });
  if (wallets.length === 0) {
    return ctx.reply("No wallets configured");
  }
  const chatId = String(ctx.chat.id);
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
      const marketNames = (positions || []).map(p => p.market);
      walletData.markets = marketNames;
      await setWalletMarkets(chatId, wallet, marketNames);
      if (!grouped.has(wallet)) grouped.set(wallet, {});
      grouped.get(wallet)[protocol] = positions && positions.length > 0
        ? positions.map(p => formatPosition({ user, wallet, position: p }))
        : ["No positions found"];
    } catch (error) {
      logger.error({ wallet, error: error.message }, "Refresh failed");
      if (!grouped.has(wallet)) grouped.set(wallet, {});
      grouped.get(wallet)[walletData.protocol || "kamino"] = [`Error: ${error.message}`];
    }
  }
  await deleteMessage(ctx, statusMsg.message_id);
  ctx.reply(`Markets refreshed\n\n${formatResultsByWallet(grouped)}`, { parse_mode: "Markdown" });
}

bot.start((ctx) => {
  ctx.reply(
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
    "/toplpl2 - same, excluding Ethereum L1 (lower gas chains only)"
  );
});

bot.command("menu", (ctx) => {
  ctx.reply("Menu", mainMenu());
});

bot.command("checkall", async (ctx) => {
  const chatId = String(ctx.chat.id);
  const user = await ensureUser(chatId);
  await checkWallets(ctx, user, "all");
});

async function runTopLp(ctx, options, title) {
  const statusMsg = await ctx.reply("Scanning top chains & Uniswap pools...");
  try {
    const result = await getTopLpPools(options);
    await deleteMessage(ctx, statusMsg.message_id);
    for (const msg of formatTopLpMessages(result, title)) {
      await ctx.reply(msg, { parse_mode: "Markdown", disable_web_page_preview: true });
    }
  } catch (error) {
    await deleteMessage(ctx, statusMsg.message_id);
    logger.error({ error: error.message }, "Top LP failed");
    await ctx.reply(`Error: ${error.message}`);
  }
}

bot.command("toplp", (ctx) => runTopLp(ctx, {}, "Top LP"));
bot.command("toplpl2", (ctx) => runTopLp(ctx, { excludeChains: ["Ethereum"] }, "Top LP (L2 only)"));

bot.action("action:toplp", async (ctx) => {
  await ctx.answerCbQuery();
  await runTopLp(ctx, {}, "Top LP");
});

bot.action("action:toplpl2", async (ctx) => {
  await ctx.answerCbQuery();
  await runTopLp(ctx, { excludeChains: ["Ethereum"] }, "Top LP (L2 only)");
});

bot.action("menu:main", async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText("Menu", mainMenu());
});

bot.action("menu:settings", async (ctx) => {
  await ctx.answerCbQuery();
  const chatId = String(ctx.chat.id);
  const user = await ensureUser(chatId);
  await ctx.editMessageText(
    "Global default thresholds.\nApplied to wallets that don't override them.",
    settingsMenu(user)
  );
});

bot.action("menu:wallets", async (ctx) => {
  await ctx.answerCbQuery();
  const chatId = String(ctx.chat.id);
  const user = await ensureUser(chatId);
  ctx.session.walletMenu = Object.keys(user.wallets || {});
  await ctx.editMessageText("Wallets", walletMenu(user));
});

bot.action(/menu:protocol:(.+)/, async (ctx) => {
  await ctx.answerCbQuery();
  const protocol = ctx.match[1];
  await ctx.editMessageText(`${protocol.toUpperCase()} menu`, protocolMenu(protocol));
});

bot.action(/action:check:(.+)/, async (ctx) => {
  await ctx.answerCbQuery();
  const protocol = ctx.match[1];
  const chatId = String(ctx.chat.id);
  const user = await ensureUser(chatId);
  await checkWallets(ctx, user, protocol);
});

bot.action(/action:refresh:(.+)/, async (ctx) => {
  await ctx.answerCbQuery();
  const protocol = ctx.match[1];
  const chatId = String(ctx.chat.id);
  const user = await ensureUser(chatId);
  await refreshMarketsForUser(ctx, user, protocol);
});

bot.action("action:addwallet", async (ctx) => {
  await ctx.answerCbQuery();
  ctx.session.pending = { action: "addwallet" };
  await ctx.reply("Send wallet address to add (or several, one per line)");
});

bot.action(/wallet:open:(\d+)/, async (ctx) => {
  await ctx.answerCbQuery();
  const chatId = String(ctx.chat.id);
  const user = await ensureUser(chatId);
  const index = Number(ctx.match[1]);
  const wallet = ctx.session.walletMenu?.[index];
  if (!wallet || !user.wallets[wallet]) {
    return ctx.reply("Wallet not found");
  }
  ctx.session.currentWallet = wallet;
  await ctx.editMessageText(formatWalletSettings(user, wallet), {
    parse_mode: "Markdown",
    ...walletSettingsMenu(user, wallet)
  });
});

bot.action(/wallet:remove:(\d+)/, async (ctx) => {
  await ctx.answerCbQuery();
  const chatId = String(ctx.chat.id);
  const index = Number(ctx.match[1]);
  const wallet = ctx.session.walletMenu?.[index];
  if (!wallet) {
    return ctx.reply("Wallet not found");
  }
  await removeWallet(ctx, wallet);
  const user = await ensureUser(chatId);
  ctx.session.walletMenu = Object.keys(user.wallets || {});
  await ctx.editMessageText("Wallets", walletMenu(user));
});

bot.action(/wallet:set:(whf|dhf|wbr|dbr|wsr)/, async (ctx) => {
  await ctx.answerCbQuery();
  const chatId = String(ctx.chat.id);
  const user = await ensureUser(chatId);
  const field = ctx.match[1];
  const wallet = ctx.session.currentWallet;
  if (!wallet || !user.wallets[wallet]) {
    return ctx.reply("Wallet not found");
  }
  ctx.session.pending = { action: "setwallet", field, wallet };
  await ctx.reply(`Send ${THRESHOLD_FIELDS[field].label} for ${formatWalletLabel(wallet)}`);
});

bot.action("wallet:reset", async (ctx) => {
  await ctx.answerCbQuery();
  const chatId = String(ctx.chat.id);
  const user = await ensureUser(chatId);
  const wallet = ctx.session.currentWallet;
  if (!wallet || !user.wallets[wallet]) {
    return ctx.reply("Wallet not found");
  }
  await resetWalletThresholds(chatId, wallet);
  user.wallets[wallet].settings = {};
  await ctx.editMessageText(formatWalletSettings(user, wallet), {
    parse_mode: "Markdown",
    ...walletSettingsMenu(user, wallet)
  });
});

bot.action("wallet:back", async (ctx) => {
  await ctx.answerCbQuery();
  const chatId = String(ctx.chat.id);
  const user = await ensureUser(chatId);
  ctx.session.walletMenu = Object.keys(user.wallets || {});
  await ctx.editMessageText("Wallets", walletMenu(user));
});

bot.action(/def:set:(whf|dhf|wbr|dbr|wsr)/, async (ctx) => {
  await ctx.answerCbQuery();
  const field = ctx.match[1];
  ctx.session.pending = { action: "setdefault", field };
  await ctx.reply(`Send ${THRESHOLD_FIELDS[field].label} (global default)`);
});

bot.on("text", async (ctx, next) => {
  const text = ctx.message.text;
  if (text.startsWith("/")) return next();
  const chatId = String(ctx.chat.id);
  const pending = ctx.session.pending;

  if (pending?.action === "addwallet") {
    ctx.session.pending = null;
    return addWallets(ctx, text);
  }

  if (pending?.action === "setwallet" || pending?.action === "setdefault") {
    const value = parseFloat(text);
    const field = THRESHOLD_FIELDS[pending.field];
    if (!field) {
      ctx.session.pending = null;
      return ctx.reply("Unknown setting");
    }
    if (!Number.isFinite(value) || value <= 0) {
      return ctx.reply("Send a positive number");
    }

    ctx.session.pending = null;

    if (pending.action === "setdefault") {
      await setGlobalThreshold(chatId, field.key, value);
      logger.info({ chatId, field: field.key, value }, "Global default set");
      return ctx.reply(`Default ${field.label} set to ${formatThresholdValue(field, value)}`);
    }

    const wallet = pending.wallet;
    const user = await ensureUser(chatId);
    if (!wallet || !user.wallets[wallet]) {
      return ctx.reply("Wallet not found");
    }
    await setWalletThreshold(chatId, wallet, field.key, value);
    logger.info({ chatId, wallet, field: field.key, value }, "Wallet threshold set");
    return ctx.reply(`${field.label} for ${formatWalletLabel(wallet)} set to ${formatThresholdValue(field, value)}`);
  }

  // No pending step — a plain message containing wallet address(es) is an add.
  return addWallets(ctx, text, { silentIfNone: true });
});

async function refreshMarketsBackground() {
  try {
    await fetchMarkets();
    await fetchAaveMarketsAll();
  } catch (error) {
    logger.error({ error: error.message }, "Failed to refresh markets in background");
  }
}

async function checkLendingForWallet(chatId, user, wallet, walletData) {
  const protocol = walletData.protocol || "kamino";
  const markets = walletData.markets || [];
  const thresholds = getWalletThresholds(user, wallet);

  if (protocol === "kamino" && markets.length === 0) return;

  let positions;
  if (protocol === "aave") {
    positions = await checkAaveMarkets(wallet);
  } else {
    positions = await checkSpecificMarkets(wallet, markets);
  }

  if (!positions || positions.length === 0) return;

  const breaching = positions.filter(
    (p) => positionSeverity(thresholds, p.healthFactor, p.borrowRate) >= 1
  );
  if (breaching.length === 0) return;

  logger.info(
    { chatId, wallet, protocol, breaching: breaching.map((p) => p.market), thresholds },
    "Threshold breached"
  );

  const grouped = new Map();
  grouped.set(wallet, {
    [protocol]: positions.map((p) => formatPosition({ user, wallet, position: p }))
  });
  await bot.telegram.sendMessage(chatId, formatResultsByWallet(grouped), { parse_mode: "Markdown" });
}

// A position missing from this scan because its source (chain/network) failed must
// keep its previous alert state — pruning it would silently re-seed the baseline on
// recovery and swallow any threshold/range crossing that happened around the outage.
function carryOverFailedSources(next, previous, failures) {
  if (failures.length === 0) return;
  for (const [id, state] of Object.entries(previous)) {
    if (id in next) continue;
    if (failures.some((prefix) => id.startsWith(prefix))) next[id] = state;
  }
}

// Notify only when a pool position crosses the range boundary (in <-> out).
// First sighting of a position just records the baseline state silently.
async function checkPoolsForWallet(chatId, wallet, walletData) {
  const { positions: pools, failures } = await scanPoolsForWallet(wallet);
  const previous = walletData.poolStates || {};
  const next = {};
  const transitions = [];
  const seeded = [];

  for (const pool of pools) {
    next[pool.id] = pool.inRange;
    if (!(pool.id in previous)) {
      seeded.push(`${pool.pool} = ${pool.inRange ? "in" : "out"}`);
    } else if (previous[pool.id] !== pool.inRange) {
      transitions.push(pool);
    }
  }
  carryOverFailedSources(next, previous, failures);

  if (seeded.length > 0) {
    logger.info({ chatId, wallet, seeded }, "Pool baseline recorded");
  }

  if (transitions.length > 0) {
    logger.info(
      { chatId, wallet, transitions: transitions.map((p) => `${p.pool} -> ${p.inRange ? "in" : "out"}`) },
      "Pool range transition"
    );

    const grouped = new Map();
    for (const pool of transitions) {
      if (!grouped.has(wallet)) grouped.set(wallet, {});
      const protocols = grouped.get(wallet);
      if (!protocols[pool.platform]) protocols[pool.platform] = [];
      protocols[pool.platform].push(formatPoolPosition(pool, true));
    }
    // Send BEFORE persisting the new state: if sending fails (throws), the old
    // state is kept and the transition fires again on the next cycle.
    await bot.telegram.sendMessage(chatId, formatResultsByWallet(grouped), { parse_mode: "Markdown" });
  }

  if (JSON.stringify(next) !== JSON.stringify(previous)) {
    await setWalletPoolStates(chatId, wallet, next);
  }
}

// Notify only when a deposit's APY crosses the warning threshold (below <-> above).
// First sighting of a position just records the baseline state silently.
async function checkSuppliesForWallet(chatId, user, wallet, walletData) {
  const { positions: supplies, failures } = await scanSuppliesForWallet(wallet);
  const threshold = getWalletThresholds(user, wallet).warningSupplyRate;
  const previous = walletData.supplyStates || {};
  const next = {};
  const transitions = [];
  const seeded = [];

  for (const supply of supplies) {
    const below = isSupplyBelow(supply, threshold);
    next[supply.id] = below;
    if (!(supply.id in previous)) {
      seeded.push(`${supply.asset} = ${below ? "below" : "ok"}`);
    } else if (previous[supply.id] !== below) {
      transitions.push(supply);
    }
  }
  carryOverFailedSources(next, previous, failures);

  if (seeded.length > 0) {
    logger.info({ chatId, wallet, seeded }, "Supply baseline recorded");
  }

  if (transitions.length > 0) {
    logger.info(
      { chatId, wallet, threshold, transitions: transitions.map((s) => `${s.asset} @ ${s.supplyApy}%`) },
      "Supply APY transition"
    );

    const grouped = new Map();
    grouped.set(wallet, {});
    const protocols = grouped.get(wallet);
    for (const supply of transitions) {
      (protocols[supply.platform] ||= []).push(formatSupplyPosition(supply, threshold, true));
    }
    // Send BEFORE persisting the new state: if sending fails (throws), the old
    // state is kept and the transition fires again on the next cycle.
    await bot.telegram.sendMessage(chatId, formatResultsByWallet(grouped), { parse_mode: "Markdown" });
  }

  if (JSON.stringify(next) !== JSON.stringify(previous)) {
    await setWalletSupplyStates(chatId, wallet, next);
  }
}

async function checkAllUsers() {
  try {
    for (const [chatId, user] of await getAllUsers()) {
      logger.info({ chatId }, "Checking user positions on background");

      if (!user.wallets) continue;

      for (const [wallet, walletData] of Object.entries(user.wallets)) {
        if ((walletData.protocol || "") === "tron") continue; // Tron has its own slower loop
        try {
          await checkLendingForWallet(chatId, user, wallet, walletData);
        } catch (error) {
          logger.error({ chatId, wallet, error: error.message }, "Check failed");
        }
        try {
          await checkSuppliesForWallet(chatId, user, wallet, walletData);
        } catch (error) {
          // Keep previous supplyStates on scan failure to avoid phantom transitions.
          logger.error({ chatId, wallet, error: error.message }, "Supply check failed");
        }
        try {
          await checkPoolsForWallet(chatId, wallet, walletData);
        } catch (error) {
          // Keep previous poolStates on scan failure to avoid phantom transitions.
          logger.error({ chatId, wallet, error: error.message }, "Pool check failed");
        }
      }
    }
  } catch (error) {
    logger.error({ error: error.message }, "Background check cycle failed");
  }
}

// Notify on transition into an actionable state (false -> true):
// - reclaim:  a delegation unlocked and there's bandwidth to reclaim it
// - delegate: resources are free and nothing is delegated
// First sighting just records the baseline silently (the add/check output
// already shows the current state).
async function checkTronForWallet(chatId, wallet, walletData) {
  const res = await getTronResources(wallet);
  const flags = computeTronFlags(res);
  const prev = walletData.tronState;

  if (!prev) {
    await setWalletTronState(chatId, wallet, flags);
    logger.info({ chatId, wallet, flags }, "Tron baseline recorded");
    return;
  }

  const notes = [];
  if (flags.reclaim && !prev.reclaim) {
    notes.push("🔓 Resources ready to reclaim (delegation unlocked)");
  }
  if (flags.delegate && !prev.delegate) {
    notes.push("🟢 Resources free to delegate");
  }

  if (notes.length > 0) {
    logger.info({ chatId, wallet, notes }, "Tron transition");
    const body = `\`${wallet}\`\n\n*TRON*\n${notes.join("\n")}\n\n${formatTronResources(res)}`;
    // Send before persisting: a failed send (throws) keeps the old state so it retries.
    await bot.telegram.sendMessage(chatId, body, { parse_mode: "Markdown" });
  }

  if (prev.reclaim !== flags.reclaim || prev.delegate !== flags.delegate) {
    await setWalletTronState(chatId, wallet, flags);
  }
}

async function checkAllTron() {
  try {
    for (const [chatId, user] of await getAllUsers()) {
      if (!user.wallets) continue;
      for (const [wallet, walletData] of Object.entries(user.wallets)) {
        if ((walletData.protocol || "") !== "tron") continue;
        try {
          await checkTronForWallet(chatId, wallet, walletData);
        } catch (error) {
          logger.error({ chatId, wallet, error: error.message }, "Tron check failed");
        }
      }
    }
  } catch (error) {
    logger.error({ error: error.message }, "Tron check cycle failed");
  }
}

async function init() {
  await initDb();

  try {
    await fetchMarkets();
    await fetchAaveMarketsAll();
  } catch (error) {
    logger.error({ error: error.message }, "Failed to load markets on startup");
  }

  setInterval(refreshMarketsBackground, CHECK_INTERVAL);
  setInterval(checkAllUsers, CHECK_INTERVAL);
  setInterval(checkAllTron, TRON_CHECK_INTERVAL);

  try {
    await bot.telegram.setMyCommands([
      { command: "menu", description: "Open menu" },
      { command: "checkall", description: "Check all positions (lending + pools + Tron)" },
      { command: "toplp", description: "Top Uniswap LP pools (BTC/ETH vs stables) by 30d vol/TVL x fee" },
      { command: "toplpl2", description: "Top LP excluding Ethereum L1 (L2/sidechains only)" }
    ]);
  } catch (error) {
    logger.error({ error: error.message }, "Failed to set bot commands");
  }

  const userCount = await getUserCount();
  if (userCount > 0) {
    logger.info({ count: userCount }, "Users loaded");
    setTimeout(checkAllUsers, 5000);
    setTimeout(checkAllTron, 15000);
  }

  // Mini App: HTTP API + static bundle in the same process (bot stays on long polling).
  startWebServer(BOT_TOKEN);
  if (process.env.WEBAPP_URL) {
    try {
      await bot.telegram.setChatMenuButton({
        menuButton: { type: "web_app", text: "App", web_app: { url: process.env.WEBAPP_URL } }
      });
      logger.info({ url: process.env.WEBAPP_URL }, "Menu button set to Mini App");
    } catch (error) {
      logger.error({ error: error.message }, "Failed to set Mini App menu button");
    }
  }

  bot.launch();
  logger.info("Bot started");
}

init();

async function shutdown(signal) {
  logger.info(`Shutting down (${signal})`);
  bot.stop(signal);
  try {
    await closeDb();
  } catch (error) {
    logger.error({ error: error.message }, "Error closing DB pool");
  }
  process.exit(0);
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));

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
