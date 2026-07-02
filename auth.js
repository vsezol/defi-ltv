import crypto from "node:crypto";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const jwt = require("jsonwebtoken");

// Three auth modes for the API:
// 1. `tma <initData>`  — Mini App inside Telegram (HMAC key = HMAC("WebAppData", token))
// 2. `Bearer <jwt>`    — standalone browser after Telegram Login Widget sign-in
// 3. `Internal <token>`— the bot microservice (shared secret + X-Chat-Id header)

function timingSafeEqualStr(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// Telegram Mini App initData validation (Bot API algorithm):
// secret = HMAC_SHA256(key="WebAppData", msg=bot_token); expected hash =
// HMAC_SHA256(key=secret, msg=sorted "k=v" pairs joined with \n, hash excluded).
export function validateInitData(initDataRaw, botToken, maxAgeSeconds = 24 * 3600) {
  const params = new URLSearchParams(initDataRaw);
  const hash = params.get("hash");
  if (!hash) throw new Error("missing hash");
  params.delete("hash");

  const dataCheckString = [...params.entries()]
    .map(([key, value]) => `${key}=${value}`)
    .sort()
    .join("\n");

  const secretKey = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  const computed = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");
  if (!timingSafeEqualStr(computed, hash)) throw new Error("hash mismatch");

  const authDate = Number(params.get("auth_date"));
  if (!authDate || Date.now() / 1000 - authDate > maxAgeSeconds) throw new Error("expired");

  const user = JSON.parse(params.get("user") ?? "null");
  if (!user?.id) throw new Error("no user");
  return user; // { id, first_name, username, ... }
}

// Telegram Login Widget validation — DIFFERENT algorithm from initData:
// secret = SHA256(bot_token) raw digest; hash = HMAC_SHA256(secret, sorted k=v).
export function validateLoginWidget(payload, botToken, maxAgeSeconds = 24 * 3600) {
  if (!payload || typeof payload !== "object") throw new Error("bad payload");
  const { hash, ...fields } = payload;
  if (!hash || typeof hash !== "string") throw new Error("missing hash");

  const dataCheckString = Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${key}=${value}`)
    .sort()
    .join("\n");

  const secretKey = crypto.createHash("sha256").update(botToken).digest();
  const computed = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");
  if (!timingSafeEqualStr(computed, hash)) throw new Error("hash mismatch");

  const authDate = Number(fields.auth_date);
  if (!authDate || Date.now() / 1000 - authDate > maxAgeSeconds) throw new Error("expired");
  if (!fields.id) throw new Error("no user id");
  return { id: fields.id, username: fields.username, firstName: fields.first_name };
}

// Session JWTs for the standalone webapp. Secret derived from the bot token —
// no extra env var, rotates automatically if the token is ever regenerated.
const jwtSecret = (botToken) => crypto.createHash("sha256").update(`jwt:${botToken}`).digest();

export function issueSessionToken(userId, botToken) {
  return jwt.sign({ sub: String(userId) }, jwtSecret(botToken), { algorithm: "HS256", expiresIn: "30d" });
}

export function verifySessionToken(token, botToken) {
  const payload = jwt.verify(token, jwtSecret(botToken), { algorithms: ["HS256"] });
  if (!payload?.sub) throw new Error("no subject");
  return payload.sub; // chat id as string
}

export function isValidInternalToken(provided, expected) {
  return Boolean(expected) && timingSafeEqualStr(provided || "", expected);
}
