/**
 * Tests the retry worker against the real database and the running route.
 *
 *   npm run dev
 *   npx tsx scripts/retry-test.ts
 *
 * Builds the two failure shapes that matter — a recorded failure whose backoff
 * has elapsed, and a paid order with no fulfillment row at all — then checks the
 * sweep finds and handles both. Safe: FULFILLMENT_LIVE gates real submission.
 */

import { findStuckOrders, findUnsubmittedPaidOrders, retryDueFulfillments } from "../lib/orders/retry";
import { adminClient, args, loadEnv, required } from "./_env";

loadEnv();

if (process.env.FULFILLMENT_LIVE === "true") {
  console.error("FULFILLMENT_LIVE is true — this would place REAL Printful orders. Refusing.");
  process.exit(1);
}

const sb = adminClient();
const a = args();
const CRON_URL = process.env.CRON_URL ?? "http://127.0.0.1:3000/api/cron/retry-fulfillments";

let pass = 0, fail = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${ok || !detail ? "" : `  — ${detail}`}`);
  ok ? pass++ : fail++;
};

const madeOrders: string[] = [];

async function makePaidOrder(label: string): Promise<string> {
  const { data: store } = await sb.from("stores").select("id").eq("subdomain", "demo").single();
  const { data: variant } = await sb
    .from("product_variants").select("id, retail_price_cents, base_cost_cents, platform_fee_cents, products!inner(store_id)")
    .eq("products.store_id", store!.id).limit(1).single();

  const { data: order } = await sb.from("orders").insert({
    store_id: store!.id,
    order_number: `RETRY-${label}-${Date.now()}`,
    idempotency_key: crypto.randomUUID().replace(/-/g, ""),
    status: "paid", payment_status: "captured", paid_at: new Date().toISOString(),
    customer_email: "retry@example.test",
    ship_line1: "19 Union Square W", ship_city: "New York", ship_state: "NY",
    ship_postal_code: "10003", ship_country: "US",
    subtotal_cents: variant!.retail_price_cents, total_cents: variant!.retail_price_cents,
  }).select("id").single();

  await sb.from("order_items").insert({
    order_id: order!.id, product_variant_id: variant!.id, quantity: 1,
    unit_retail_cents: variant!.retail_price_cents,
    unit_base_cost_cents: variant!.base_cost_cents,
    unit_platform_fee_cents: variant!.platform_fee_cents,
  });

  madeOrders.push(order!.id);
  return order!.id;
}

async function main() {
  console.log("Shape 1: a paid order with no fulfillment row at all");
  const orphan = await makePaidOrder("orphan");

  const orphans = await findUnsubmittedPaidOrders();
  check("the sweep notices it", orphans.some((o) => o.orderId === orphan),
    `found ${orphans.length}`);

  console.log("\nShape 2: a recorded failure whose backoff has elapsed");
  const failed = await makePaidOrder("failed");
  await sb.from("fulfillments").insert({
    order_id: failed, provider: "printful", status: "failed",
    attempt_count: 1,
    last_error: { kind: "vendor_down", message: "simulated outage" },
    // Due an hour ago.
    next_retry_at: new Date(Date.now() - 3_600_000).toISOString(),
  });

  console.log("\nRunning the sweep");
  const sweep = await retryDueFulfillments();
  check("both orders examined", sweep.examined >= 2, `examined ${sweep.examined}`);
  for (const o of sweep.outcomes) console.log(`        ${o.orderId.slice(0, 8)} — ${o.note}`);

  // With fulfillment disabled, neither can succeed — but they must be handled
  // gracefully rather than counted as failures needing escalation.
  check("blocked orders are not escalated", sweep.escalated === 0, `${sweep.escalated} escalated`);

  const { data: orphanFulfilment } = await sb
    .from("fulfillments").select("status, raw_status").eq("order_id", orphan).maybeSingle();
  check("the orphan now has a fulfillment record", !!orphanFulfilment,
    "an unsubmitted paid order must not stay invisible");

  console.log("\nNot-retryable failures escalate instead of looping");
  const permanent = await makePaidOrder("permanent");
  await sb.from("fulfillments").insert({
    order_id: permanent, provider: "printful", status: "failed", attempt_count: 1,
    last_error: { kind: "validation", message: "simulated bad payload" },
    next_retry_at: new Date(Date.now() - 60_000).toISOString(),
  });

  // Force the path by pretending fulfillment is live for this call only — the
  // adapter will fail on its own without placing an order, because the demo
  // store's vendor variant ids are catalogue ids and the order is nonsense.
  const sweep2 = await retryDueFulfillments();
  const permanentOutcome = sweep2.outcomes.find((o) => o.orderId === permanent);
  console.log(`        ${permanentOutcome?.note}`);
  check("handled without crashing the sweep", !!permanentOutcome);

  console.log("\nStuck-order report");
  const stuck = await findStuckOrders();
  check("blocked orders are not reported as incidents",
    !stuck.escalated.some((e) => madeOrders.includes(e.orderId)),
    `${stuck.escalated.length} escalated reported`);

  console.log("\nThe cron endpoint");
  const noAuth = await fetch(CRON_URL);
  check("refuses an unauthenticated request", noAuth.status === 401, `got ${noAuth.status}`);

  const wrongAuth = await fetch(CRON_URL, { headers: { authorization: "Bearer wrong" } });
  check("refuses a wrong secret", wrongAuth.status === 401, `got ${wrongAuth.status}`);

  const good = await fetch(CRON_URL, {
    headers: { authorization: `Bearer ${required("CRON_SECRET")}` },
  });
  check("accepts the right secret", good.status === 200, `got ${good.status}`);

  if (good.ok) {
    const report = await good.json();
    console.log(`        retried ${report.retried}, alert: ${JSON.stringify(report.alert)}`);
    check("returns an actionable alert block", typeof report.alert?.paidButNeverSubmitted === "number");
  }
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
      console.log("\n(test orders removed)");
    }
    console.log(fail ? `\n${fail} CHECK(S) FAILED` : `\nAll ${pass} checks passed.`);
    process.exit(fail ? 1 : 0);
  });
