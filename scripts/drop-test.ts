/**
 * Tests drop resolution against real Stripe test mode.
 *
 *   npx tsx scripts/drop-test.ts
 *
 * Builds real reservations — authorised, uncaptured PaymentIntents — then checks
 * both endings: a drop that reaches its threshold charges everyone, and one that
 * closes short releases every hold without charging anybody.
 */

import { resolveDueDrops } from "../lib/drops/resolve";
import { createCheckout } from "../lib/orders/checkout";
import { isTestMode, stripe } from "../lib/stripe/client";
import { adminClient, args, loadEnv } from "./_env";

loadEnv();

if (!isTestMode()) {
  console.error("STRIPE_SECRET_KEY is not a test key. Refusing to run.");
  process.exit(1);
}
if (process.env.FULFILLMENT_LIVE === "true") {
  console.error("FULFILLMENT_LIVE is true — this would place REAL Printful orders. Refusing.");
  process.exit(1);
}

const sb = adminClient();
const a = args();

let pass = 0, fail = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${ok || !detail ? "" : `  — ${detail}`}`);
  ok ? pass++ : fail++;
};

const madeDrops: string[] = [];
const madeOrders: string[] = [];

async function context() {
  const { data: store } = await sb.from("stores").select("id").eq("subdomain", "demo").single();
  const { data: variant } = await sb
    .from("product_variants").select("id, product_id, products!inner(store_id)")
    .eq("products.store_id", store!.id).limit(1).single();
  return { storeId: store!.id, variantId: variant!.id, productId: variant!.product_id };
}

async function makeDrop(storeId: string, productId: string, threshold: number, closesAt: Date) {
  // opens_at must precede closes_at — the schema's drop_window check. To model a
  // drop that has already closed, both dates go in the past rather than just one.
  const opensAt = new Date(Math.min(Date.now(), closesAt.getTime()) - 86_400_000);

  const { data, error } = await sb.from("drops").insert({
    store_id: storeId, product_id: productId,
    threshold_units: threshold,
    opens_at: opensAt.toISOString(),
    closes_at: closesAt.toISOString(),
    status: "open",
  }).select("id").single();

  if (error || !data) throw new Error(`could not create drop: ${JSON.stringify(error)}`);
  madeDrops.push(data.id);
  return data.id;
}

/** A reservation: authorised, not captured. */
async function reserve(storeId: string, variantId: string, dropId: string) {
  const quote = await createCheckout({
    storeId, lines: [{ productVariantId: variantId, quantity: 1 }],
    shipping: {
      name: "Drop Buyer", line1: "19 Union Square W", city: "New York",
      state: "NY", postalCode: "10003", country: "US", email: "drop@example.test",
    },
    dropId,
  });
  madeOrders.push(quote.orderId);

  const { data: order } = await sb
    .from("orders").select("stripe_payment_intent_id").eq("id", quote.orderId).single();

  const intent = await stripe().paymentIntents.confirm(order!.stripe_payment_intent_id!, {
    payment_method: "pm_card_visa", return_url: "https://example.test/return",
  });

  return { orderId: quote.orderId, intentId: intent.id, status: intent.status };
}

async function main() {
  const ctx = await context();

  console.log("A reservation authorises without charging");
  const dropA = await makeDrop(ctx.storeId, ctx.productId, 2, new Date(Date.now() + 7 * 86_400_000));
  const r1 = await reserve(ctx.storeId, ctx.variantId, dropA);
  check("intent is held, not captured", r1.status === "requires_capture", r1.status);

  const pi1 = await stripe().paymentIntents.retrieve(r1.intentId);
  check("nothing has been taken from the customer", pi1.amount_received === 0,
    `amount_received ${pi1.amount_received}`);

  console.log("\nBelow threshold, still open");
  let outcomes = await resolveDueDrops();
  let a1 = outcomes.find((o) => o.dropId === dropA);
  check("the drop keeps collecting", a1?.action === "waiting", a1?.action);
  console.log(`        ${a1?.note}`);

  console.log("\nThreshold reached");
  await reserve(ctx.storeId, ctx.variantId, dropA);
  outcomes = await resolveDueDrops();
  a1 = outcomes.find((o) => o.dropId === dropA);
  check("the drop captures", a1?.action === "captured", a1?.action);
  console.log(`        ${a1?.note}`);

  const pi1After = await stripe().paymentIntents.retrieve(r1.intentId);
  check("the customer is now actually charged", pi1After.amount_received > 0,
    `amount_received ${pi1After.amount_received}`);

  const { data: capturedOrder } = await sb
    .from("orders").select("status, payment_status, paid_at").eq("id", r1.orderId).single();
  check("the order is marked paid", capturedOrder?.payment_status === "captured");
  check("production was attempted", !!capturedOrder?.paid_at);

  const { data: dropAfter } = await sb.from("drops").select("status").eq("id", dropA).single();
  check("the drop moves to production", dropAfter?.status === "in_production", dropAfter?.status);

  console.log("\nRe-running must not double-charge");
  outcomes = await resolveDueDrops();
  check("a resolved drop is not picked up again",
    !outcomes.some((o) => o.dropId === dropA), "resolved drops must leave the open set");

  console.log("\nA drop that closes short releases every hold");
  const dropB = await makeDrop(ctx.storeId, ctx.productId, 25, new Date(Date.now() - 60_000));
  const r3 = await reserve(ctx.storeId, ctx.variantId, dropB);

  outcomes = await resolveDueDrops();
  const b1 = outcomes.find((o) => o.dropId === dropB);
  check("the drop is released", b1?.action === "released", b1?.action);
  console.log(`        ${b1?.note}`);

  const pi3 = await stripe().paymentIntents.retrieve(r3.intentId);
  check("the authorisation is cancelled", pi3.status === "canceled", pi3.status);
  check("the customer was never charged", pi3.amount_received === 0,
    "a released reservation must not become a refund");

  const { data: releasedOrder } = await sb
    .from("orders").select("status, payment_status").eq("id", r3.orderId).single();
  check("the order is cancelled", releasedOrder?.status === "cancelled", releasedOrder?.status);
  check("  and not marked refunded, because nothing moved",
    releasedOrder?.payment_status !== "refunded", releasedOrder?.payment_status ?? "");
}

main()
  .catch((e) => { console.error("\nFAILED:", e instanceof Error ? e.message : e); fail++; })
  .finally(async () => {
    if (!a.has("keep")) {
      for (const id of madeOrders) {
        await sb.from("fulfillments").delete().eq("order_id", id);
        await sb.from("order_items").delete().eq("order_id", id);
        await sb.from("orders").delete().eq("id", id);
      }
      for (const id of madeDrops) await sb.from("drops").delete().eq("id", id);
      console.log("\n(test drops and orders removed)");
    }
    console.log(fail ? `\n${fail} CHECK(S) FAILED` : `\nAll ${pass} checks passed.`);
    process.exit(fail ? 1 : 0);
  });
