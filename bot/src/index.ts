// Bootstrap: env validation, notify HTTP listener (started BEFORE the Telegram
// launch so the core can reach /notify even while Telegram is flaky), bot
// wiring, launch and graceful shutdown.

import { Telegraf, session } from "telegraf";
import { CoreApi } from "./api.js";
import { BOT_COMMANDS, registerHandlers } from "./handlers.js";
import { createNotifyApp } from "./notify.js";
import { createSessionStore, type BotContext, type SessionData } from "./session.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} not set`);
    process.exit(1);
  }
  return value;
}

const BOT_TOKEN = requireEnv("BOT_TOKEN");
const CORE_URL = requireEnv("CORE_URL");
const INTERNAL_TOKEN = requireEnv("INTERNAL_TOKEN");
const PORT = Number(process.env.PORT) || 3100;
const WEBAPP_URL = process.env.WEBAPP_URL;

const api = new CoreApi(CORE_URL, INTERNAL_TOKEN);
const bot = new Telegraf<BotContext>(BOT_TOKEN);

// Transient per-chat UI state ({pending, walletMenu, currentWallet}) lives in
// ctx.session, backed by an in-memory Map keyed per chat.
bot.use(session({ defaultSession: (): SessionData => ({}), store: createSessionStore() }));
registerHandlers(bot, api);
bot.catch((error, ctx) => {
  console.error(`Bot handler error (update ${ctx.update.update_id}):`, error);
});

// Start the notify listener first: the core must be able to push alerts (and
// get an honest 502 back) independently of Telegram connectivity.
const app = createNotifyApp(bot.telegram, INTERNAL_TOKEN);
const server = app.listen(PORT, () => {
  console.log(`Notify server listening on :${PORT}`);
});

async function initTelegram(): Promise<void> {
  try {
    await bot.telegram.setMyCommands(BOT_COMMANDS);
  } catch (error) {
    console.error("Failed to set bot commands:", error instanceof Error ? error.message : error);
  }

  if (WEBAPP_URL) {
    try {
      await bot.telegram.setChatMenuButton({
        menuButton: { type: "web_app", text: "App", web_app: { url: WEBAPP_URL } }
      });
      console.log(`Menu button set to Mini App: ${WEBAPP_URL}`);
    } catch (error) {
      console.error("Failed to set Mini App menu button:", error instanceof Error ? error.message : error);
    }
  }

  // launch() resolves only when polling stops; the callback fires once the bot
  // is up. A rejection (e.g. invalid token) is handled below.
  await bot.launch(() => {
    console.log("Bot started");
  });
}

initTelegram().catch((error) => {
  console.error("Failed to launch bot:", error instanceof Error ? error.message : error);
  server.close();
  process.exit(1);
});

function shutdown(signal: string): void {
  console.log(`Shutting down (${signal})`);
  try {
    bot.stop(signal);
  } catch {
    // bot was never launched
  }
  server.close();
  process.exit(0);
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
