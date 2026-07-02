import path from "node:path";
import fs from "node:fs";
import express from "express";
import { validateInitData } from "./webapp-auth.js";
import {
  DEFAULT_THRESHOLDS,
  getGlobalDefaults,
  getWalletThresholds,
  detectWalletType,
  scanPoolsForWallet,
  scanSuppliesForWallet,
  addWalletCore
} from "./core.js";
import { checkSpecificMarkets } from "./kamino.js";
import { checkAaveMarkets } from "./aave.js";
import { getTronResources, tronReclaimInfo } from "./tron.js";
import { getUser, deleteWallet, setGlobalThreshold, setWalletThreshold, resetWalletThresholds } from "./db.js";
import { logger } from "./logger.js";

const ADD_BATCH_SIZE = 5;

const isThresholdField = (field) => Object.prototype.hasOwnProperty.call(DEFAULT_THRESHOLDS, field);

async function scanWalletPositions(user, wallet, walletData) {
  const protocol = walletData.protocol || "kamino";
  const result = { address: wallet, protocol, lending: [], supplies: [], pools: [], tron: null, errors: [] };

  if (protocol === "tron") {
    try {
      const res = await getTronResources(wallet);
      const { reclaimableNow, nextReclaimAt } = tronReclaimInfo(res, Date.now());
      result.tron = { ...res, reclaimableNow, reclaimAt: nextReclaimAt };
    } catch (error) {
      result.errors.push(`Tron: ${error.message}`);
    }
    return result;
  }

  const thresholds = getWalletThresholds(user, wallet);
  await Promise.all([
    (async () => {
      try {
        if (protocol === "aave") {
          result.lending = (await checkAaveMarkets(wallet)).map((p) => ({ platform: "aave", ...p }));
        } else if ((walletData.markets || []).length > 0) {
          result.lending = (await checkSpecificMarkets(wallet, walletData.markets)).map((p) => ({
            platform: "kamino",
            ...p
          }));
        }
      } catch (error) {
        result.errors.push(`Lending: ${error.message}`);
      }
    })(),
    (async () => {
      try {
        const { positions, failures } = await scanSuppliesForWallet(wallet);
        result.supplies = positions;
        if (failures.length > 0) result.errors.push(`Supplies partial: ${failures.join(", ")} failed`);
      } catch (error) {
        result.errors.push(`Supplies: ${error.message}`);
      }
    })(),
    (async () => {
      try {
        const { positions, failures } = await scanPoolsForWallet(wallet);
        result.pools = positions;
        if (failures.length > 0) result.errors.push(`Pools partial: ${failures.join(", ")} failed`);
      } catch (error) {
        result.errors.push(`Pools: ${error.message}`);
      }
    })()
  ]);
  result.thresholds = thresholds;
  return result;
}

