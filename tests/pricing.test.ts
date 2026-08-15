import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { computeEconomics, sellerUnitCost, stripeFee } from "../lib/pricing";

/**
 * Real numbers throughout: a Bella + Canvas 3001 at $11.69 base, $4.75 shipping
 * and $0.42 vendor tax, all taken from Printful's live estimator.
 */
const REAL = {
  vendorItemsCents: 1169,
  vendorShippingCents: 475,
  vendorTaxCents: 42,
};

describe("stripeFee", () => {
  it("charges 2.9% plus 30 cents", () => {
    assert.equal(stripeFee(10000), 320);   // $100.00 -> $3.20
    assert.equal(stripeFee(3675), 137);    // $36.75  -> $1.37
    assert.equal(stripeFee(1000), 59);     // $10.00  -> $0.59
  });

  it("returns integers, never fractional cents", () => {
    for (const gross of [1, 99, 333, 1234, 99999]) {
      assert.ok(Number.isInteger(stripeFee(gross)), `${gross} produced a fraction`);
    }
  });

  it("is zero for a zero charge", () => {
    assert.equal(stripeFee(0), 0);
  });
});

describe("sellerUnitCost", () => {
  it("is base plus fee, the single number a seller sees", () => {
    assert.equal(sellerUnitCost(1169, 331), 1500);
  });
});

describe("computeEconomics — customer pays shipping", () => {
  const economics = computeEconomics({
    itemsRetailCents: 3200,
    shippingChargedCents: 475,   // passed straight through
    platformFeeCents: 331,       // seller cost lands on $15.00
    ...REAL,
  });

  it("charges the customer retail plus shipping", () => {
    assert.equal(economics.customerPaysCents, 3675);
  });

  it("pays the seller their margin on goods only", () => {
    // $32.00 retail - $11.69 vendor - $3.31 fee
    assert.equal(economics.sellerMarginCents, 1700);
  });

  it("leaves us the fee minus tax and Stripe, not the whole fee", () => {
    assert.equal(economics.platformGrossFeeCents, 331);
    assert.equal(economics.stripeFeeCents, 137);
    // 3675 - 1686 - 1700 - 137
    assert.equal(economics.platformNetCents, 152);
  });

  it("stays profitable", () => {
    assert.ok(economics.platformNetCents > 0);
  });
});

describe("computeEconomics — the failure modes worth knowing about", () => {
  it("loses money when shipping is not charged to the customer", () => {
    // The bug the first dry run caught.
    const e = computeEconomics({
      itemsRetailCents: 3200,
      shippingChargedCents: 0,
      platformFeeCents: 500,
      ...REAL,
    });
    assert.ok(e.platformNetCents < 0, "should be a loss when shipping is absorbed");
  });

  it("squeezes the seller, not us, when retail is priced too low", () => {
    // A seller pricing at exactly their cost, $15.00.
    const e = computeEconomics({
      itemsRetailCents: 1500,
      shippingChargedCents: 475,
      platformFeeCents: 331,
      ...REAL,
    });

    // Their margin goes to zero — they are selling at cost.
    assert.equal(e.sellerMarginCents, 0);

    // Ours does not. It actually improves slightly, because Stripe's percentage
    // is charged on a smaller total. Worth knowing: underpricing is a seller
    // problem, and nothing in our economics will warn us it is happening.
    assert.ok(e.platformNetCents > 0);
    const at32 = computeEconomics({
      itemsRetailCents: 3200, shippingChargedCents: 475, platformFeeCents: 331, ...REAL,
    });
    assert.ok(e.platformNetCents > at32.platformNetCents);
  });

  it("recovers the tax when a resale certificate is on file", () => {
    const taxed = computeEconomics({
      itemsRetailCents: 3200, shippingChargedCents: 475, platformFeeCents: 331, ...REAL,
    });
    const exempt = computeEconomics({
      itemsRetailCents: 3200, shippingChargedCents: 475, platformFeeCents: 331,
      ...REAL, vendorTaxCents: 0,
    });
    assert.equal(exempt.platformNetCents - taxed.platformNetCents, 42);
  });

  it("never lets shipping become seller profit or seller loss", () => {
    const cheap = computeEconomics({
      itemsRetailCents: 3200, shippingChargedCents: 200, platformFeeCents: 331, ...REAL,
    });
    const dear = computeEconomics({
      itemsRetailCents: 3200, shippingChargedCents: 2000, platformFeeCents: 331, ...REAL,
    });
    assert.equal(cheap.sellerMarginCents, dear.sellerMarginCents);
  });

  it("keeps every output an integer", () => {
    const e = computeEconomics({
      itemsRetailCents: 3333, shippingChargedCents: 777, platformFeeCents: 333, ...REAL,
    });
    for (const [k, v] of Object.entries(e)) {
      assert.ok(Number.isInteger(v), `${k} = ${v} is not an integer`);
    }
  });
});
