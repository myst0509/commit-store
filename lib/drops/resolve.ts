import { submitOrderToVendor } from "@/lib/orders/pipeline";
import { stripe } from "@/lib/stripe/client";
import { serviceClient } from "@/lib/supabase/client";

/**
 * Resolving reservation-based drops.
 *
 * PROJECT.md: a seller sets a threshold, orders collect as reservations, and
 * production only triggers once the threshold is met. Below it, reservations
 * auto-refund and the seller never fronts inventory cost.
 *
 * "Auto-refund" is doing the work of two very different operations, and the
 * distinction matters to the customer:
 *
 *   - A reservation that never reaches threshold was AUTHORISED, not charged.
 *     Cancelling the authorisation releases the hold. No money ever moved, so
 *     there is no refund to wait five days for and no line on their statement.
 *   - A reservation that met threshold is CAPTURED. From then on it is a normal
 *     order and a genuine refund is the only way back.
 *
 * Getting this right is the difference between "the hold disappeared" and
 * "you were charged and then refunded", which is a materially worse experience
 * for a customer buying from a brand they have never heard of.
 */

export interface DropOutcome {
  dropId: string;
  productName: string;
  reservedUnits: number;
  thresholdUnits: number;
  action: "captured" | "released" | "waiting" | "error";
  ordersAffected: number;
  failures: string[];
  note: string;
}

export async function resolveDueDrops(): Promise<DropOutcome[]> {
  const sb = serviceClient();

  const { data: drops } = await sb
    .from("drops")
    .select("id, store_id, product_id, threshold_units, closes_at, status, products(name)")
    .eq("status", "open");

  const outcomes: DropOutcome[] = [];
  for (const drop of drops ?? []) outcomes.push(await resolveOne(drop));
  return outcomes;
}

interface DropRow {
  id: string; store_id: string; product_id: string;
  threshold_units: number; closes_at: string; status: string;
  products: { name: string } | { name: string }[] | null;
}

async function resolveOne(drop: DropRow): Promise<DropOutcome> {
  const sb = serviceClient();
  const product = Array.isArray(drop.products) ? drop.products[0] : drop.products;

  // Reserved units, counting only orders still in play.
  const { data: orders } = await sb
    .from("orders")
    .select("id, status, payment_status, stripe_payment_intent_id, order_items(quantity)")
    .eq("drop_id", drop.id)
    .not("status", "in", "(cancelled,refunded)");

  const live = orders ?? [];
  const reservedUnits = live.reduce(
    (n, o) => n + (o.order_items ?? []).reduce((m: number, i: { quantity: number }) => m + i.quantity, 0),
    0,
  );

  const base = {
    dropId: drop.id,
    productName: product?.name ?? "(unknown)",
    reservedUnits,
    thresholdUnits: drop.threshold_units,
    failures: [] as string[],
  };

  const met = reservedUnits >= drop.threshold_units;
  const closed = Date.parse(drop.closes_at) <= Date.now();

  // Still collecting.
  if (!met && !closed) {
    return {
      ...base, action: "waiting", ordersAffected: 0,
      note: `${reservedUnits}/${drop.threshold_units} units, closes ${drop.closes_at.slice(0, 10)}`,
    };
  }

  // Threshold met — charge the holds and start production. Deliberately not
  // waiting for closes_at: the seller's goal was the threshold, and holds expire
  // (Stripe authorisations lapse after about a week), so sitting on them risks
  // losing reservations that were already won.
  if (met) return captureDrop(drop, live, base);

  // Closed short — release every hold.
  return releaseDrop(drop, live, base);
}

async function captureDrop(
  drop: DropRow,
  orders: Array<{ id: string; payment_status: string; stripe_payment_intent_id: string | null }>,
  base: Omit<DropOutcome, "action" | "ordersAffected" | "note">,
): Promise<DropOutcome> {
  const sb = serviceClient();
  const failures: string[] = [];
  let captured = 0;

  for (const order of orders) {
    if (order.payment_status === "captured") { captured++; continue; }
    if (!order.stripe_payment_intent_id) {
      failures.push(`${order.id}: no payment intent`);
      continue;
    }

    try {
      const intent = await stripe().paymentIntents.capture(
        order.stripe_payment_intent_id,
        {},
        { idempotencyKey: `capture_${order.id}` },
      );

      await sb.from("orders").update({
        payment_status: "captured",
        status: "paid",
        paid_at: new Date().toISOString(),
        stripe_charge_id: typeof intent.latest_charge === "string" ? intent.latest_charge : null,
      }).eq("id", order.id);

      captured++;

      // Production, now that the money is real. A failure here is recorded by
      // the pipeline and picked up by the retry sweep — it must not abort the
      // rest of the drop, or one bad order strands everyone else's.
      await submitOrderToVendor(order.id).catch(() => {});
    } catch (e) {
      // A declined capture is a customer whose card went bad between reserving
      // and production. They lose their unit; everyone else still gets theirs.
      const message = e instanceof Error ? e.message : String(e);
      failures.push(`${order.id}: ${message.slice(0, 80)}`);

      await sb.from("orders").update({
        payment_status: "failed", status: "cancelled",
        cancelled_at: new Date().toISOString(),
      }).eq("id", order.id);
    }
  }

  await sb.from("drops").update({
    status: "in_production",
    resolved_at: new Date().toISOString(),
  }).eq("id", drop.id);

  return {
    ...base, action: "captured", ordersAffected: captured, failures,
    note: failures.length
      ? `threshold met; ${captured} charged, ${failures.length} card(s) declined`
      : `threshold met; ${captured} order(s) charged and sent to production`,
  };
}

async function releaseDrop(
  drop: DropRow,
  orders: Array<{ id: string; payment_status: string; stripe_payment_intent_id: string | null }>,
  base: Omit<DropOutcome, "action" | "ordersAffected" | "note">,
): Promise<DropOutcome> {
  const sb = serviceClient();
  const failures: string[] = [];
  let released = 0;

  for (const order of orders) {
    try {
      if (order.stripe_payment_intent_id) {
        if (order.payment_status === "captured") {
          // Money actually moved — this one needs a real refund. Should be rare:
          // it means the order was captured outside the drop flow.
          const intent = await stripe().paymentIntents.retrieve(order.stripe_payment_intent_id);
          if (typeof intent.latest_charge === "string") {
            await stripe().refunds.create(
              { charge: intent.latest_charge },
              { idempotencyKey: `refund_${order.id}` },
            );
          }
        } else {
          // The normal path: cancel the authorisation. The hold disappears and
          // the customer never sees a charge.
          await stripe().paymentIntents.cancel(
            order.stripe_payment_intent_id,
            { cancellation_reason: "abandoned" },
            { idempotencyKey: `cancel_${order.id}` },
          );
        }
      }

      await sb.from("orders").update({
        status: "cancelled",
        payment_status: order.payment_status === "captured" ? "refunded" : "failed",
        cancelled_at: new Date().toISOString(),
      }).eq("id", order.id);

      released++;
    } catch (e) {
      failures.push(`${order.id}: ${e instanceof Error ? e.message.slice(0, 80) : String(e)}`);
    }
  }

  await sb.from("drops").update({
    status: "failed_threshold",
    resolved_at: new Date().toISOString(),
  }).eq("id", drop.id);

  return {
    ...base, action: "released", ordersAffected: released, failures,
    note: `closed at ${base.reservedUnits}/${base.thresholdUnits}; ${released} hold(s) released, nobody charged`,
  };
}
