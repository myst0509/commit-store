import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { decideRetry, MAX_ATTEMPTS } from "../lib/orders/retry";

/**
 * The retry decision, tested without a database, a vendor, or a server.
 *
 * The end-to-end sweep cannot cover these paths: FULFILLMENT_LIVE is false in
 * every environment that is safe to test in, so every submission short-circuits
 * to "blocked" before backoff or escalation is ever reached. Isolating the
 * decision is the only way to actually exercise it.
 */

describe("retry decisions", () => {
  it("backs off, front-loaded, while a customer is waiting", () => {
    const schedule = [0, 1, 2, 3, 4].map((prior) => {
      const d = decideRetry("vendor_down", prior);
      return d.action === "retry" ? d.afterMinutes : d.action;
    });
    assert.deepEqual(schedule, [10, 30, 120, 360, 1440]);
  });

  it("gives up rather than looping forever", () => {
    const d = decideRetry("vendor_down", MAX_ATTEMPTS - 1);
    assert.equal(d.action, "escalate");
    assert.match((d as { reason: string }).reason, /exhausted/);
  });

  it("escalates immediately on failures that cannot succeed on retry", () => {
    // Bad credentials and malformed payloads fail identically every time.
    // Retrying them burns the budget and delays a human looking at it.
    for (const kind of ["auth", "validation"]) {
      const d = decideRetry(kind, 0);
      assert.equal(d.action, "escalate", `${kind} should escalate at once`);
      assert.match((d as { reason: string }).reason, /not retryable/);
    }
  });

  it("keeps retrying transient failures", () => {
    for (const kind of ["vendor_down", "rate_limit", "unknown"]) {
      assert.equal(decideRetry(kind, 0).action, "retry", `${kind} should retry`);
    }
  });

  it("treats a disabled kill switch as a stop, not a failure", () => {
    // Counting attempts against a deliberately disabled fulfillment would
    // exhaust the budget on orders that were never actually tried, so when it
    // is switched back on they would already be marked given-up.
    const d = decideRetry("blocked", 3);
    assert.equal(d.action, "stop");
    assert.notEqual(d.action, "escalate");
  });

  it("never escalates a transient failure before the budget is spent", () => {
    for (let prior = 0; prior < MAX_ATTEMPTS - 1; prior++) {
      assert.equal(decideRetry("vendor_down", prior).action, "retry",
        `attempt ${prior + 1} of ${MAX_ATTEMPTS} should still retry`);
    }
  });

  it("holds the total retry window to about a day and a half", () => {
    // Long enough to ride out a vendor outage, short enough that a stuck order
    // is noticed the same week.
    let total = 0;
    for (let prior = 0; prior < MAX_ATTEMPTS - 1; prior++) {
      const d = decideRetry("vendor_down", prior);
      if (d.action === "retry") total += d.afterMinutes;
    }
    assert.ok(total >= 1440 && total <= 3000, `total window was ${total} minutes`);
  });
});
