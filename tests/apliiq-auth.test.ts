import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { signApliiqRequest } from "../lib/fulfillment/apliiq-auth";

/**
 * Pins the signing order. Apliiq's header lists the parts as
 * RTS:SIG:APPID:STATE, but the signed string is APPID + RTS + STATE + body —
 * a different order. Anyone "tidying" one to match the other breaks auth, and
 * the failure arrives as a 500, which reads as the vendor being down.
 */

const creds = { appId: "APPID123", sharedSecret: "shhh-secret" };
const ts = "1700000000";
const nonce = "0123456789abcdef0123456789abcdef";

describe("apliiq request signing", () => {
  it("signs an empty body to a known value", () => {
    const r = signApliiqRequest(creds, "", ts, nonce);
    assert.equal(r.signature, "1vdt2WRTLpRkYi+5ydadra5KUEDJ6QYEwEP2HYoycqE=");
  });

  it("signs a json body to a known value", () => {
    const r = signApliiqRequest(creds, '{"a":1}', ts, nonce);
    assert.equal(r.signature, "nGh0PZ5XoSkNy0g5eg7yWXc/Ib/+Iba5976ajQPExsQ=");
  });

  it("builds the header in Apliiq's order: timestamp, signature, app id, nonce", () => {
    const r = signApliiqRequest(creds, "", ts, nonce);
    assert.equal(r.authorization, `x-apliiq-auth ${ts}:${r.signature}:${creds.appId}:${nonce}`);
  });

  it("changes the signature when the body changes", () => {
    const a = signApliiqRequest(creds, "", ts, nonce).signature;
    const b = signApliiqRequest(creds, "x", ts, nonce).signature;
    assert.notEqual(a, b);
  });

  it("changes the signature when the nonce changes, so a replay cannot be reused", () => {
    const a = signApliiqRequest(creds, "", ts, nonce).signature;
    const b = signApliiqRequest(creds, "", ts, "ffffffffffffffffffffffffffffffff").signature;
    assert.notEqual(a, b);
  });

  it("generates a fresh timestamp and nonce when not given one", () => {
    const a = signApliiqRequest(creds);
    const b = signApliiqRequest(creds);
    assert.notEqual(a.nonce, b.nonce);
    assert.match(a.timestamp, /^\d{10}$/);
  });
});
