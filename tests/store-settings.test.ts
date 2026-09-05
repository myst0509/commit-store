import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { UserError } from "../lib/errors";
import { THEME_VALUE_RE, themeStyle } from "../lib/store/resolve";
import {
  normalizeBio,
  normalizeBrandName,
  normalizeSocial,
  normalizeSubdomain,
  normalizeTheme,
  socialUrl,
  SUBDOMAIN_RE,
} from "../lib/store/settings";

const rejects = (fn: () => unknown, match?: RegExp) =>
  assert.throws(fn, (e: unknown) => {
    assert.ok(e instanceof UserError, "must be a UserError or the seller sees 'Something went wrong'");
    if (match) assert.match((e as Error).message, match);
    return true;
  });

describe("brand names", () => {
  it("trims and keeps what the seller typed", () => {
    assert.equal(normalizeBrandName("  XO Studio  "), "XO Studio");
  });

  it("allows a two character name, unlike the web address", () => {
    // The 3-character floor is a DNS-shaped rule. It has no business
    // constraining what someone calls their brand.
    assert.equal(normalizeBrandName("XO"), "XO");
  });

  it("refuses an empty name", () => {
    rejects(() => normalizeBrandName("   "), /required/i);
  });
});

describe("web addresses", () => {
  it("accepts a normal one", () => {
    assert.equal(normalizeSubdomain("xo-studio"), "xo-studio");
  });

  it("lowercases, because the column is citext and hosts are case-insensitive", () => {
    assert.equal(normalizeSubdomain("XO-Studio"), "xo-studio");
  });

  it("refuses our own hostnames", () => {
    for (const h of ["app", "api", "www", "admin"]) {
      rejects(() => normalizeSubdomain(h), /reserved/i);
    }
  });

  it("refuses anything the database constraint would reject anyway", () => {
    // Better here with a readable message than as a 500 from Postgres.
    for (const bad of ["-lead", "trail-", "has space", "UPPER!", "a"]) {
      rejects(() => normalizeSubdomain(bad));
      assert.equal(SUBDOMAIN_RE.test(bad.toLowerCase()), false, bad);
    }
  });

  it("says what the rule actually is", () => {
    rejects(() => normalizeSubdomain("Not Valid"), /lowercase letters, numbers and hyphens/);
  });
});

describe("themes", () => {
  it("keeps the five known keys", () => {
    const t = normalizeTheme({
      bg: "#ffffff", fg: "#111111", accent: "rgb(20, 120, 90)",
      muted: "#888", radius: "12px",
    });
    assert.deepEqual(Object.keys(t).sort(), ["accent", "bg", "fg", "muted", "radius"]);
  });

  it("refuses a key that would be silently dropped at render time", () => {
    rejects(() => normalizeTheme({ background: "#fff" }), /not something you can theme/);
  });

  it("refuses a value that would be silently dropped at render time", () => {
    // The whole point: saving must not succeed where rendering will discard it.
    rejects(() => normalizeTheme({ bg: "url(javascript:alert(1))" }), /cannot be used/);
  });

  it("blocks the css injection the render filter exists to stop", () => {
    for (const bad of ["red; background: url(x)", "}</style><script>", "url(javascript:alert(1))"]) {
      rejects(() => normalizeTheme({ accent: bad }));
    }
  });

  it("lets through expression(), which is inert here", () => {
    // Only letters, digits and parens, so the charset allows it. Harmless: a
    // custom property is never evaluated, IE expression() has been dead for a
    // decade, and React writes styles through CSSOM rather than by building a
    // style attribute string. Pinned so nobody "fixes" it into a false alarm.
    assert.equal(normalizeTheme({ accent: "expression(alert(1))" }).accent, "expression(alert(1))");
  });

  it("treats empty string as clearing a value rather than storing junk", () => {
    assert.deepEqual(normalizeTheme({ bg: "", fg: "#000" }), { fg: "#000" });
  });

  it("rejects a non-object", () => {
    rejects(() => normalizeTheme("blue"));
    rejects(() => normalizeTheme(["#fff"]));
  });
});

describe("what is saved is what renders", () => {
  // This is the pairing that matters. If the write rule and the render rule
  // drift, a seller saves a colour, is told it worked, and sees nothing.
  it("shares one expression with the storefront rather than copying it", () => {
    // Imported from lib/store/resolve.ts, so drift is impossible by
    // construction rather than by this test noticing afterwards.
    assert.ok(THEME_VALUE_RE.test("#0b0b0b"));
    assert.equal(THEME_VALUE_RE.test("}</style>"), false);
  });

  it("every value that survives validation also survives rendering", () => {
    const theme = normalizeTheme({
      bg: "#0b0b0b", fg: "#fafafa", accent: "rgb(0, 200, 120)",
      muted: "hsl(0, 0%, 60%)", radius: "0.75rem",
    });
    const style = themeStyle(theme) as Record<string, string>;

    assert.equal(style["--store-bg"], "#0b0b0b");
    assert.equal(style["--store-accent"], "rgb(0, 200, 120)");
    assert.equal(Object.keys(style).length, 5, "every saved value should reach the storefront");
  });
});

describe("brand story", () => {
  it("keeps what they wrote", () => {
    assert.equal(normalizeBio("  We make shirts for night shifts.  "),
                 "We make shirts for night shifts.");
  });

  it("treats blank as cleared rather than stored", () => {
    assert.equal(normalizeBio("   "), null);
    assert.equal(normalizeBio(null), null);
  });

  it("refuses an essay, and says how long theirs is", () => {
    rejects(() => normalizeBio("x".repeat(501)), /501 characters/);
  });
});

describe("social links", () => {
  it("takes a bare handle", () => {
    assert.deepEqual(normalizeSocial({ instagram: "nightshift" }), { instagram: "nightshift" });
  });

  it("strips the @ people habitually type", () => {
    assert.equal(normalizeSocial({ tiktok: "@nightshift" }).tiktok, "nightshift");
  });

  it("pulls the handle out of a pasted profile url", () => {
    assert.equal(normalizeSocial({ instagram: "https://instagram.com/nightshift" }).instagram,
                 "nightshift");
    assert.equal(normalizeSocial({ youtube: "https://youtube.com/@nightshift/" }).youtube,
                 "nightshift");
  });

  it("builds the link itself, so a handle cannot point elsewhere", () => {
    // The stored value is a handle, never a URL. This is the reason why.
    assert.equal(socialUrl("instagram", "nightshift"), "https://instagram.com/nightshift");
    assert.equal(socialUrl("tiktok", "nightshift"), "https://tiktok.com/@nightshift");
  });

  it("refuses a handle with characters a real one cannot have", () => {
    rejects(() => normalizeSocial({ instagram: "night shift" }));
    rejects(() => normalizeSocial({ x: "a/../b" }));
  });

  it("refuses a platform we do not support", () => {
    rejects(() => normalizeSocial({ myspace: "nightshift" }), /do not support/);
  });

  it("accepts a real website and rejects a script url", () => {
    assert.equal(normalizeSocial({ website: "https://nightshift.co" }).website,
                 "https://nightshift.co/");
    rejects(() => normalizeSocial({ website: "javascript:alert(1)" }), /http/);
    rejects(() => normalizeSocial({ website: "nightshift.co" }), /not valid|https/i);
  });

  it("drops empty values rather than storing blanks", () => {
    assert.deepEqual(normalizeSocial({ instagram: "", tiktok: "nightshift" }),
                     { tiktok: "nightshift" });
  });
});
