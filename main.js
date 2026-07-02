import { initDb, closeDb } from "./db.js";
import { fetchMarkets } from "./kamino.js";
import { fetchAaveMarketsAll } from "./aave.js";
import { startAlertLoops } from "./alerts.js";
import { startWebServer } from "./server.js";
import { logger } from "./logger.js";

// Monolith entry point: PostgreSQL + scanners + background alert loops + REST API
// (+ the Mini App bundle). Telegram rendering lives in the bot microservice; the
// bot token here is only used to validate webapp auth (initData / Login Widget).

const BOT_TOKEN = process.env.BOT_TOKEN;
const INTERNAL_TOKEN = process.env.INTERNAL_TOKEN;

if (!BOT_TOKEN) {
  logger.error("BOT_TOKEN not set (required to validate webapp auth)");
  process.exit(1);
}
if (!INTERNAL_TOKEN) {
  logger.error("INTERNAL_TOKEN not set (required for bot <-> core auth)");
  process.exit(1);
}

// The Login Widget needs the bot's username; resolve it once at boot.
async function getBotUsername() {
  try {
    const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getMe`, {
      signal: AbortSignal.timeout(15000)
    });
    const data = await response.json();
    if (data.ok && data.result?.username) return data.result.username;
    throw new Error(data.description || `getMe -> ${response.status}`);
  } catch (error) {
    logger.error({ error: error.message }, "getMe failed — /api/config will have no botUsername");
    return null;
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

  const botUsername = await getBotUsername();
  startWebServer({ botToken: BOT_TOKEN, internalToken: INTERNAL_TOKEN, botUsername });
  await startAlertLoops();

  logger.info("Core service started");
}

init();

async function shutdown(signal) {
  logger.info(`Shutting down (${signal})`);
  try {
    await closeDb();
  } catch (error) {
    logger.error({ error: error.message }, "Error closing DB pool");
  }
  process.exit(0);
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
