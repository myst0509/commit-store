/**
 * Drives a complete checkout against Stripe test mode and the real database.
 *
 *   npx tsx scripts/checkout-test.ts
 *   npx tsx scripts/checkout-test.ts --keep
 *
 * Creates an order, quotes live shipping from Printful, opens a PaymentIntent,
 * pays it with a test card, and checks what actually landed. Refuses to run
 * against live keys. Everything it creates is removed at the end.
 */

import { createCheckout } from "../lib/orders/checkout";
import { isTestMode, stripe } from "../lib/stripe/client";
import { adminClient, args, loadEnv } from "./_env";

loadEnv();

if (!isTestMode()) {
  console.error("STRIPE_SECRET_KEY is not a test key. Refusing to run.");
  process.exit(1);
}

const sb = adminClient();
const a = args();

const usd = (c: number) => `$${Math.floor(c / 100)}.${String(c % 100).padStart(2, "0")}`;

let orderId = "";

async function main() {
  const { data: store } = await sb
    .from("stores").select("id, name").eq("subdomain", "demo").single();
  if (!store) throw new Error("No demo store. Run: npm run seed:demo");

  const { data: variant } = await sb
    .from("product_variants")
    .select("id, catalog_variants(color,size), products!inner(store_id)")
    .eq("products.store_id", store.id)
    .limit(1).single();
  if (!variant) throw new Error("Demo store has no variants. Run: npm run seed:demo");

  const cv = Array.isArray(variant.catalog_variants) ? variant.catalog_variants[0] : variant.catalog_variants;
  console.log(`Store    ${store.name}`);
  console.log(`Buying   1 × ${cv?.color} ${cv?.size}\n`);

  const quote = await createCheckout({
    storeId: store.id,
    lines: [{ productVariantId: variant.id, quantity: 1 }],
    shipping: {
      name: "Test Buyer", line1: "19 Union Square W", city: "New York",
      state: "NY", postalCode: "10003", country: "US",
      email: "buyer@example.test",
    },
  });

  orderId = quote.orderId;
  const e = quote.economics;

  console.log("Checkout quote");
  console.log(`    Goods                      ${usd(e.subtotalCents - quote.shippingCents)}`);
  console.log(`    Shipping (live quote)      ${usd(quote.shippingCents)}`);
  console.log(`    Customer pays              ${usd(e.customerPaysCents)}`);
  console.log(`    Seller earns               ${usd(e.sellerMarginCents)}`);
  console.log(`    Stripe takes               ${usd(e.stripeFeeCents)}`);
  console.log(`    We keep                    ${usd(e.platformNetCents)}   (before vendor tax)`);
  console.log(`\n    client secret: ${quote.clientSecret.slice(0, 24)}…  (this is what the browser gets)\n`);

  // Prices must survive a hostile client. The browser sends ids and quantities,
  // never money, so there is nothing here for a tampered request to change.
  const { data: stored } = await sb
    .from("orders").select("total_cents, status, payment_status").eq("id", orderId).single();
  console.log(`Stored order: ${usd(stored!.total_cents)}, ${stored!.status}, ${stored!.payment_status}`);
  console.log(stored!.total_cents === e.customerPaysCents
    ? "  ✓ stored total matches the quote\n"
    : "  ✗ STORED TOTAL DIVERGED FROM QUOTE\n");

  // Pay it, the way a real card would.
  const { data: order } = await sb
    .from("orders").select("stripe_payment_intent_id").eq("id", orderId).single();

  const paid = await stripe().paymentIntents.confirm(order!.stripe_payment_intent_id!, {
    payment_method: "pm_card_visa",
    return_url: "https://example.test/return",
  });

  console.log(`Payment: ${paid.status}, ${usd(paid.amount)} ${paid.currency.toUpperCase()}`);
  console.log(`  captured: ${usd(paid.amount_received)}`);
  console.log(`  metadata.order_id matches: ${paid.metadata.order_id === orderId}`);
  console.log(`  transfer_data: ${paid.transfer_data ? "PRESENT — should be absent" : "absent ✓ (separate charges and transfers)"}`);

  // A second confirm must not charge twice.
  try {
    await stripe().paymentIntents.confirm(order!.stripe_payment_intent_id!, {
      payment_method: "pm_card_visa", return_url: "https://example.test/return",
    });
    console.log("  double-confirm: accepted");
  } catch (err) {
    console.log(`  double-confirm: refused ✓ (${(err as Error).message.slice(0, 60)}…)`);
  }

  console.log("\nStill to build: the webhook that turns this payment into a Printful order.");
}

main()
  .catch((e) => { console.error("\nFAILED:", e instanceof Error ? e.message : e); process.exitCode = 1; })
  .finally(async () => {
    if (a.has("keep")) { console.log(`\n(kept: order ${orderId})`); return; }
    if (orderId) {
      await sb.from("order_items").delete().eq("order_id", orderId);
      await sb.from("orders").delete().eq("id", orderId);
      console.log("\n(test order removed; the Stripe test charge stays in your dashboard)");
    }
  });
