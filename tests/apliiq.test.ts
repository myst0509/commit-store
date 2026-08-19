import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ApliiqProvider,
  dollarsToCents,
  isDarkColorName,
  mapOrderStatus,
  orderIdToInt,
  parseVariantSku,
  toApliiqAddress,
  variantSku,
} from "../lib/fulfillment/apliiq";
import { routeForProduct } from "../lib/fulfillment";
import type { ShippingAddress } from "../lib/fulfillment/types";

describe("apliiq money", () => {
  it("converts their dollar numbers to integer cents", () => {
    assert.equal(dollarsToCents(25.5), 2550);
    assert.equal(dollarsToCents(9.99), 999);
    assert.equal(dollarsToCents(0), 0);
  });

  it("does not leave a float behind on the awkward ones", () => {
    // 0.1 + 0.2 territory. These must be exact integers or money drifts.
    assert.equal(dollarsToCents(19.99), 1999);
    assert.equal(dollarsToCents(33.33), 3333);
    assert.ok(Number.isInteger(dollarsToCents(33.33)));
  });

  it("rounds a half cent down, because binary floats cannot hold one", () => {
    // 1.005 * 100 is 100.49999999999999, so this rounds to 100 and not 101.
    // Documented rather than worked around: vendor prices carry two decimals,
    // so a half cent never arrives. If one ever does, this is why it moved.
    assert.equal(dollarsToCents(1.005), 100);
  });

  it("treats a missing or unparseable price as zero rather than NaN", () => {
    assert.equal(dollarsToCents(undefined), 0);
    assert.equal(dollarsToCents("nonsense"), 0);
  });
});

describe("apliiq dark colours", () => {
  // Their catalog ships no hex, so this is all the dark-garment rule has.
  it("catches the obvious darks", () => {
    for (const n of ["Black", "Navy", "Forest Green", "Dark Heather", "Maroon"]) {
      assert.equal(isDarkColorName(n), true, n);
    }
  });

  it("does not flag lights", () => {
    for (const n of ["White", "Natural", "Sand", "Powder Blue"]) {
      assert.equal(isDarkColorName(n), false, n);
    }
  });
});

describe("apliiq variant skus", () => {
  it("mints their APQ-########S#A# format", () => {
    assert.equal(variantSku(1386, 5, 50), "APQ-00001386S5A50");
  });

  it("round-trips", () => {
    const sku = variantSku(1905, 34, 4492);
    assert.deepEqual(parseVariantSku(sku), { productId: 1905, sizeId: 34, colorId: 4492 });
  });

  it("rejects anything that is not their format rather than half-parsing it", () => {
    assert.equal(parseVariantSku("1386-5-50"), null);
    assert.equal(parseVariantSku("APQ-1386S5A50"), null); // product id not padded
  });
});

describe("apliiq order id", () => {
  // Their id is an int, ours is a uuid. If this is not deterministic, a retry
  // of the same order reads as a brand new one.
  const uuid = "3f7c1e2a-9b44-4d61-8a0e-2c5f6d7e8a90";

  it("is stable across calls", () => {
    assert.equal(orderIdToInt(uuid), orderIdToInt(uuid));
  });

  it("separates different orders", () => {
    assert.notEqual(orderIdToInt(uuid), orderIdToInt("3f7c1e2a-9b44-4d61-8a0e-2c5f6d7e8a91"));
  });

  it("stays a positive int32, which is what their field accepts", () => {
    for (const s of [uuid, "", "a", "z".repeat(200)]) {
      const n = orderIdToInt(s);
      assert.ok(Number.isInteger(n) && n >= 0 && n < 0x7fffffff, `${s} -> ${n}`);
    }
  });
});

describe("apliiq status mapping", () => {
  it("maps the lifecycle", () => {
    assert.equal(mapOrderStatus("received"), "submitted");
    assert.equal(mapOrderStatus("In Production"), "in_production");
    assert.equal(mapOrderStatus("Shipped"), "shipped");
    assert.equal(mapOrderStatus("delivered"), "delivered");
    assert.equal(mapOrderStatus("Cancelled"), "cancelled");
  });

  it("surfaces anything unrecognized rather than assuming progress", () => {
    assert.equal(mapOrderStatus("flurbed"), "unknown");
    assert.equal(mapOrderStatus(""), "unknown");
  });

  it("reads a cancellation as cancelled even when it also says shipped", () => {
    // "shipment cancelled" must not map to shipped.
    assert.equal(mapOrderStatus("shipment cancelled"), "cancelled");
  });
});

describe("apliiq addresses", () => {
  const base: ShippingAddress = {
    name: "Ada Lovelace",
    line1: "12 Baker St",
    city: "Riverside",
    state: "CA",
    postalCode: "92507",
    country: "US",
  };

  it("splits a single name field into their first and last", () => {
    const a = toApliiqAddress(base);
    assert.equal(a.first_name, "Ada");
    assert.equal(a.last_name, "Lovelace");
  });

  it("never sends an empty last name for a mononym", () => {
    const a = toApliiqAddress({ ...base, name: "Prince" });
    assert.equal(a.first_name, "Prince");
    assert.ok(a.last_name.length > 0);
  });

  it("sends province_code for US addresses, which their docs require", () => {
    assert.equal((toApliiqAddress(base) as { province_code?: string }).province_code, "CA");
  });

  it("omits province_code outside the US", () => {
    const a = toApliiqAddress({ ...base, country: "GB", state: null });
    assert.equal((a as { province_code?: string }).province_code, undefined);
  });
});

describe("apliiq is registered and routable", () => {
  it("reports private label, which is why it is in the project", () => {
    assert.equal(new ApliiqProvider().capabilities().privateLabel, true);
  });

  it("is preferred for private label work", () => {
    assert.equal(routeForProduct({ decoration: "embroidery", privateLabel: true }).id, "apliiq");
  });

  it("leaves plain dtg with printful, which has a proven order path", () => {
    assert.equal(routeForProduct({ decoration: "dtg", privateLabel: false }).id, "printful");
  });
});
