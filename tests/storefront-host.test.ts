import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isStorefrontHost } from "../lib/store/resolve";

/**
 * A misconfigured NEXT_PUBLIC_ROOT_DOMAIN once took the whole deployment down:
 * every host looked like an unclaimed custom domain, so every page rewrote to a
 * storefront that did not exist and returned 404. These pin the guards.
 */
describe("storefront host detection", () => {
  it("never treats a platform hosting domain as a storefront", () => {
    // Vercel cannot wildcard *.vercel.app, so a storefront cannot live there.
    assert.equal(isStorefrontHost("commit-store-xuav.vercel.app"), false);
    assert.equal(isStorefrontHost("anything.netlify.app"), false);
  });

  it("serves our own pages when the root domain is unset or a placeholder", () => {
    const original = process.env.NEXT_PUBLIC_ROOT_DOMAIN;
    try {
      process.env.NEXT_PUBLIC_ROOT_DOMAIN = "REPLACE_WITH_YOUR_VERCEL_HOST";
      assert.equal(isStorefrontHost("example.com"), false);

      delete process.env.NEXT_PUBLIC_ROOT_DOMAIN;
      // Falls back to "localhost", so a real domain is still not a storefront
      // by accident on a misconfigured deploy.
      assert.equal(isStorefrontHost("localhost"), false);
    } finally {
      if (original === undefined) delete process.env.NEXT_PUBLIC_ROOT_DOMAIN;
      else process.env.NEXT_PUBLIC_ROOT_DOMAIN = original;
    }
  });

  it("still resolves real storefronts when configured", () => {
    const original = process.env.NEXT_PUBLIC_ROOT_DOMAIN;
    try {
      process.env.NEXT_PUBLIC_ROOT_DOMAIN = "ourdomain.com";
      assert.equal(isStorefrontHost("acme.ourdomain.com"), true);
      assert.equal(isStorefrontHost("ourdomain.com"), false);
      assert.equal(isStorefrontHost("www.ourdomain.com"), false);
      assert.equal(isStorefrontHost("app.ourdomain.com"), false);
      // A seller's own domain.
      assert.equal(isStorefrontHost("shop.acmebrand.com"), true);
    } finally {
      if (original === undefined) delete process.env.NEXT_PUBLIC_ROOT_DOMAIN;
      else process.env.NEXT_PUBLIC_ROOT_DOMAIN = original;
    }
  });
});
