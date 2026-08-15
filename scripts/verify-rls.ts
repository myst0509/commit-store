/**
 * Proves the tenancy and money boundaries actually hold, against the real
 * database. Run it after any migration that touches policies or grants.
 *
 *   npm run verify:rls
 *
 * "RLS is enabled" in the dashboard proves nothing about whether the policies are
 * right. This seeds two real sellers with real orders, signs in as each, and
 * checks that neither can reach the other's money. Everything it creates is
 * removed at the end.
 *
 * Safe to run against a database with real data — it only ever reads other rows,
 * and deletes exactly the rows it made.
 */

import { createClient } from "@supabase/supabase-js";

import { adminClient, loadEnv, required } from "./_env";

loadEnv();
const URL_ = required("NEXT_PUBLIC_SUPABASE_URL");
const ANON = required("NEXT_PUBLIC_SUPABASE_ANON_KEY");
const admin = adminClient();

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${ok || !detail ? "" : `  — ${detail}`}`);
  if (!ok) failures++;
};

/** A client acting as a specific signed-in user, exactly as the app would. */
function asUser(accessToken: string) {
  return createClient(URL_, ANON, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

const anon = () => createClient(URL_, ANON, { auth: { persistSession: false } });

const created = { users: [] as string[], stores: [] as string[] };

/** Any enabled blank plus one of its variants, so sellers can own a product. */
async function anyEnabledBlank() {
  const { data: blank } = await admin
    .from("catalog_blanks").select("id").eq("is_enabled", true).limit(1).maybeSingle();
  if (!blank) return null;
  const { data: cv } = await admin
    .from("catalog_variants").select("id").eq("blank_id", blank.id).limit(1).maybeSingle();
  return cv ? { blankId: blank.id, catalogVariantId: cv.id } : null;
}

async function seedSeller(tag: string) {
  const email = `rls-check-${tag}-${Date.now()}@example.test`;
  const password = `Verify-${crypto.randomUUID()}`;

  const { data: u, error: uErr } = await admin.auth.admin.createUser({
    email, password, email_confirm: true,
  });
  if (uErr) throw uErr;
  created.users.push(u.user!.id);

  const { data: store, error: sErr } = await admin
    .from("stores")
    .insert({
      owner_id: u.user!.id,
      name: `RLS Check ${tag.toUpperCase()}`,
      subdomain: `rls-check-${tag}-${Date.now()}`,
      status: "active",
    })
    .select("id")
    .single();
  if (sErr) throw sErr;
  created.stores.push(store.id);

  const { data: order, error: oErr } = await admin
    .from("orders")
    .insert({
      store_id: store.id,
      order_number: `RLSCHK-${tag}`,
      customer_email: `buyer-${tag}@example.test`,
      ship_line1: "1 Test St", ship_city: "Testville",
      ship_postal_code: "00000", ship_country: "US",
      subtotal_cents: 2500, total_cents: 2500,
    })
    .select("id")
    .single();
  if (oErr) throw oErr;

  const { data: session } = await createClient(URL_, ANON, {
    auth: { persistSession: false },
  }).auth.signInWithPassword({ email, password });

  // A product, so the product_variants views have something to isolate.
  let variantId: string | null = null;
  const blank = await anyEnabledBlank();
  if (blank) {
    const { data: product } = await admin
      .from("products")
      .insert({
        store_id: store.id, blank_id: blank.blankId,
        name: `RLS Check ${tag}`, slug: `rls-check-${tag}-${Date.now()}`,
        decoration: "dtg", status: "published",
      })
      .select("id").single();

    if (product) {
      const { data: pv } = await admin
        .from("product_variants")
        .insert({
          product_id: product.id, catalog_variant_id: blank.catalogVariantId,
          retail_price_cents: 3200, base_cost_cents: 1169, platform_fee_cents: 500,
        })
        .select("id").single();
      variantId = pv?.id ?? null;
    }
  }

  return {
    storeId: store.id, orderId: order.id, variantId,
    token: session!.session!.access_token,
  };
}

async function cleanup() {
  for (const id of created.stores) {
    await admin.from("orders").delete().eq("store_id", id);
    await admin.from("stores").delete().eq("id", id);
  }
  for (const id of created.users) await admin.auth.admin.deleteUser(id);
}

async function main() {
  console.log("Seeding two sellers with real orders...\n");
  const A = await seedSeller("a");
  const B = await seedSeller("b");
  const sellerA = asUser(A.token);
  const sellerB = asUser(B.token);

  console.log("Tenant isolation");
  const { data: aSees } = await sellerA.from("orders").select("id");
  const { data: bSees } = await sellerB.from("orders").select("id");
  check("seller A sees exactly one order", aSees?.length === 1, `saw ${aSees?.length}`);
  check("seller A sees only its own", aSees?.[0]?.id === A.orderId);
  check("seller A cannot see seller B's order", !aSees?.some((o) => o.id === B.orderId));
  check("seller B cannot see seller A's order", !bSees?.some((o) => o.id === A.orderId));

  console.log("\nAnonymous access to money");
  for (const table of ["orders", "order_items", "fulfillments", "ledger_entries", "payouts"]) {
    const { data, error } = await anon().from(table).select("id");
    check(`anon blocked from ${table}`, !!error || (data ?? []).length === 0,
      `returned ${data?.length} rows`);
  }

  console.log("\nSellers cannot write money rows");
  const { error: orderWrite } = await sellerA.from("orders").insert({
    store_id: A.storeId, order_number: "SELF-SERVE", customer_email: "x@example.test",
    ship_line1: "x", ship_city: "x", ship_postal_code: "x", ship_country: "US",
  });
  check("seller cannot create an order", !!orderWrite);

  const { error: ledgerWrite } = await sellerA.from("ledger_entries").insert({
    store_id: A.storeId, kind: "seller_margin", amount_cents: 999999,
  });
  check("seller cannot credit their own ledger", !!ledgerWrite,
    "a seller could pay themselves");

  const { error: payoutWrite } = await sellerA.from("payouts").insert({
    store_id: A.storeId, amount_cents: 999999, scheduled_for: new Date().toISOString(),
  });
  check("seller cannot schedule their own payout", !!payoutWrite);

  console.log("\nCost basis (migration 0002)");
  const { error: anonCost } = await anon()
    .from("catalog_variants").select("base_cost_cents").limit(1);
  check("anon cannot read vendor cost", !!anonCost,
    "0002_hide_cost_basis.sql has not been applied — cost basis is public");

  const { error: sellerSplit } = await sellerA
    .from("product_variants").select("base_cost_cents, platform_fee_cents").limit(1);
  check("seller cannot read the base/fee split", !!sellerSplit,
    "PROJECT.md: the seller never sees the split");

  const { error: sellerCost } = await sellerA
    .from("product_variants").select("seller_cost_cents").limit(1);
  check("seller CAN read their own unit cost", !sellerCost,
    "seller_cost_cents should be readable — has 0002 run?");

  console.log("\nStorefront reads still work");
  const { error: catalogRead } = await anon()
    .from("catalog_variants").select("color, size, in_stock").limit(1);
  check("anon can still read colour/size", !catalogRead, catalogRead?.message ?? "");

  console.log("\nselect('*') safety (migration 0003)");
  // PostgREST answers a denial here by suggesting `GRANT SELECT ON <table> TO anon`,
  // which would republish the cost basis. These checks make sure that hint was not
  // followed, and that the safe alternative exists.
  const { error: starCatalog } = await anon().from("catalog_variants").select("*").limit(1);
  check("select('*') on catalog_variants still refused", !!starCatalog,
    "someone ran GRANT SELECT — the cost basis is public again");

  const { error: starProduct } = await sellerA.from("product_variants").select("*").limit(1);
  check("select('*') on product_variants still refused", !!starProduct,
    "someone ran GRANT SELECT — the base/fee split is readable again");

  const { data: viewRows, error: viewErr } = await anon()
    .from("catalog_variants_public").select("*").limit(1);
  check("select('*') on catalog_variants_public works", !viewErr,
    viewErr?.message ?? "has 0003 been applied?");
  if (viewRows?.[0]) {
    check("the view carries no cost column",
      !("base_cost_cents" in viewRows[0]), Object.keys(viewRows[0]).join(","));
  }

  const { data: pvView, error: pvViewErr } = await sellerA
    .from("product_variants_public").select("*").limit(1);
  check("select('*') on product_variants_public works", !pvViewErr,
    pvViewErr?.message ?? "has 0003 been applied?");
  if (pvView?.[0]) {
    check("the view carries no base/fee split",
      !("base_cost_cents" in pvView[0]) && !("platform_fee_cents" in pvView[0]),
      Object.keys(pvView[0]).join(","));
    check("the view still shows seller cost", "seller_cost_cents" in pvView[0]);
  }

  // The whole point of security_invoker=on. A view defined without it runs as its
  // owner and quietly bypasses row-level policies, which would expose every
  // seller's variants to every other seller.
  if (A.variantId && B.variantId) {
    const { data: bSeesVariants, error: bViewErr } = await sellerB
      .from("product_variants_public").select("id");

    // Only meaningful if the query actually ran. Asserting "B did not see A's
    // row" against a failed query passes for the wrong reason, which is how a
    // security check ends up guarding nothing.
    if (bViewErr || !Array.isArray(bSeesVariants)) {
      check("views still enforce row isolation between sellers", false,
        `check could not run: ${bViewErr?.message ?? "no rows returned"}`);
    } else {
      check("views still enforce row isolation between sellers",
        !bSeesVariants.some((v) => v.id === A.variantId),
        "security_invoker is off — the view bypasses RLS");
    }
  }
}

main()
  .catch((e) => { console.error("\n", e); failures++; })
  .finally(async () => {
    await cleanup();
    const { count: orders } = await admin
      .from("orders").select("id", { count: "exact", head: true })
      .like("order_number", "RLSCHK-%");
    console.log(`\nCleanup: ${orders ?? 0} test orders remaining (expect 0)`);
    console.log(failures ? `\n${failures} CHECK(S) FAILED` : "\nAll checks passed.");
    process.exit(failures ? 1 : 0);
  });
