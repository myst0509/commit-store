import { createHmac, randomUUID } from "node:crypto";

/**
 * Apliiq request signing.
 *
 * Auth is an HMAC signature, not a bearer token — which is why an unsigned
 * request fails. Their API answers a missing or malformed signature with a
 * 500 rather than a 401, so "the API is down" and "you did not authenticate"
 * look identical from the outside. That cost this project a written-off vendor
 * (see PROJECT.md).
 *
 * Header, per help.apliiq.com/portal/en/kb/articles/authentication:
 *
 *   Authorization: x-apliiq-auth RTS:SIG:APPID:STATE
 *
 * Note the header order (timestamp, signature, app id, nonce) is NOT the order
 * of the signed string (app id, timestamp, nonce, body). Getting them the same
 * way round is the easy mistake.
 *
 *   SIG = base64(HMAC-SHA256(APPID + RTS + STATE + base64(body), SHARED_SECRET))
 *
 * RTS is UNIX seconds. STATE is a per-request nonce. `body` is the raw request
 * content, or the empty string when there is none.
 */

export interface ApliiqCredentials {
  appId: string;
  sharedSecret: string;
}

export interface SignedRequest {
  authorization: string;
  timestamp: string;
  nonce: string;
  signature: string;
  /** Exactly the bytes that were signed — send these, unchanged. */
  body: string;
}

/**
 * Deterministic given `timestamp` and `nonce`, so it can be tested against a
 * known vector. Callers that do not pass them get a fresh pair.
 */
export function signApliiqRequest(
  creds: ApliiqCredentials,
  body = "",
  timestamp: string = Math.floor(Date.now() / 1000).toString(),
  nonce: string = randomUUID().replace(/-/g, ""),
): SignedRequest {
  // Their docs base64 the body before signing it, including when it is empty.
  const bodyBase64 = Buffer.from(body, "utf8").toString("base64");
  const payload = `${creds.appId}${timestamp}${nonce}${bodyBase64}`;

  const signature = createHmac("sha256", creds.sharedSecret)
    .update(payload, "utf8")
    .digest("base64");

  return {
    authorization: `x-apliiq-auth ${timestamp}:${signature}:${creds.appId}:${nonce}`,
    timestamp,
    nonce,
    signature,
    body,
  };
}

export const APLIIQ_BASE_URL = "https://api.apliiq.com";
