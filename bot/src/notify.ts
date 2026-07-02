// The bot's own HTTP listener. The core (monolith) pushes alert events here;
// the bot renders them with the same formatters as interactive replies and
// relays them to Telegram. 200 is returned ONLY when the Telegram send
// succeeded — the core keeps its alert state on non-200 and retries next cycle.

import express, { type Express } from "express";
import type { Telegram } from "telegraf";
import {
  formatPoolPosition,
  formatPosition,
  formatResultsByWallet,
  formatSupplyPosition,
  formatTronResources,
  type WalletBuckets
} from "./format.js";
import type { NotifyEvent, NotifyRequest } from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNotifyEvent(value: unknown): value is NotifyEvent {
  if (!isRecord(value) || typeof value["wallet"] !== "string") return false;
  switch (value["type"]) {
    case "lending-alert":
      return typeof value["protocol"] === "string" && Array.isArray(value["positions"]);
    case "supply-transition":
      return typeof value["threshold"] === "number" && Array.isArray(value["transitions"]);
    case "pool-transition":
      return Array.isArray(value["transitions"]);
    case "tron-transition":
      return Array.isArray(value["notes"]) && isRecord(value["resources"]);
    default:
      return false;
  }
}

function parseNotifyRequest(body: unknown): NotifyRequest | null {
  if (!isRecord(body)) return null;
  const chatId = body["chatId"];
  if (typeof chatId !== "string" && typeof chatId !== "number") return null;
  const event = body["event"];
  if (!isNotifyEvent(event)) return null;
  return { chatId: String(chatId), event };
}

// Renders each event exactly like the monolithic bot did in its background
// loops (checkLendingForWallet / checkSuppliesForWallet / checkPoolsForWallet /
// checkTronForWallet).
export function buildNotifyMessage(event: NotifyEvent): string {
  switch (event.type) {
    case "lending-alert": {
      const grouped = new Map<string, WalletBuckets>([
        [event.wallet, { [event.protocol]: event.positions.map((p) => formatPosition(p)) }]
      ]);
      return formatResultsByWallet(grouped);
    }
    case "supply-transition": {
      const buckets: WalletBuckets = {};
      for (const supply of event.transitions) {
        (buckets[supply.platform] ??= []).push(formatSupplyPosition(supply, event.threshold, true));
      }
      return formatResultsByWallet(new Map([[event.wallet, buckets]]));
    }
    case "pool-transition": {
      const buckets: WalletBuckets = {};
      for (const pool of event.transitions) {
        (buckets[pool.platform] ??= []).push(formatPoolPosition(pool, true));
      }
      return formatResultsByWallet(new Map([[event.wallet, buckets]]));
    }
    case "tron-transition":
      return `\`${event.wallet}\`\n\n*TRON*\n${event.notes.join("\n")}\n\n${formatTronResources(event.resources)}`;
  }
}

export function createNotifyApp(telegram: Telegram, internalToken: string): Express {
  const app = express();
  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.post("/notify", async (req, res) => {
    if (req.get("authorization") !== `Internal ${internalToken}`) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const parsed = parseNotifyRequest(req.body);
    if (!parsed) {
      res.status(400).json({ error: "invalid body" });
      return;
    }
    try {
      const text = buildNotifyMessage(parsed.event);
      await telegram.sendMessage(parsed.chatId, text, { parse_mode: "Markdown" });
      res.json({ ok: true });
    } catch (error) {
      // Non-200 tells the core the alert was NOT delivered, so it keeps the
      // previous alert state and retries on the next cycle.
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Notify send failed for chat ${parsed.chatId}: ${message}`);
      res.status(502).json({ error: message });
    }
  });

  return app;
}
