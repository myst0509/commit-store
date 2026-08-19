/**
 * Makes one authenticated request to Apliiq and shows exactly what was sent.
 *
 *   npm run apliiq:probe
 *   npm run apliiq:probe -- --path=/orders --method=GET
 *
 * Prints a redacted curl equivalent, safe to paste into a support ticket —
 * the app id, signature and secret are never shown in full.
 *
 * Reading the result: a 500 is what an UNSIGNED request returns, so anything
 * else — 200, 401, 404 — means the signature was accepted and the auth problem is
 * solved. A 404 on a wrong path still proves auth works.
 */
import { APLIIQ_BASE_URL, signApliiqRequest } from "../lib/fulfillment/apliiq-auth";
import { args, loadEnv } from "./_env";

function mask(s: string): string {
  if (s.length <= 8) return "*".repeat(s.length);
  return `${s.slice(0, 4)}...${s.slice(-4)}`;
}

async function main() {
  loadEnv();
  const a = args();

  const appId = process.env.APLIIQ_APP_ID;
  const sharedSecret = process.env.APLIIQ_SHARED_SECRET;

  if (!appId || !sharedSecret) {
    console.error("Missing APLIIQ_APP_ID and/or APLIIQ_SHARED_SECRET in .env.local.");
    console.error("Both are in the Apliiq dashboard under Stores.");
    process.exit(1);
  }

  const method = (a.get("method") ?? "GET").toUpperCase();
  const path = a.get("path") ?? "/orders";
  const body = a.get("body") ?? "";

  const signed = signApliiqRequest({ appId, sharedSecret }, body);
  const url = `${APLIIQ_BASE_URL}${path}`;

  console.log("Request");
  console.log(`  ${method} ${url}`);
  console.log(`  Authorization: x-apliiq-auth ${signed.timestamp}:${mask(signed.signature)}:${mask(appId)}:${signed.nonce}`);
  console.log(`  Accept: application/json`);
  if (body) console.log(`  body: ${body}`);
  console.log("");
  console.log("  signed string = APPID + TIMESTAMP + NONCE + base64(body)");
  console.log(`  signature     = base64(HMAC-SHA256(that, shared secret))`);
  console.log("");

  const started = Date.now();
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: signed.authorization,
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body } : {}),
  });

  const text = await res.text();
  console.log("Response");
  console.log(`  ${res.status} ${res.statusText}  (${Date.now() - started}ms)`);
  console.log(`  ${text.slice(0, 800)}`);
  console.log("");
  console.log(
    res.status === 500
      ? "500 — same as an unsigned request. Signature rejected, or their fault."
      : "Not a 500, so the signature was accepted.",
  );
}

main().catch((e) => {
  console.error("FAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});