export function startWebServer(botToken) {
  const app = express();
  app.use(express.json());

  // All /api routes require a valid Telegram Mini App initData signature.
  app.use("/api", (req, res, next) => {
    const [scheme, data] = (req.get("authorization") || "").split(" ");
    if (scheme !== "tma" || !data) return res.status(401).json({ error: "unauthorized" });
    try {
      const tgUser = validateInitData(data, botToken);
      req.chatId = String(tgUser.id); // private-chat id === user id
      next();
    } catch (error) {
      logger.warn({ error: error.message }, "Mini App auth failed");
      res.status(401).json({ error: "unauthorized" });
    }
  });

  const handle = (fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (error) {
      logger.error({ path: req.path, error: error.message }, "API error");
      res.status(500).json({ error: error.message });
    }
  };

  app.get(
    "/api/state",
    handle(async (req, res) => {
      const user = (await getUser(req.chatId)) || {};
      res.json({
        defaults: getGlobalDefaults(user),
        wallets: Object.entries(user.wallets || {}).map(([address, w]) => ({
          address,
          protocol: w.protocol,
          thresholds: w.settings || {}
        }))
      });
    })
  );

  app.post(
    "/api/wallets",
    handle(async (req, res) => {
      const tokens = String(req.body?.addresses || "")
        .split(/[\s,]+/)
        .map((t) => t.trim())
        .filter(Boolean);
      const unique = [...new Set(tokens)];
      const added = [];
      const skipped = [];
      const valid = [];
      for (const address of unique) {
        if (detectWalletType(address) === "unknown") skipped.push({ address, reason: "unsupported format" });
        else valid.push(address);
      }
      for (let i = 0; i < valid.length; i += ADD_BATCH_SIZE) {
        await Promise.all(
          valid.slice(i, i + ADD_BATCH_SIZE).map(async (address) => {
            try {
              const result = await addWalletCore(req.chatId, address);
              if (result.empty) skipped.push({ address, reason: "no positions found" });
              else added.push({ address, protocol: result.protocol });
            } catch (error) {
              skipped.push({ address, reason: error.message });
            }
          })
        );
      }
      res.json({ added, skipped });
    })
  );

  app.delete(
    "/api/wallets/:address",
    handle(async (req, res) => {
      await deleteWallet(req.chatId, req.params.address);
      res.json({ ok: true });
    })
  );

  app.put(
    "/api/settings",
    handle(async (req, res) => {
      const { field, value } = req.body || {};
      if (!isThresholdField(field)) return res.status(400).json({ error: "unknown field" });
      const num = Number(value);
      if (!Number.isFinite(num) || num <= 0) return res.status(400).json({ error: "value must be a positive number" });
      await setGlobalThreshold(req.chatId, field, num);
      const user = (await getUser(req.chatId)) || {};
      res.json({ ok: true, defaults: getGlobalDefaults(user) });
    })
  );

  app.put(
    "/api/wallets/:address/thresholds",
    handle(async (req, res) => {
      const { field, value } = req.body || {};
      if (!isThresholdField(field)) return res.status(400).json({ error: "unknown field" });
      let num = null;
      if (value !== null && value !== undefined && value !== "") {
        num = Number(value);
        if (!Number.isFinite(num) || num <= 0) {
          return res.status(400).json({ error: "value must be a positive number or null" });
        }
      }
      const user = (await getUser(req.chatId)) || {};
      if (!user.wallets?.[req.params.address]) return res.status(404).json({ error: "wallet not found" });
      await setWalletThreshold(req.chatId, req.params.address, field, num);
      res.json({ ok: true });
    })
  );

  app.delete(
    "/api/wallets/:address/thresholds",
    handle(async (req, res) => {
      await resetWalletThresholds(req.chatId, req.params.address);
      res.json({ ok: true });
    })
  );

  app.get(
    "/api/positions",
    handle(async (req, res) => {
      const user = (await getUser(req.chatId)) || {};
      const entries = Object.entries(user.wallets || {});
      const wallets = await Promise.all(
        entries.map(([wallet, walletData]) => scanWalletPositions(user, wallet, walletData))
      );
      const totals = { supplyUsd: 0, lpValueUsd: 0, lpFeesUsd: 0 };
      for (const w of wallets) {
        for (const s of w.supplies) if (Number.isFinite(s.amountUsd)) totals.supplyUsd += s.amountUsd;
        for (const p of w.pools) {
          if (Number.isFinite(p.valueUsd)) totals.lpValueUsd += p.valueUsd;
          if (Number.isFinite(p.pendingFeesUsd)) totals.lpFeesUsd += p.pendingFeesUsd;
        }
      }
      res.json({ wallets, totals });
    })
  );

  // Static Mini App bundle + SPA fallback (Express 5: no "*" route patterns).
  const dist = path.resolve("./webapp/dist");
  app.use(express.static(dist));
  app.use((req, res) => {
    const index = path.join(dist, "index.html");
    if (!fs.existsSync(index)) return res.status(503).send("webapp not built");
    res.sendFile(index);
  });

  const port = Number(process.env.PORT) || 3000;
  const server = app.listen(port, () => logger.info({ port }, "Web server started"));
  return server;
}
