import { cache } from "react";

import { publicClient } from "@/lib/supabase/client";

export interface StoreTheme {
  bg?: string;
  fg?: string;
  accent?: string;
  muted?: string;
  radius?: string;
}

export interface ResolvedStore {
  id: string;
  name: string;
  subdomain: string;
  customDomain: string | null;
  theme: StoreTheme;
}

/** Hosts that are ours, not a seller's. */
const RESERVED = new Set(["", "www", "app", "api", "admin", "static", "assets"]);

export function rootDomain(): string {
  return (process.env.NEXT_PUBLIC_ROOT_DOMAIN ?? "localhost")
    .split(":")[0]
    .toLowerCase();
}

/** Strip the port and normalize. Hosts are case-insensitive; databases are not. */
export function normalizeHost(host: string): string {
  return host.split(":")[0].toLowerCase().replace(/\.$/, "");
}

/**
 * True when this host belongs to a seller rather than to us. Pure string work —
 * deliberately no database access, because this runs in middleware on every
 * request including ones that never touch a storefront.
 */
export function isStorefrontHost(host: string): boolean {
  const h = normalizeHost(host);
  const root = rootDomain();

  // Platform hosting domains are never a seller's storefront. Vercel cannot
  // wildcard *.vercel.app, so a storefront could not live there even in
  // principle — and without this, a misconfigured NEXT_PUBLIC_ROOT_DOMAIN makes
  // the deployment 404 on every page, because every host looks like an
  // unclaimed custom domain. One unset variable should not take the site down.
  if (h.endsWith(".vercel.app") || h.endsWith(".netlify.app")) return false;

  // Nothing sensible to compare against. Serve our own pages rather than
  // treating the whole internet as unclaimed storefronts.
  if (!root || root.includes("replace") || root.includes("_")) return false;

  if (h === root) return false;
  if (h.endsWith(`.${root}`)) {
    const sub = h.slice(0, -(root.length + 1));
    // Only a single label is a storefront: "acme" yes, "a.b" no.
    return !RESERVED.has(sub) && !sub.includes(".");
  }

  // Anything else is a candidate custom domain. Whether it is actually claimed is
  // a database question, answered later by resolveStore.
  return true;
}

/**
 * Host -> store, or null.
 *
 * Reads through the publishable key on purpose: the `stores` RLS policy only
 * exposes active stores, so an unlaunched or suspended storefront is invisible
 * here without any extra filtering in application code.
 *
 * `cache()` dedupes within a single request — layout and page both need the store
 * and should not query twice. It does NOT cache across requests; that wants a
 * shared cache keyed by host once there is real traffic, since this is one query
 * on the critical path of every storefront page load.
 */
export const resolveStore = cache(async (rawHost: string): Promise<ResolvedStore | null> => {
  const host = normalizeHost(rawHost);
  const root = rootDomain();
  const sb = publicClient();

  const query = sb
    .from("stores")
    .select("id, name, subdomain, custom_domain, theme")
    .eq("status", "active");

  const { data, error } = host.endsWith(`.${root}`)
    ? await query.eq("subdomain", host.slice(0, -(root.length + 1))).maybeSingle()
    : await query.eq("custom_domain", host).maybeSingle();

  if (error || !data) return null;

  return {
    id: data.id,
    name: data.name,
    subdomain: data.subdomain,
    customDomain: data.custom_domain,
    theme: (data.theme ?? {}) as StoreTheme,
  };
});

/**
 * A store's theme becomes inline custom properties on the storefront root, which
 * is why one compiled stylesheet can serve every seller. Only known keys are
 * emitted — `theme` is seller-controlled jsonb, and spreading it into a style
 * attribute unfiltered would be a CSS injection.
 */
export const THEME_VALUE_RE = /^[#a-zA-Z0-9(),.%\s-]{1,64}$/;

export function themeStyle(theme: StoreTheme): React.CSSProperties {
  const vars: Record<string, string> = {};
  // Exported and shared with lib/store/settings.ts on purpose. When the write
  // rule and the render rule are two copies of one expression, they drift, and
  // the symptom is a seller saving a colour, being told it worked, and seeing
  // nothing on their storefront with no error anywhere.
  const safe = (v: string | undefined) => (v && THEME_VALUE_RE.test(v) ? v : undefined);

  if (safe(theme.bg)) vars["--store-bg"] = theme.bg!;
  if (safe(theme.fg)) vars["--store-fg"] = theme.fg!;
  if (safe(theme.accent)) vars["--store-accent"] = theme.accent!;
  if (safe(theme.muted)) vars["--store-muted"] = theme.muted!;
  if (safe(theme.radius)) vars["--store-radius"] = theme.radius!;

  return vars as React.CSSProperties;
}
