import crypto from "node:crypto";

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
  const computedBuf = Buffer.from(computed, "hex");
  const hashBuf = Buffer.from(hash, "hex");
  if (computedBuf.length !== hashBuf.length || !crypto.timingSafeEqual(computedBuf, hashBuf)) {
    throw new Error("hash mismatch");
  }

  const authDate = Number(params.get("auth_date"));
  if (!authDate || Date.now() / 1000 - authDate > maxAgeSeconds) throw new Error("expired");

  const user = JSON.parse(params.get("user") ?? "null");
  if (!user?.id) throw new Error("no user");
  return user; // { id, first_name, username, ... }
}
