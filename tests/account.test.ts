import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MAX_DISPLAY_NAME, normalizeDisplayName } from "../lib/account";
import { UserError } from "../lib/errors";

describe("what a seller wants to be called", () => {
  it("keeps what they typed", () => {
    assert.equal(normalizeDisplayName("  Soham  "), "Soham");
  });

  it("accepts a chosen name rather than insisting on a legal one", () => {
    // The point of asking rather than reading it off a payment method.
    for (const n of ["Sam", "moss", "J", "Ada L.", "Jean-Luc", "小林"]) {
      assert.equal(normalizeDisplayName(n), n);
    }
  });

  it("collapses stray whitespace so a greeting does not gap", () => {
    assert.equal(normalizeDisplayName("Soham    P"), "Soham P");
    assert.equal(normalizeDisplayName("Soham\tP"), "Soham P");
  });

  it("strips zero-width and control characters", () => {
    assert.equal(normalizeDisplayName("So\u200bham"), "Soham");
    assert.equal(normalizeDisplayName("Soham\u0000"), "Soham");
  });

  it("strips bidirectional overrides, which can render as another name", () => {
    assert.equal(normalizeDisplayName("\u202eSoham"), "Soham");
  });

  it("treats blank as no name rather than an empty greeting", () => {
    assert.equal(normalizeDisplayName("   "), null);
    assert.equal(normalizeDisplayName(""), null);
    assert.equal(normalizeDisplayName(null), null);
    assert.equal(normalizeDisplayName(undefined), null);
  });

  it("refuses something too long to sit in a greeting, and says how long", () => {
    assert.throws(() => normalizeDisplayName("x".repeat(MAX_DISPLAY_NAME + 1)),
      (e: unknown) => {
        assert.ok(e instanceof UserError);
        assert.match((e as Error).message, new RegExp(String(MAX_DISPLAY_NAME + 1)));
        return true;
      });
  });

  it("accepts exactly the maximum", () => {
    const n = "x".repeat(MAX_DISPLAY_NAME);
    assert.equal(normalizeDisplayName(n), n);
  });
});
