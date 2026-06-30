import Keyv from "keyv";
import { logger } from "./logger.js";

// Ephemeral / refetchable state (market caches, transient UI state) lives here,
// NOT in Postgres. Defaults to an in-memory store. To move it to Redis later:
// set REDIS_URL and `npm i @keyv/redis` — no other code changes needed.
async function buildStore() {
  const url = process.env.REDIS_URL;
  if (!url) return undefined;
  try {
    const { default: KeyvRedis } = await import("@keyv/redis");
    logger.info("Cache backed by Redis");
    return new KeyvRedis(url);
  } catch (error) {
    logger.warn({ error: error.message }, "REDIS_URL set but @keyv/redis unavailable; using in-memory cache");
    return undefined;
  }
}

const store = await buildStore();

function makeCache(namespace) {
  const cache = new Keyv(store ? { store, namespace } : { namespace });
  cache.on("error", (error) => logger.error({ namespace, error: error.message }, "Cache error"));
  return cache;
}

// Kamino & Aave market metadata (keys: "kamino", "aave:<network>").
export const marketsCache = makeCache("markets");

// Transient per-chat UI state (pending input, menu index, current wallet).
export const uiCache = makeCache("ui");
