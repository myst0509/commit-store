/**
 * Caches the vendor catalog into catalog_blanks / catalog_colors /
 * catalog_placements / catalog_variants.
 *
 * Run this on a schedule, never on a page load. Printful is rate limited to 120
 * requests/minute and a full apparel sync costs roughly three requests per blank.
 *
 *   npx tsx scripts/sync-catalog.ts                    # default apparel categories
 *   npx tsx scripts/sync-catalog.ts --categories=6,7   # men's shirts + hoodies
 *   npx tsx scripts/sync-catalog.ts --limit=5          # smoke test
 *   npx tsx scripts/sync-catalog.ts --enable           # also mark blanks sellable
 *
 * Idempotent: re-running updates in place rather than duplicating. Safe to
 * interrupt and restart.
 *
 * Writes with the service role, which bypasses RLS — correct here, since the
 * catalog is platform-global and has no owning store. This script must never run
 * anywhere the service key could reach a browser.
 *
 * NOTE: this talks to PostgREST over plain fetch rather than @supabase/supabase-js,
 * purely to avoid adding a dependency before one is agreed. Swapping it for the
 * real client later touches only the `db` helper below.
 */

import fs from "node:fs";
import path from "node:path";

import { getProvider } from "../lib/fulfillment";
import type { CatalogBlank, CatalogVariant } from "../lib/fulfillment/types";

/* ------------------------------------------------------------------ */
/* Environment                                                        */
/* ------------------------------------------------------------------ */

// A standalone script gets no Next.js env loading, so read .env.local directly.
// Anything already in the real environment wins, so CI can override.
function loadEnv() {
  const file = path.join(process.cwd(), ".env.local");
  if (!fs.existsSync(file)) return;

  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}
loadEnv();

