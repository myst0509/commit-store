import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { computeEconomics, grossUpForStripe, sellerUnitCost, stripeFee,
  SERVICE_FEE_EXPLANATION,
  SERVICE_FEE_LABEL,
} from "../lib/pricing";

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

describe("grossUpForStripe", () => {
  it("charges enough that the target actually lands", () => {
    for (const target of [1000, 3717, 5000, 12345, 99999]) {
      const charge = grossUpForStripe(target);
      const landed = charge - stripeFee(charge);
      assert.ok(landed >= target, `target ${target}: landed ${landed}`);
    }
  });

  it("never overshoots by more than a cent", () => {
    for (const target of [1000, 3717, 5000, 12345, 99999]) {
      const charge = grossUpForStripe(target);
      const landed = charge - stripeFee(charge);
      assert.ok(landed - target <= 1, `target ${target}: overshot to ${landed}`);
    }
  });

  it("is more than target plus a naive fee, because Stripe taxes its own fee", () => {
    const target = 3717;
    const naive = target + stripeFee(target);
    assert.ok(grossUpForStripe(target) > naive - 5);
  });
});

describe("computeEconomics — customer covers card fees", () => {
  const e = computeEconomics({
    itemsRetailCents: 3200,
    shippingChargedCents: 475,
    platformFeeCents: 500,
    passCardFeesToCustomer: true,
    ...REAL,
  });

  it("adds a service fee line on top of goods and shipping", () => {
    assert.equal(e.subtotalCents, 3675);
    assert.ok(e.serviceFeeCents > 0);
    assert.equal(e.customerPaysCents, e.subtotalCents + e.serviceFeeCents);
  });

  it("leaves us the full platform fee", () => {
    // The whole point: gross fee and net are now the same.
    assert.equal(e.platformNetCents, e.platformGrossFeeCents);
  });

  it("does not change what the seller earns", () => {
    const absorbed = computeEconomics({
      itemsRetailCents: 3200, shippingChargedCents: 475, platformFeeCents: 500, ...REAL,
    });
    assert.equal(e.sellerMarginCents, absorbed.sellerMarginCents);
  });

  it("costs the customer more than the card fee alone, and that is correct", () => {
    // Stripe's percentage applies to the service fee too, so covering a $1.37
    // fee costs the customer slightly more than $1.37.
    const absorbed = computeEconomics({
      itemsRetailCents: 3200, shippingChargedCents: 475, platformFeeCents: 500, ...REAL,
    });
    assert.ok(e.serviceFeeCents > absorbed.stripeFeeCents);
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

describe("computeEconomics — seller margin matches the quoted cost", () => {
  it("earns retail minus the cost the seller was shown", () => {
    // Seller told $18.00/unit, which includes blank + vendor tax + our fee.
    const e = computeEconomics({
      itemsRetailCents: 3200,
      shippingChargedCents: 475,
      platformFeeCents: 589,
      sellerUnitCostCents: 1800,
      ...REAL,
    });
    assert.equal(e.sellerMarginCents, 1400, "must equal 32.00 - 18.00 exactly");
  });

  it("would drift from the quoted figure without it", () => {
    // Same inputs, no quoted cost: margin is computed from parts and ignores
    // the tax baked into the seller's price. This is the bug the field fixes.
    const derived = computeEconomics({
      itemsRetailCents: 3200, shippingChargedCents: 475, platformFeeCents: 589, ...REAL,
    });
    assert.equal(derived.sellerMarginCents, 1442);
    assert.notEqual(derived.sellerMarginCents, 1400);
  });

  it("keeps the platform whole either way — the difference lands on us", () => {
    const quoted = computeEconomics({
      itemsRetailCents: 3200, shippingChargedCents: 475, platformFeeCents: 589,
      sellerUnitCostCents: 1800, ...REAL,
    });
    const derived = computeEconomics({
      itemsRetailCents: 3200, shippingChargedCents: 475, platformFeeCents: 589, ...REAL,
    });
    assert.equal(
      quoted.platformNetCents - derived.platformNetCents,
      derived.sellerMarginCents - quoted.sellerMarginCents,
    );
  });
});

describe("what the customer sees the fee called", () => {
  // The wording is a legal constraint before it is a copy choice. PROJECT.md:
  // this must be a uniform fee on every order, NOT a card surcharge, because
  // several US states restrict surcharging and the networks prohibit it on
  // debit. So the label and its explanation must never mention how they paid.
  const forbidden = /card|credit|debit|visa|mastercard|surcharge/i;

  it("never mentions the payment method in the label", () => {
    assert.doesNotMatch(SERVICE_FEE_LABEL, forbidden);
  });

  it("never mentions the payment method in the explanation", () => {
    assert.doesNotMatch(SERVICE_FEE_EXPLANATION, forbidden);
  });

  it("says the fee is the same for everyone, which is what makes it not a surcharge", () => {
    assert.match(SERVICE_FEE_EXPLANATION, /every order/i);
  });

  it("is short enough to sit on a checkout line", () => {
    assert.ok(SERVICE_FEE_LABEL.length <= 24, SERVICE_FEE_LABEL);
    assert.ok(SERVICE_FEE_EXPLANATION.length <= 90, SERVICE_FEE_EXPLANATION);
  });

  it("avoids the words people associate with junk fees", () => {
    assert.doesNotMatch(SERVICE_FEE_LABEL, /convenience|booking|admin/i);
  });
});
