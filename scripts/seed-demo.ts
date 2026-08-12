/**
 * Creates one demo storefront so there is something real to render and design
 * against. Development only — it writes with the service role.
 *
 *   npx tsx scripts/seed-demo.ts          # create or refresh
 *   npx tsx scripts/seed-demo.ts --clean  # remove everything it made
 *
 * Idempotent. Uses a real catalog blank, so prices and variants are genuine
 * Printful data rather than invented numbers.
 */

import fs from "node:fs";
import path from "node:path";

import { createClient } from "@supabase/supabase-js";

function loadEnv() {
  const file = path.join(process.cwd(), ".env.local");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}
loadEnv();

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);

const DEMO_EMAIL = "demo-seller@commit.test";
const DEMO_SUBDOMAIN = "demo";
const DEMO_SLUG = "first-tee";

/** Bella + Canvas 3001 — the archetypal blank for this market. */
const BLANK_EXTERNAL_ID = "71";

/** Flat per-unit platform fee, per PROJECT.md (~$4–6). */
const PLATFORM_FEE_CENTS = 500;

const RETAIL_CENTS = 3200;

async function clean() {
  const { data: store } = await sb
    .from("stores").select("id").eq("subdomain", DEMO_SUBDOMAIN).maybeSingle();

  if (store) {
    // products -> product_variants cascade; orders would block on RESTRICT, but
    // the demo store has none.
    await sb.from("products").delete().eq("store_id", store.id);
    await sb.from("stores").delete().eq("id", store.id);
    console.log("removed demo store");
  }

  const { data: users } = await sb.auth.admin.listUsers();
  const user = users?.users.find((u) => u.email === DEMO_EMAIL);
  if (user) {
    await sb.auth.admin.deleteUser(user.id);
    console.log("removed demo user");
  }
}

async function seed() {
  // 1. Seller account.
  const { data: existing } = await sb.auth.admin.listUsers();
  let userId = existing?.users.find((u) => u.email === DEMO_EMAIL)?.id;

  if (!userId) {
    const { data, error } = await sb.auth.admin.createUser({
      email: DEMO_EMAIL,
      password: crypto.randomUUID(),
      email_confirm: true,
    });
    if (error) throw error;
    userId = data.user!.id;
  }
  console.log("seller:", DEMO_EMAIL);

  // 2. Store. Active, so the anon RLS policy exposes it.
  const { data: store, error: storeErr } = await sb
    .from("stores")
    .upsert(
      {
        owner_id: userId,
        name: "Demo Brand",
        subdomain: DEMO_SUBDOMAIN,
        status: "active",
        theme: { bg: "#faf9f7", fg: "#14110e", accent: "#c2410c", muted: "#78716c" },
      },
      { onConflict: "subdomain" },
    )
    .select("id")
    .single();
  if (storeErr) throw storeErr;
  console.log("store:", `${DEMO_SUBDOMAIN}.<root domain>`);

  // 3. The blank must be enabled, or the anon catalog policy hides it and the
  //    storefront renders a product with no imagery or sizes.
  const { data: blank, error: blankErr } = await sb
    .from("catalog_blanks")
    .update({ is_enabled: true })
    .eq("provider", "printful")
    .eq("external_id", BLANK_EXTERNAL_ID)
    .select("id, brand, model")
    .single();
  if (blankErr) throw new Error(`Blank ${BLANK_EXTERNAL_ID} not found — run sync:catalog first`);
  console.log("blank:", blank.brand, blank.model, "(enabled)");

  // 4. Product.
  const { data: product, error: productErr } = await sb
    .from("products")
    .upsert(
      {
        store_id: store.id,
        blank_id: blank.id,
        name: "First Tee",
        slug: DEMO_SLUG,
        description: "A placeholder product on a real blank, for development.",
        decoration: "dtg",
        status: "published",
      },
      { onConflict: "store_id,slug" },
    )
    .select("id")
    .single();
  if (productErr) throw productErr;

  // 5. Variants — real catalog rows, a couple of colourways in common sizes.
  const { data: catalogVariants, error: cvErr } = await sb
    .from("catalog_variants")
    .select("id, color, size, base_cost_cents")
    .eq("blank_id", blank.id)
    .in("color", ["Black", "White"])
    .in("size", ["S", "M", "L", "XL"]);
  if (cvErr) throw cvErr;

  if (!catalogVariants?.length) {
    throw new Error("No catalog variants matched — has the catalog been synced?");
  }

  const { error: pvErr } = await sb.from("product_variants").upsert(
    catalogVariants.map((cv) => ({
      product_id: product.id,
      catalog_variant_id: cv.id,
      retail_price_cents: RETAIL_CENTS,
      base_cost_cents: cv.base_cost_cents,
      platform_fee_cents: PLATFORM_FEE_CENTS,
      is_enabled: true,
    })),
    { onConflict: "product_id,catalog_variant_id" },
  );
  if (pvErr) throw pvErr;

  console.log(`variants: ${catalogVariants.length}`);

  const base = catalogVariants[0].base_cost_cents;
  console.log(
    `\neconomics per unit: vendor $${(base / 100).toFixed(2)} + fee ` +
    `$${(PLATFORM_FEE_CENTS / 100).toFixed(2)} = seller cost ` +
    `$${((base + PLATFORM_FEE_CENTS) / 100).toFixed(2)}, retail ` +
    `$${(RETAIL_CENTS / 100).toFixed(2)}`,
  );
  console.log(`seller margin: $${((RETAIL_CENTS - base - PLATFORM_FEE_CENTS) / 100).toFixed(2)}`);
}

const cleanOnly = process.argv.includes("--clean");
(cleanOnly ? clean() : clean().then(seed))
  .then(() => console.log("\ndone"))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
