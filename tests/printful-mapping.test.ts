import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isDarkHex, mapPrintfulStatus } from "../lib/fulfillment/printful";

/**
 * These mappings were all wrong in the original skeleton and were corrected
 * against the live API. The tests pin the corrections so they do not get
 * "fixed" back to what the documentation says.
 */

describe("mapPrintfulStatus", () => {
  it("maps the statuses Printful actually returns", () => {
    assert.equal(mapPrintfulStatus("draft"), "pending");
    assert.equal(mapPrintfulStatus("pending"), "submitted");
    assert.equal(mapPrintfulStatus("onhold"), "submitted");
    assert.equal(mapPrintfulStatus("inprocess"), "in_production");
    assert.equal(mapPrintfulStatus("partial"), "in_production");
    assert.equal(mapPrintfulStatus("fulfilled"), "shipped");
    assert.equal(mapPrintfulStatus("failed"), "failed");
  });

  it("maps 'completed', which the skeleton omitted", () => {
    // Unmapped statuses raise an alert, so omitting this paged on every
    // successfully completed order.
    assert.equal(mapPrintfulStatus("completed"), "shipped");
  });

  it("uses Printful's spelling of canceled, with one L", () => {
    assert.equal(mapPrintfulStatus("canceled"), "cancelled");
    // Our own spelling is not one of their statuses; seeing it means something
    // upstream has already been translated, which we want to know about.
    assert.equal(mapPrintfulStatus("cancelled"), "unknown");
  });

  it("returns unknown for anything unrecognized rather than guessing", () => {
    assert.equal(mapPrintfulStatus("teleported"), "unknown");
    assert.equal(mapPrintfulStatus(""), "unknown");
  });

  it("never reports delivered — Printful has no such status", () => {
    // Delivery is inferred from carrier tracking downstream. If this starts
    // returning "delivered", payouts would release on the wrong signal.
    const all = [
      "draft", "pending", "onhold", "inprocess", "partial",
      "fulfilled", "completed", "archived", "canceled", "failed",
    ];
    for (const s of all) {
      assert.notEqual(mapPrintfulStatus(s), "delivered", `${s} mapped to delivered`);
    }
  });
});

describe("isDarkHex", () => {
  it("identifies dark garments, which cannot take DTG", () => {
    assert.equal(isDarkHex("#000000"), true);
    assert.equal(isDarkHex("#14191e"), true);
    assert.equal(isDarkHex("#008db5"), true);
  });

  it("identifies light garments", () => {
    assert.equal(isDarkHex("#ffffff"), false);
    assert.equal(isDarkHex("#f0f1ea"), false);
    assert.equal(isDarkHex("#d3d3d3"), false);
  });

  it("fails toward dark when the colour is unknown", () => {
    // A false "dark" only costs a different print method. A false "light"
    // ships a bad print, so the conservative direction is the safe one.
    assert.equal(isDarkHex(null), true);
    assert.equal(isDarkHex(undefined), true);
    assert.equal(isDarkHex("not-a-colour"), true);
    assert.equal(isDarkHex(""), true);
  });

  it("accepts hex with or without the leading hash", () => {
    assert.equal(isDarkHex("000000"), true);
    assert.equal(isDarkHex("FFFFFF"), false);
  });
});
