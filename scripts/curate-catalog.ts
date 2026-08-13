/**
 * Bulk enable/disable catalog blanks.
 *
 * `is_enabled` is what sellers actually see. The sync pulls everything Printful
 * offers and leaves it all off; this is how a curated subset gets turned on.
 * That curation is a product decision — PROJECT.md's user is starting their first
 * clothing label, and 167 choices is not a catalog, it is a maze.
 *
 *   npm run curate                                     # summary of what is on
 *   npm run curate -- --list                           # every blank, with state
 *   npm run curate -- --list --brand=stanley           # filtered
 *   npm run curate -- --enable --brand="Bella + Canvas"        # DRY RUN
 *   npm run curate -- --enable --brand="Bella + Canvas" --apply
 *   npm run curate -- --enable --starter --apply       # sensible starter set
 *   npm run curate -- --disable --all --apply          # back to nothing
 *
 * Nothing writes without --apply. Every run without it prints exactly what would
 * change, because turning the wrong blanks on is visible to every seller at once.
 *
 * Uses the service role, so it is unaffected by the column grants in 0002.
 */

import { adminClient, args } from "./_env";

const sb = adminClient();
const a = args();

interface Blank {
  id: string;
  external_id: string;
  brand: string;
  model: string;
  supported_decoration: string[];
  is_enabled: boolean;
  colors: number;
  minCostCents: number | null;
}

async function loadBlanks(): Promise<Blank[]> {
  const { data: blanks, error } = await sb
    .from("catalog_blanks")
    .select("id, external_id, brand, model, supported_decoration, is_enabled")
    .order("brand");
  if (error) throw error;

  // Colour counts and cheapest variant, fetched in bulk rather than per blank.
  // PostgREST caps a response at 1000 rows, so both of these page.
  const colorCount = new Map<string, number>();
  const minCost = new Map<string, number>();

  for (let from = 0; ; from += 1000) {
    const { data, error: e } = await sb
      .from("catalog_colors").select("blank_id").range(from, from + 999);
    if (e) throw e;
    if (!data?.length) break;
    for (const r of data) colorCount.set(r.blank_id, (colorCount.get(r.blank_id) ?? 0) + 1);
    if (data.length < 1000) break;
  }

  for (let from = 0; ; from += 1000) {
    const { data, error: e } = await sb
      .from("catalog_variants").select("blank_id, base_cost_cents").range(from, from + 999);
    if (e) throw e;
    if (!data?.length) break;
    for (const r of data) {
      if (r.base_cost_cents == null) continue;
      const cur = minCost.get(r.blank_id);
      if (cur === undefined || r.base_cost_cents < cur) minCost.set(r.blank_id, r.base_cost_cents);
    }
    if (data.length < 1000) break;
  }

  return (blanks ?? []).map((b) => ({
    ...b,
    colors: colorCount.get(b.id) ?? 0,
    minCostCents: minCost.get(b.id) ?? null,
  }));
}

function applyFilters(blanks: Blank[]): Blank[] {
  const brand = a.get("brand")?.toLowerCase();
  const model = a.get("model")?.toLowerCase();
  const ids = a.get("ids")?.split(",").map((s) => s.trim());
  const decoration = a.get("decoration");
  const maxCost = a.get("max-cost") ? Math.round(Number(a.get("max-cost")) * 100) : null;
  const minColors = a.get("min-colors") ? Number(a.get("min-colors")) : null;

  return blanks.filter((b) => {
    if (brand && !b.brand.toLowerCase().includes(brand)) return false;
    if (model && !b.model.toLowerCase().includes(model)) return false;
    if (ids && !ids.includes(b.external_id)) return false;
    if (decoration && !b.supported_decoration.includes(decoration)) return false;
    if (maxCost !== null && (b.minCostCents === null || b.minCostCents > maxCost)) return false;
    if (minColors !== null && b.colors < minColors) return false;
    return true;
  });
}

/**
 * A defensible default catalog for someone's first brand: printable with DTG,
 * a real colour range, and cheap enough to leave margin at a normal retail price.
 * Capped per brand so the list reads as a curated shelf, not a spreadsheet.
 */
