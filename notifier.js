import { logger } from "./logger.js";

// Pushes a structured notification event to the bot microservice, which renders
// it and sends the Telegram message. MUST throw on failure: the alert loops rely
// on send-before-persist — a failed delivery keeps the previous alert state so
// the transition fires again on the next cycle.
const BOT_URL = process.env.BOT_URL;
const INTERNAL_TOKEN = process.env.INTERNAL_TOKEN;

export async function sendNotification(chatId, event) {
  if (!BOT_URL) throw new Error("BOT_URL not set — cannot deliver notification");
  const response = await fetch(`${BOT_URL.replace(/\/$/, "")}/notify`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Internal ${INTERNAL_TOKEN || ""}`
    },
    body: JSON.stringify({ chatId, event }),
    signal: AbortSignal.timeout(30000)
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Notify failed: ${response.status} ${body.slice(0, 200)}`);
  }
  logger.info({ chatId, type: event.type }, "Notification delivered");
}
