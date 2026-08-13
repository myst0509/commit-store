import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { centsToDollars, dollarsToCents } from "../lib/fulfillment/printful";
import { formatUsd, minCents } from "../lib/money";

/**
 * Money is integer cents everywhere. These tests exist because that rule is only
 * as good as the two places money crosses a boundary: parsing Printful's decimal
 * strings on the way in, and formatting for display on the way out.
 */

describe("dollarsToCents", () => {
  it("parses the decimal strings Printful returns", () => {
    assert.equal(dollarsToCents("9.85"), 985);
    assert.equal(dollarsToCents("11.69"), 1169);
    assert.equal(dollarsToCents("0.00"), 0);
    assert.equal(dollarsToCents("1234.56"), 123456);
  });

  it("handles partial and missing decimals", () => {
    assert.equal(dollarsToCents("12"), 1200);
    assert.equal(dollarsToCents("1.5"), 150);
    assert.equal(dollarsToCents(".50"), 50);
  });

  it("treats absent values as zero rather than NaN", () => {
    assert.equal(dollarsToCents(null), 0);
    assert.equal(dollarsToCents(undefined), 0);
    assert.equal(dollarsToCents(""), 0);
  });

  it("keeps the sign on refunds and adjustments", () => {
    assert.equal(dollarsToCents("-3.25"), -325);
  });

  it("rounds the third decimal rather than truncating it", () => {
    assert.equal(dollarsToCents("1.005"), 101);
    assert.equal(dollarsToCents("1.004"), 100);
  });

  it("rejects values it cannot parse instead of guessing", () => {
    assert.throws(() => dollarsToCents("nine dollars"));
  });
});

describe("centsToDollars", () => {
  it("formats for the vendor wire format", () => {
    assert.equal(centsToDollars(985), "9.85");
    assert.equal(centsToDollars(5), "0.05");
    assert.equal(centsToDollars(100), "1.00");
    assert.equal(centsToDollars(0), "0.00");
  });

  it("round-trips without drift", () => {
    for (const c of [0, 1, 99, 100, 985, 1169, 123456, 1000000]) {
      assert.equal(dollarsToCents(centsToDollars(c)), c, `failed at ${c}`);
    }
  });
});

describe("formatUsd", () => {
  it("renders integer cents for display", () => {
    assert.equal(formatUsd(3200), "$32.00");
    assert.equal(formatUsd(1169), "$11.69");
    assert.equal(formatUsd(5), "$0.05");
    assert.equal(formatUsd(0), "$0.00");
  });

  it("groups thousands", () => {
    assert.equal(formatUsd(123456789), "$1,234,567.89");
  });

  it("keeps negatives readable for refunds", () => {
    assert.equal(formatUsd(-325), "-$3.25");
  });
});

describe("minCents", () => {
  it("finds the lowest price for 'from' pricing", () => {
    assert.equal(minCents([3200, 2900, 4100]), 2900);
  });

  it("returns null when there is nothing to price", () => {
    assert.equal(minCents([]), null);
  });
});