function starterSet(blanks: Blank[]): Blank[] {
  const eligible = blanks
    .filter((b) =>
      b.supported_decoration.includes("dtg") &&
      b.colors >= 8 &&
      b.minCostCents !== null &&
      b.minCostCents <= 2200 &&
      b.brand.trim() !== "",
    )
    .sort((x, y) => (y.colors - x.colors) || (x.minCostCents! - y.minCostCents!));

  const perBrand = new Map<string, number>();
  const picked: Blank[] = [];
  for (const b of eligible) {
    const n = perBrand.get(b.brand) ?? 0;
    if (n >= 2) continue;
    perBrand.set(b.brand, n + 1);
    picked.push(b);
    if (picked.length >= 12) break;
  }
  return picked;
}

function money(cents: number | null): string {
  return cents === null ? "     —" : `$${(cents / 100).toFixed(2)}`.padStart(6);
}

function row(b: Blank): string {
  return (
    `  ${(b.is_enabled ? "ON " : "off")}  ` +
    `${b.external_id.padStart(5)}  ` +
    `${`${b.brand} ${b.model}`.trim().slice(0, 42).padEnd(42)} ` +
    `${money(b.minCostCents)}  ` +
    `${String(b.colors).padStart(3)} colors  ` +
    `${b.supported_decoration.join(",")}`
  );
}

async function main() {
  const blanks = await loadBlanks();
  const enable = a.has("enable");
  const disable = a.has("disable");
  const apply = a.has("apply");

  // ---- summary ----
  if (!enable && !disable && !a.has("list")) {
    const on = blanks.filter((b) => b.is_enabled);
    console.log(`${blanks.length} blanks cached, ${on.length} enabled\n`);
    if (on.length) {
      for (const b of on) console.log(row(b));
      console.log();
    }
    const brands = new Map<string, number>();
    for (const b of blanks) brands.set(b.brand || "(unbranded)", (brands.get(b.brand || "(unbranded)") ?? 0) + 1);
    console.log("by brand:");
    for (const [brand, n] of [...brands].sort((x, y) => y[1] - x[1]).slice(0, 12)) {
      console.log(`  ${String(n).padStart(3)}  ${brand}`);
    }
    console.log("\n--list to see everything, --enable/--disable to change it");
    return;
  }

  // ---- list ----
  if (a.has("list")) {
    const shown = applyFilters(blanks);
    for (const b of shown) console.log(row(b));
    console.log(`\n${shown.length} blanks, ${shown.filter((b) => b.is_enabled).length} enabled`);
    return;
  }

  // ---- select targets ----
  let targets: Blank[];
  if (a.has("starter")) {
    targets = starterSet(blanks);
  } else if (a.has("all")) {
    targets = blanks;
  } else {
    targets = applyFilters(blanks);
    const noFilter = !["brand", "model", "ids", "decoration", "max-cost", "min-colors"]
      .some((f) => a.get(f));
    if (noFilter) {
      console.error("Refusing to act on the whole catalog without --all or a filter.");
      console.error("Filters: --brand= --model= --ids= --decoration= --max-cost= --min-colors=");
      process.exit(1);
    }
  }

  const want = enable;
  const changing = targets.filter((b) => b.is_enabled !== want);

  console.log(`${want ? "Enabling" : "Disabling"} ${changing.length} of ${targets.length} matched blanks`);
  console.log(`(${targets.length - changing.length} already ${want ? "enabled" : "disabled"})\n`);

  for (const b of changing) console.log(row(b));

  if (!changing.length) {
    console.log("\nNothing to do.");
    return;
  }

  if (!apply) {
    const enabledAfter = blanks.filter((b) =>
      changing.some((c) => c.id === b.id) ? want : b.is_enabled,
    ).length;
    console.log(`\nDRY RUN — nothing written.`);
    console.log(`Would leave ${enabledAfter} blanks enabled. Re-run with --apply.`);
    return;
  }

  // Chunked, because a few hundred ids in one `in` filter makes an unwieldy URL.
  for (let i = 0; i < changing.length; i += 100) {
    const chunk = changing.slice(i, i + 100);
    const { error } = await sb
      .from("catalog_blanks")
      .update({ is_enabled: want })
      .in("id", chunk.map((b) => b.id));
    if (error) throw error;
  }

  const { count } = await sb
    .from("catalog_blanks")
    .select("id", { count: "exact", head: true })
    .eq("is_enabled", true);

  console.log(`\nApplied. ${count} blanks now enabled.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
