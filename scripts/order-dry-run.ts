/**
 * Runs a complete order through the pipeline against Printful's real pricing
 * engine, without creating anything at the vendor or moving any money.
 *
 *   npm run order:dry-run
 *
 * This is how you see the true economics of an order before committing to a
 * sample: what the vendor will actually charge, what the customer pays, what the
 * seller earns, and what we keep. Vendor cost comes from Printful's estimator,
 * not from the cached catalog price, so it includes real shipping and tax.
 *
 * Creates a test order, prices it, then deletes it. Pass --keep to leave it.
 */

import { submitOrderToVendor } from "../lib/orders/pipeline";
import { adminClient, args, loadEnv } from "./_env";

loadEnv();
const sb = adminClient();
const a = args();

function usd(cents: number | null): string {
  if (cents === null) return "     —";
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}$${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`.padStart(9);
}

async function main() {
  const { data: store } = await sb
    .from("stores")
    .select("id, name, subdomain, vendor_store_id")
    .eq("subdomain", "demo")
    .maybeSingle();

  if (!store) throw new Error("No demo store. Run: npm run seed:demo");

  // A seller's vendor sub-store is normally provisioned at signup. The demo one
  // has none, so borrow the account's first store — order endpoints are
  // store-scoped and an account-level token must name one.
  if (!store.vendor_store_id) {
    const fallback = process.env.PRINTFUL_CATALOG_STORE_ID ?? "18599319";
    await sb.from("stores").update({ vendor_store_id: fallback, vendor_provider: "printful" })
      .eq("id", store.id);
    console.log(`(demo store had no vendor store; using ${fallback})\n`);
  }

  const { data: variants } = await sb
    .from("product_variants")
    .select(
      `id, retail_price_cents, base_cost_cents, platform_fee_cents,
       products!inner ( name, store_id ),
       catalog_variants ( color, size )`,
    )
    .eq("products.store_id", store.id)
    .limit(1);

  const variant = variants?.[0];
  if (!variant) throw new Error("Demo store has no product variants. Run: npm run seed:demo");

  const product = Array.isArray(variant.products) ? variant.products[0] : variant.products;
  const cv = Array.isArray(variant.catalog_variants) ? variant.catalog_variants[0] : variant.catalog_variants;

  console.log(`Store    ${store.name} (${store.subdomain})`);
  console.log(`Product  ${product?.name} — ${cv?.color} ${cv?.size}\n`);

  const { data: order, error: orderErr } = await sb
    .from("orders")
    .insert({
      store_id: store.id,
      order_number: `DRYRUN-${Date.now()}`,
      // Set explicitly rather than relying on the column default, so this script
      // works both before and after migration 0004. Printful caps external_id at
      // 32 chars; a hyphenated UUID is 36. See 0004.
      idempotency_key: crypto.randomUUID().replace(/-/g, ""),
      customer_email: "dryrun@example.test",
      customer_name: "Dry Run",
      ship_line1: "19 Union Square W", ship_city: "New York",
      ship_state: "NY", ship_postal_code: "10003", ship_country: "US",
      shipping_speed: "standard",
      subtotal_cents: variant.retail_price_cents,
      total_cents: variant.retail_price_cents,
      // Deliberately NOT captured. The pipeline refuses to submit an uncaptured
      // order for real; a dry run is the documented exception.
      payment_status: "requires_payment",
    })
    .select("id, idempotency_key")
    .single();

  if (orderErr) throw orderErr;

  const { error: itemErr } = await sb.from("order_items").insert({
    order_id: order.id,
    product_variant_id: variant.id,
    quantity: 1,
    unit_retail_cents: variant.retail_price_cents,
    unit_base_cost_cents: variant.base_cost_cents,
    unit_platform_fee_cents: variant.platform_fee_cents,
  });
  if (itemErr) throw itemErr;

  console.log(`Order    ${order.id}`);
  console.log(`Key      ${order.idempotency_key}  (idempotency: re-sending this never duplicates)\n`);

  const result = await submitOrderToVendor(order.id, { dryRun: true });

  if (!result.ok) {
    console.log("FAILED");
    console.log(`  ${result.error?.kind}: ${result.error?.message}`);
    console.log(`  retryable: ${result.error?.retryable}`);
  } else {
    const e = result.economics!;

    console.log("What the customer is charged");
    console.log(`    Goods (seller's price)     ${usd(e.customerPaysCents - e.vendorShippingCents)}`);
    console.log(`    Shipping                   ${usd(e.vendorShippingCents)}   passed through at cost`);
    console.log(`                               ─────────`);
    console.log(`    Total                      ${usd(e.customerPaysCents)}`);

    console.log("\nWhere it goes");
    console.log(`    Printful — blank           ${usd(-(e.vendorTotalCents - e.vendorShippingCents - e.vendorTaxCents))}`);
    console.log(`    Printful — shipping        ${usd(-e.vendorShippingCents)}`);
    console.log(`    Printful — tax             ${usd(-e.vendorTaxCents)}   zero with a resale certificate`);
    console.log(`    Stripe                     ${usd(-e.stripeFeeCents)}   2.9% + 30c`);
    console.log(`    Seller (net 14)            ${usd(-e.sellerMarginCents)}`);
    console.log(`                               ─────────`);
    console.log(`    We keep                    ${usd(e.platformNetCents)}`);

    console.log(`\n    Gross fee ${usd(e.platformGrossFeeCents).trim()} -> net ${usd(e.platformNetCents).trim()} after tax and card fees.`);

    if (e.platformNetCents < 0) {
      console.log(`\n  WARNING: this order loses ${usd(-e.platformNetCents).trim()}.`);
    } else if (e.platformNetCents < 100) {
      console.log("\n  Thin. Worth checking the fee against your real cost of");
      console.log("  support, chargebacks and refunds before scaling.");
    }
  }

  if (!a.has("keep")) {
    await sb.from("orders").delete().eq("id", order.id);
    console.log("\n(test order removed — pass --keep to retain it)");
  } else {
    console.log(`\n(kept: order ${order.id})`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