const SUPABASE_URL = required("NEXT_PUBLIC_SUPABASE_URL");
const SERVICE_KEY = required("SUPABASE_SERVICE_ROLE_KEY");

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing ${name}. Set it in .env.local.`);
    process.exit(1);
  }
  return v;
}

/* ------------------------------------------------------------------ */
/* Postgres access                                                    */
/* ------------------------------------------------------------------ */

async function db<T = unknown>(
  pathname: string,
  opts: { method?: string; body?: unknown; prefer?: string } = {},
): Promise<T> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${pathname}`, {
    method: opts.method ?? "GET",
    headers: {
      // The new-style secret keys are not JWTs; PostgREST wants the key in both.
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      Prefer: opts.prefer ?? "return=representation",
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${opts.method ?? "GET"} ${pathname} -> ${res.status} ${text.slice(0, 400)}`);
  }
  return (text ? JSON.parse(text) : null) as T;
}

const upsert = <T>(table: string, onConflict: string, rows: unknown[]) =>
  db<T>(`${table}?on_conflict=${onConflict}`, {
    method: "POST",
    body: rows,
    prefer: "resolution=merge-duplicates,return=representation",
  });

/* ------------------------------------------------------------------ */
/* Sync                                                               */
/* ------------------------------------------------------------------ */

async function syncBlank(
  blank: CatalogBlank,
  variants: CatalogVariant[],
  enable: boolean,
): Promise<{ colors: number; placements: number; variants: number }> {
  const [row] = await upsert<Array<{ id: string }>>(
    "catalog_blanks",
    "provider,external_id",
    [
      {
        provider: "printful",
        external_id: blank.externalId,
        brand: blank.brand,
        model: blank.model,
        description: blank.description,
        supported_decoration: blank.supportedDecoration,
        image_url: blank.imageUrl,
        // Only ever turned on deliberately. A re-sync must not silently expose
        // blanks that were switched off, so is_enabled is written only with --enable.
        ...(enable ? { is_enabled: true } : {}),
        synced_at: new Date().toISOString(),
      },
    ],
  );

  const blankId = row.id;

  // Colors and placements are small, fully-derived sets. Replacing them is
  // simpler than diffing and guarantees a removed colour actually disappears.
  await db(`catalog_colors?blank_id=eq.${blankId}`, { method: "DELETE", prefer: "return=minimal" });
  if (blank.colors.length) {
    await db("catalog_colors", {
      method: "POST",
      prefer: "return=minimal",
      body: blank.colors.map((c) => ({
        blank_id: blankId,
        name: c.name,
        hex: c.hex,
        is_dark: c.isDark,
      })),
    });
  }

  await db(`catalog_placements?blank_id=eq.${blankId}`, { method: "DELETE", prefer: "return=minimal" });
  if (blank.placements.length) {
    await db("catalog_placements", {
      method: "POST",
      prefer: "return=minimal",
      body: blank.placements.map((p) => ({
        blank_id: blankId,
        code: p.code,
        width_in: p.widthIn,
        height_in: p.heightIn,
        min_dpi: p.minDpi,
      })),
    });
  }

  // Variants are upserted, not replaced: product_variants references them with
  // ON DELETE RESTRICT, so deleting one that a seller has already built on would
  // fail — correctly. Prices change; identities must not.
  if (variants.length) {
    await upsert("catalog_variants", "provider,external_id", variants.map((v) => ({
      blank_id: blankId,
      provider: "printful",
      external_id: v.externalId,
      color: v.color,
      size: v.size,
      base_cost_cents: v.baseCostCents,
      in_stock: v.inStock,
      synced_at: new Date().toISOString(),
    })));
  }

  return {
    colors: blank.colors.length,
    placements: blank.placements.length,
    variants: variants.length,
  };
}

/* ------------------------------------------------------------------ */

// Men's and women's shirts and hoodies. This platform sells clothing; syncing
// mugs and wall art would just be catalog noise.
const DEFAULT_CATEGORIES = ["6", "7", "8", "9"];

async function main() {
  const args = process.argv.slice(2);
  const arg = (name: string) =>
    args.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];

  const categories = (arg("categories") ?? DEFAULT_CATEGORIES.join(",")).split(",");
  const limit = arg("limit") ? Number(arg("limit")) : Infinity;
  const enable = args.includes("--enable");

  const printful = getProvider("printful");

  console.log(`Syncing categories ${categories.join(", ")}${enable ? " (enabling blanks)" : ""}`);
  const started = Date.now();

  // A blank can sit in more than one category; dedupe so it is written once.
  const seen = new Set<string>();
  let blanks: CatalogBlank[] = [];
  for (const category of categories) {
    const found = await printful.listBlanks({ category });
    for (const b of found) {
      if (!seen.has(b.externalId)) {
        seen.add(b.externalId);
        blanks.push(b);
      }
    }
    console.log(`  category ${category}: ${found.length} blanks`);
  }

  blanks = blanks.slice(0, limit);
  console.log(`\n${blanks.length} unique blanks to write\n`);

  const totals = { blanks: 0, colors: 0, placements: 0, variants: 0, failed: 0 };

  for (const [i, blank] of blanks.entries()) {
    const label = `${blank.brand} ${blank.model}`.trim().slice(0, 46);
    try {
      const variants = await printful.listVariants(blank.externalId);
      const r = await syncBlank(blank, variants, enable);

      totals.blanks++;
      totals.colors += r.colors;
      totals.placements += r.placements;
      totals.variants += r.variants;

      console.log(
        `  [${String(i + 1).padStart(3)}/${blanks.length}] ${label.padEnd(48)} ` +
        `${String(r.variants).padStart(4)} variants  ${r.colors} colors  ${r.placements} placements`,
      );
    } catch (e) {
      totals.failed++;
      console.error(`  [${String(i + 1).padStart(3)}/${blanks.length}] ${label.padEnd(48)} FAILED: ${e instanceof Error ? e.message : e}`);
    }
  }

  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log(
    `\nDone in ${secs}s — ${totals.blanks} blanks, ${totals.variants} variants, ` +
    `${totals.colors} colors, ${totals.placements} placements` +
    (totals.failed ? `, ${totals.failed} FAILED` : ""),
  );

  if (!enable) {
    console.log("\nBlanks are is_enabled=false. Re-run with --enable, or flip them");
    console.log("individually, once you have reviewed which ones to offer sellers.");
  }

  process.exit(totals.failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
