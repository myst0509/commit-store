import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isPayoutWindow, PAYOUT_DAY_UTC, PAYOUT_HOUR_UTC } from "../lib/payouts/run";

/**
 * Payouts moved from daily to weekly for a money reason, not a taste one.
 * Stripe charges 25c per payout SENT plus $2 per monthly active account, so a
 * daily cadence costs up to $7.50 a seller a month — worst for the smallest
 * sellers, who are the point of the platform.
 *
 * If someone widens this back to daily, they should have to delete a test that
 * says why.
 */

const at = (iso: string) => new Date(iso);

describe("the payout window", () => {
  it("opens on Friday at 09:00 UTC", () => {
    // 2026-08-21 is a Friday.
    assert.equal(at("2026-08-21T09:00:00Z").getUTCDay(), PAYOUT_DAY_UTC);
    assert.equal(isPayoutWindow(at("2026-08-21T09:00:00Z")), true);
    assert.equal(isPayoutWindow(at("2026-08-21T09:59:59Z")), true);
  });

  it("stays shut on the other six days, even at the right hour", () => {
    for (const day of ["17", "18", "19", "20", "22", "23"]) {
      const d = at(`2026-08-${day}T09:00:00Z`);
      assert.equal(isPayoutWindow(d), false, `2026-08-${day} should not pay out`);
    }
  });

  it("stays shut on Friday outside the hour", () => {
    assert.equal(isPayoutWindow(at("2026-08-21T08:59:59Z")), false);
    assert.equal(isPayoutWindow(at("2026-08-21T10:00:00Z")), false);
  });

  it("opens exactly once a week", () => {
    // Every ten minutes for a fortnight, counting the hours it is open.
    const open = new Set<string>();
    const start = Date.parse("2026-08-17T00:00:00Z");
    for (let m = 0; m < 14 * 24 * 60; m += 10) {
      const d = new Date(start + m * 60_000);
      if (isPayoutWindow(d)) open.add(d.toISOString().slice(0, 13));
    }
    // Two Fridays in a fortnight, one hour each.
    assert.equal(open.size, 2);
  });

  it("keeps the hour, so the schedule is one change from daily", () => {
    assert.equal(PAYOUT_HOUR_UTC, 9);
  });
});
