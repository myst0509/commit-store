/**
 * Exercises the Stripe webhook route the way Stripe does.
 *
 *   npm run dev          # in one terminal
 *   npx tsx scripts/webhook-test.ts
 *
 * Signs payloads with the real signing secret and POSTs them to the running
 * route, so signature verification, deduplication and the handlers are all
 * tested for real. No Stripe CLI needed.
 *
 * Safe: vendor submission is gated behind FULFILLMENT_LIVE, so nothing is
 * ordered from Printful.
 */

import Stripe from "stripe";

import { createCheckout } from "../lib/orders/checkout";
import { isTestMode } from "../lib/stripe/client";
import { adminClient, args, loadEnv, required } from "./_env";

loadEnv();

if (!isTestMode()) {
  console.error("STRIPE_SECRET_KEY is not a test key. Refusing to run.");
  process.exit(1);
}
if (process.env.FULFILLMENT_LIVE === "true") {
  console.error("FULFILLMENT_LIVE is true — this test would place a REAL Printful order. Refusing.");
  process.exit(1);
}

const sb = adminClient();
const a = args();
const SECRET = required("STRIPE_WEBHOOK_SECRET");
const URL_ = process.env.WEBHOOK_URL ?? "http://127.0.0.1:3000/api/webhooks/stripe";

let pass = 0, fail = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${ok || !detail ? "" : `  — ${detail}`}`);
  ok ? pass++ : fail++;
};

/** Builds the signature header Stripe would send, using the real secret. */
function post(payload: unknown, opts: { badSignature?: boolean } = {}) {
  const body = JSON.stringify(payload);
  const header = opts.badSignature
    ? "t=1,v1=deadbeef"
    : Stripe.webhooks.generateTestHeaderString({ payload: body, secret: SECRET });

  return fetch(URL_, {
    method: "POST",
    headers: { "Content-Type": "application/json", "stripe-signature": header },
    body,
  });
}

function intentEvent(id: string, orderId: string, amount: number, type: string) {
  return {
    id, object: "event", type, created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: `pi_test_${orderId.slice(0, 8)}`,
        object: "payment_intent",
        amount, amount_received: type === "payment_intent.succeeded" ? amount : 0,
        currency: "usd",
        latest_charge: `ch_test_${orderId.slice(0, 8)}`,
        metadata: { order_id: orderId },
      },
    },
  };
}

let orderId = "";

async function main() {
  try {
    await fetch(URL_, { method: "POST", body: "{}" });
  } catch {
    console.error(`Cannot reach ${URL_}. Start the dev server first: npm run dev`);
    process.exit(1);
  }

  console.log("Signature verification");
  const forged = await post(intentEvent("evt_forged", "00000000-0000-0000-0000-000000000000", 100, "payment_intent.succeeded"), { badSignature: true });
  check("a forged signature is rejected with 400", forged.status === 400, `got ${forged.status}`);

  const noSig = await fetch(URL_, { method: "POST", body: "{}" });
  check("a missing signature is rejected with 400", noSig.status === 400, `got ${noSig.status}`);

  // A real order to act on.
  const { data: store } = await sb.from("stores").select("id").eq("subdomain", "demo").single();
  const { data: variant } = await sb
    .from("product_variants").select("id, products!inner(store_id)")
    .eq("products.store_id", store!.id).limit(1).single();

  const quote = await createCheckout({
    storeId: store!.id,
    lines: [{ productVariantId: variant!.id, quantity: 1 }],
    shipping: {
      name: "Webhook Test", line1: "19 Union Square W", city: "New York",
      state: "NY", postalCode: "10003", country: "US", email: "wh@example.test",
    },
  });
  orderId = quote.orderId;
  const total = quote.economics.customerPaysCents;
  console.log(`\nOrder ${orderId} for $${(total / 100).toFixed(2)}\n`);

  console.log("Amount tampering");
  const wrong = await post(intentEvent("evt_wrong_amount", orderId, total - 1000, "payment_intent.succeeded"));
  const { data: afterWrong } = await sb
    .from("orders").select("payment_status").eq("id", orderId).single();
  check("a charge for the wrong amount does not fulfil", afterWrong!.payment_status !== "captured",
    `payment_status became ${afterWrong!.payment_status}`);
  check("  and is still acknowledged, not retried forever", wrong.status === 200, `got ${wrong.status}`);

  // Reset for the happy path.
  await sb.from("orders").update({ payment_status: "requires_payment" }).eq("id", orderId);

  console.log("\nPayment succeeded");
  const ok = await post(intentEvent("evt_ok_1", orderId, total, "payment_intent.succeeded"));
  const okBody = await ok.json();
  check("accepted", ok.status === 200, `got ${ok.status}`);
  console.log(`        note: ${okBody.note}`);

  const { data: paidOrder } = await sb
    .from("orders").select("payment_status, status, paid_at").eq("id", orderId).single();
  check("order marked captured", paidOrder!.payment_status === "captured", paidOrder!.payment_status);
  check("order marked paid", paidOrder!.status === "paid", paidOrder!.status);
  check("paid_at recorded", !!paidOrder!.paid_at);

  const { data: fulfilment } = await sb
    .from("fulfillments").select("status, raw_status").eq("order_id", orderId).maybeSingle();
  check("fulfilment attempt recorded", !!fulfilment);
  check("  and blocked rather than ordering for real",
    fulfilment?.raw_status === "blocked_fulfillment_not_live", fulfilment?.raw_status ?? "none");

  console.log("\nDuplicate delivery");
  const dupe = await post(intentEvent("evt_ok_1", orderId, total, "payment_intent.succeeded"));
  const dupeBody = await dupe.json();
  check("same event id is recognised as a duplicate", dupe.status === 200 && dupeBody.duplicate === true,
    JSON.stringify(dupeBody).slice(0, 80));

  const { count } = await sb
    .from("fulfillments").select("id", { count: "exact", head: true }).eq("order_id", orderId);
  check("no second fulfilment attempt was made", count === 1, `${count} attempts`);

  console.log("\nUnknown events");
  const ignored = await post({
    id: "evt_ignored", object: "event", type: "customer.created",
    created: Math.floor(Date.now() / 1000), data: { object: { id: "cus_x" } },
  });
  check("an event we do not handle is acknowledged, not retried", ignored.status === 200);

  console.log("\nAudit trail");
  const { data: events } = await sb
    .from("payment_events").select("stripe_event_id, type, processed_at").eq("order_id", orderId);
  check("events recorded for the order", (events?.length ?? 0) >= 2, `${events?.length} rows`);
  check("all processed", (events ?? []).every((e) => e.processed_at));
}

main()
  .catch((e) => { console.error("\nFAILED:", e instanceof Error ? e.message : e); fail++; })
  .finally(async () => {
    if (!a.has("keep") && orderId) {
      await sb.from("payment_events").delete().eq("order_id", orderId);
      await sb.from("fulfillments").delete().eq("order_id", orderId);
      await sb.from("order_items").delete().eq("order_id", orderId);
      await sb.from("orders").delete().eq("id", orderId);
    }
    await sb.from("payment_events").delete().in("stripe_event_id", ["evt_ignored", "evt_forged"]);
    console.log(fail ? `\n${fail} CHECK(S) FAILED` : `\nAll ${pass} checks passed.`);
    process.exit(fail ? 1 : 0);
  });
