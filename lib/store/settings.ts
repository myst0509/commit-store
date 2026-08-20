import { UserError } from "@/lib/errors";
import { THEME_VALUE_RE, type StoreTheme } from "@/lib/store/resolve";

/**
 * Validation for the things a seller may change about their own store.
 *
 * Kept out of the route so it can be tested without a database, and so the one
 * rule that matters most stays visible: a theme value is checked here with the
 * SAME expression that themeStyle() uses when rendering. If the two ever drift,
 * a seller saves a colour, sees "saved", and gets nothing on their storefront,
 * with no error anywhere to explain it.
 */

/** Mirrors the `subdomain_format` check constraint in 0001_init.sql. */
export const SUBDOMAIN_RE = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

/** Hosts that are ours, not a seller's. Same list as resolve.ts. */
const RESERVED = new Set(["", "www", "app", "api", "admin", "static", "assets"]);

export const THEME_KEYS = ["bg", "fg", "accent", "muted", "radius"] as const;
export type ThemeKey = (typeof THEME_KEYS)[number];

export function normalizeBrandName(input: unknown): string {
  const name = String(input ?? "").trim();
  if (!name) throw new UserError("A brand name is required");
  if (name.length > 60) throw new UserError("Brand names must be 60 characters or fewer");
  return name;
}

/**
 * A seller may set their web address explicitly rather than having it derived
 * from the brand name, because the two are not always the same thing and the
 * address is what ends up on a garment tag.
 */
export function normalizeSubdomain(input: unknown): string {
  const sub = String(input ?? "").trim().toLowerCase();

  if (!sub) throw new UserError("A web address is required");
  if (RESERVED.has(sub)) throw new UserError(`"${sub}" is reserved and cannot be used`);
  if (sub.length < 3) throw new UserError("Web addresses must be at least 3 characters");
  if (sub.length > 63) throw new UserError("Web addresses must be 63 characters or fewer");

  if (!SUBDOMAIN_RE.test(sub)) {
    // Naming the actual rule beats "invalid format", which leaves someone
    // guessing whether it was the capital letter or the trailing hyphen.
    throw new UserError(
      "Web addresses can only use lowercase letters, numbers and hyphens, " +
        "and cannot start or end with a hyphen",
    );
  }

  return sub;
}

/**
 * Only the five known keys survive, and only with values that will actually
 * render. Anything else is rejected rather than stored, so what a seller saves
 * is what they get.
 */
export function normalizeTheme(input: unknown): StoreTheme {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new UserError("Theme must be a set of colour values");
  }

  const raw = input as Record<string, unknown>;
  const theme: StoreTheme = {};

  for (const key of Object.keys(raw)) {
    if (!(THEME_KEYS as readonly string[]).includes(key)) {
      throw new UserError(`"${key}" is not something you can theme`);
    }
  }

  for (const key of THEME_KEYS) {
    const value = raw[key];
    // Absent means "leave it alone"; empty string means "clear it".
    if (value === undefined) continue;
    if (value === null || value === "") continue;

    const str = String(value).trim();
    if (!THEME_VALUE_RE.test(str)) {
      throw new UserError(
        `That ${key} value cannot be used. Use a colour like #1a1a1a or rgb(20, 20, 20)`,
      );
    }
    theme[key] = str;
  }

  return theme;
}
