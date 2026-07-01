import { Telegraf, Markup, session } from "telegraf";
import { fetchMarkets, scanAllMarketsForWallet, checkSpecificMarkets } from "./kamino.js";
import { fetchAaveMarketsAll, scanAaveMarketsForWallet, checkAaveMarkets } from "./aave.js";
import { getOrcaPositionsForWallet } from "./orca.js";
import { getUniswapPositionsForWallet } from "./uniswap.js";
import { getTronResources, tronReclaimInfo, computeTronFlags } from "./tron.js";
import { getTopLpPools } from "./toplp.js";
import {
  initDb,
  closeDb,
  getUser,
  getAllUsers,
  getUserCount,
  upsertWallet,
  deleteWallet,
  setGlobalThreshold,
  setWalletThreshold,
  resetWalletThresholds,
  setWalletMarkets,
  setWalletPoolStates,
  setWalletTronState
} from "./db.js";
import { uiCache } from "./cache.js";
import { logger } from "./logger.js";

const BOT_TOKEN = process.env.BOT_TOKEN;

if (!BOT_TOKEN) {
  logger.error("BOT_TOKEN not set");
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

// Transient per-chat UI state (pending input, menu index, current wallet) lives in
// ctx.session, backed by the swappable keyv store (in-memory now, Redis via REDIS_URL).
bot.use(session({ store: uiCache, defaultSession: () => ({}) }));

const CHECK_INTERVAL = 10 * 60 * 1000;
const TRON_CHECK_INTERVAL = 60 * 60 * 1000;

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

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58Decode(str) {
  if (!str || /[^123456789A-HJ-NP-Za-km-z]/.test(str)) return null;
  let num = 0n;
  for (const ch of str) {
    num = num * 58n + BigInt(BASE58_ALPHABET.indexOf(ch));
  }
  const bytes = [];
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
function detectWalletType(address) {
  if (isEvmAddress(address)) return "evm";
  const bytes = base58Decode(address);
  if (bytes) {
    if (bytes.length === 25 && bytes[0] === 0x41) return "tron";
    if (bytes.length === 32) return "solana";
  }
  return "unknown";
}

// Durable data (wallets, settings) comes from Postgres. Transient UI state lives
// in ctx.session, so handlers read/write ctx.session.* directly (no manual save).
async function ensureUser(chatId) {
  const user = (await getUser(chatId)) || {};
  if (!user.wallets) user.wallets = {};
  if (!user.settings) user.settings = {};
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

// LP positions (Orca for Solana wallets, Uniswap V3 for EVM wallets).
async function scanPoolsForWallet(wallet) {
  const walletType = detectWalletType(wallet);
  if (walletType === "solana") return getOrcaPositionsForWallet(wallet);
  if (walletType === "evm") return getUniswapPositionsForWallet(wallet);
  return [];
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
  return `${prefix}${position.pool}:\nStatus: ${status}\n${range}`;
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

const PLATFORM_LABELS = {
  kamino: "*KAMINO*",
  aave: "*AAVE*",
  orca: "*ORCA*",
  uniswap: "*UNISWAP*",
  tron: "*TRON*"
};

function formatResultsByWallet(resultsByWallet) {
  const output = [];
  const protocolsOrder = ["kamino", "aave", "orca", "uniswap", "tron"];
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
    let positions;
    if (protocol === "aave") {
      positions = await scanAaveMarketsForWallet(wallet);
    } else {
      positions = await scanAllMarketsForWallet(wallet, (marketCheck) => {
        editMessage(ctx, statusMsg.message_id, `Scanning market ${marketCheck.current + 1} of ${marketCheck.total}...`);
      });
    }
    let pools = [];
    try {
      pools = await scanPoolsForWallet(wallet);
    } catch (error) {
      logger.error({ wallet, error: error.message }, "Pool scan failed on add");
    }
    await deleteMessage(ctx, statusMsg.message_id);
    if ((!positions || positions.length === 0) && pools.length === 0) {
      return ctx.reply("No positions found for this wallet");
    }
    const marketNames = (positions || []).map(p => p.market);
    const poolStates = {};
    for (const pool of pools) poolStates[pool.id] = pool.inRange;
    try {
      await upsertWallet(chatId, wallet, { protocol, markets: marketNames, poolStates });
    } catch (error) {
      logger.error({ chatId, wallet, error: error.message }, "Failed to save wallet");
      return ctx.reply(`Scanned ${formatWalletLabel(wallet)} but couldn't save it — please try again.`);
    }
    logger.info({ chatId, wallet, markets: marketNames, pools: pools.length }, "Wallet added");
    const user = await getUser(chatId);
    const lines = (positions || []).map(p => formatPosition({ user, wallet, position: p }));
    lines.push(...pools.map(p => formatPoolPosition(p)));
    ctx.reply(`Wallet added!\n\n\`${wallet}\`\n\n${lines.join("\n")}`, { parse_mode: "Markdown" });
  } catch (error) {
    await deleteMessage(ctx, statusMsg.message_id);
    logger.error({ chatId, wallet, error: error.message }, "Failed to add wallet");
    ctx.reply(`Error: ${error.message}`);
  }
}

async function addTronWallet(ctx, wallet) {
  const chatId = String(ctx.chat.id);
  const statusMsg = await ctx.reply("Checking Tron resources...");
  try {
    const res = await getTronResources(wallet);
    await deleteMessage(ctx, statusMsg.message_id);
    try {
      await upsertWallet(chatId, wallet, { protocol: "tron", tronState: computeTronFlags(res) });
    } catch (error) {
      logger.error({ chatId, wallet, error: error.message }, "Failed to save Tron wallet");
      return ctx.reply(`Checked ${formatWalletLabel(wallet)} but couldn't save it — please try again.`);
    }
    logger.info({ chatId, wallet }, "Tron wallet added");
    ctx.reply(`Wallet added!\n\n\`${wallet}\`\n\n*TRON*\n${formatTronResources(res)}`, { parse_mode: "Markdown" });
  } catch (error) {
    await deleteMessage(ctx, statusMsg.message_id);
    logger.error({ chatId, wallet, error: error.message }, "Failed to add Tron wallet");
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
  const grouped = new Map();
  for (const [wallet, walletData] of wallets) {
    if (!grouped.has(wallet)) grouped.set(wallet, {});
    const protocol = walletData.protocol || "kamino";
    const markets = walletData.markets || [];
    if (protocol === "tron") {
      try {
        const res = await getTronResources(wallet);
        grouped.get(wallet).tron = [formatTronResources(res)];
      } catch (error) {
        logger.error({ wallet, error: error.message }, "Tron check failed");
        grouped.get(wallet).tron = [`Error: ${error.message}`];
      }
      continue;
    }
    try {
      if (protocol === "kamino" && markets.length === 0) {
        grouped.get(wallet)[protocol] = ["No markets cached. Use Refresh All"];
      } else {
        let positions;
        if (protocol === "aave") {
          positions = await checkAaveMarkets(wallet);
        } else {
          positions = await checkSpecificMarkets(wallet, markets);
        }
        if (positions && positions.length > 0) {
          grouped.get(wallet)[protocol] = positions.map(p => formatPosition({ user, wallet, position: p }));
        }
      }
    } catch (error) {
      logger.error({ wallet, error: error.message }, "Check failed");
      grouped.get(wallet)[protocol] = [`Error: ${error.message}`];
    }
    if (includePools) {
      try {
        const pools = await scanPoolsForWallet(wallet);
        if (pools.length > 0) {
          const platform = pools[0].platform;
          grouped.get(wallet)[platform] = pools.map(p => formatPoolPosition(p));
        }
      } catch (error) {
        logger.error({ wallet, error: error.message }, "Pool check failed");
        const platform = detectWalletType(wallet) === "solana" ? "orca" : "uniswap";
        grouped.get(wallet)[platform] = [`Error: ${error.message}`];
      }
    }
  }
  await deleteMessage(ctx, statusMsg.message_id);
  const text = formatResultsByWallet(grouped);
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

bot.action(/wallet:set:(whf|dhf|wbr|dbr)/, async (ctx) => {
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

bot.action(/def:set:(whf|dhf|wbr|dbr)/, async (ctx) => {
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

// Notify only when a pool position crosses the range boundary (in <-> out).
// First sighting of a position just records the baseline state silently.
async function checkPoolsForWallet(chatId, wallet, walletData) {
  const pools = await scanPoolsForWallet(wallet);
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
