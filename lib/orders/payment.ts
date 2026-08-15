import type Stripe from "stripe";

import { submitOrderToVendor } from "@/lib/orders/pipeline";
import { serviceClient } from "@/lib/supabase/client";

/**
 * What a Stripe event means for an order.
 *
 * Every handler here is idempotent, because Stripe delivers at-least-once and
 * retries for three days. "Already done" is a normal outcome, not an error.
 *
 * The ordering rule throughout: record the money fact first, then act on it. If
 * the vendor submission fails we still know we were paid, and the retry queue can
 * finish the job. The reverse — submitting first and recording after — can lose
 * the record of a payment we already took.
 */

export interface HandlerResult {
  handled: boolean;
  note: string;
}

export async function handlePaymentSucceeded(
  intent: Stripe.PaymentIntent,
): Promise<HandlerResult> {
  const sb = serviceClient();
  const orderId = intent.metadata?.order_id;
  if (!orderId) return { handled: false, note: "no order_id in metadata" };

  const { data: order } = await sb
    .from("orders")
    .select("id, status, payment_status, drop_id, total_cents")
    .eq("id", orderId)
    .maybeSingle();

  if (!order) return { handled: false, note: `order ${orderId} not found` };

  // Stripe is the authority on what was actually charged. A mismatch means the
  // intent was altered after we created it, which should never happen — record
  // it and refuse to fulfil rather than shipping against an unexpected amount.
  if (intent.amount_received !== order.total_cents) {
    await sb.from("orders").update({ payment_status: "failed" }).eq("id", orderId);
    return {
      handled: false,
      note: `amount mismatch: charged ${intent.amount_received}, order expects ${order.total_cents}`,
    };
  }

  if (order.payment_status === "captured") {
    return { handled: true, note: "already captured — nothing to do" };
  }

  await sb.from("orders").update({
    payment_status: "captured",
    status: order.drop_id ? "reserved" : "paid",
    paid_at: new Date().toISOString(),
    stripe_charge_id: typeof intent.latest_charge === "string" ? intent.latest_charge : null,
  }).eq("id", orderId);

  // A reservation is paid but not produced. Production waits for the drop's
  // threshold; submitting now would manufacture goods for a drop that may fail.
  if (order.drop_id) {
    return { handled: true, note: "reservation captured; awaiting drop threshold" };
  }

  // Money is recorded. Now try to manufacture.
  //
  // A failure here does NOT fail the webhook. The payment is a fact whether or
  // not Printful is reachable, and returning an error would make Stripe redeliver
  // an event we have already acted on. submitOrderToVendor records the failure
  // with a retry time; the alert comes from fulfillments, not from here.
  try {
    const result = await submitOrderToVendor(orderId);
    return result.ok
      ? { handled: true, note: `submitted to vendor as ${result.externalOrderId}` }
      : { handled: true, note: `PAID BUT NOT SUBMITTED — ${result.error?.kind}: ${result.error?.message}` };
  } catch (e) {
    return {
      handled: true,
      note: `PAID BUT NOT SUBMITTED — ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

export async function handlePaymentFailed(
  intent: Stripe.PaymentIntent,
): Promise<HandlerResult> {
  const sb = serviceClient();
  const orderId = intent.metadata?.order_id;
  if (!orderId) return { handled: false, note: "no order_id in metadata" };

  await sb.from("orders")
    .update({ payment_status: "failed", status: "cancelled", cancelled_at: new Date().toISOString() })
    .eq("id", orderId)
    // Only from a pre-payment state. A failure arriving after capture is noise,
    // and acting on it would cancel a paid order.
    .in("payment_status", ["requires_payment", "authorized"]);

  return { handled: true, note: `order ${orderId} marked failed` };
}

/** Reservation authorised but not captured — the drop is now one unit closer. */
export async function handleAmountCapturable(
  intent: Stripe.PaymentIntent,
): Promise<HandlerResult> {
  const sb = serviceClient();
  const orderId = intent.metadata?.order_id;
  if (!orderId) return { handled: false, note: "no order_id in metadata" };

  await sb.from("orders")
    .update({ payment_status: "authorized", status: "reserved" })
    .eq("id", orderId)
    .eq("payment_status", "requires_payment");

  return { handled: true, note: `order ${orderId} authorised for a drop` };
}

/**
 * A dispute. This is the case the whole payout delay exists for.
 *
 * The seller's margin may already be credited. It gets clawed back here, and the
 * store's payouts are held pending review — PROJECT.md is explicit that a
 * chargeback has to be recoverable against a future payout.
 */
export async function handleDispute(
  dispute: Stripe.Dispute,
): Promise<HandlerResult> {
  const sb = serviceClient();
  const chargeId = typeof dispute.charge === "string" ? dispute.charge : dispute.charge.id;

  const { data: order } = await sb
    .from("orders").select("id, store_id").eq("stripe_charge_id", chargeId).maybeSingle();

  if (!order) return { handled: false, note: `no order for charge ${chargeId}` };

  await sb.from("orders").update({ payment_status: "disputed" }).eq("id", order.id);
  await sb.from("stores").update({ payouts_held: true }).eq("id", order.store_id);

  // Reverse any margin already credited, once.
  const { data: credited } = await sb
    .from("ledger_entries")
    .select("amount_cents")
    .eq("order_id", order.id).eq("kind", "seller_margin").maybeSingle();

  const { data: reversed } = await sb
    .from("ledger_entries")
    .select("id").eq("order_id", order.id).eq("kind", "chargeback").maybeSingle();

  if (credited && !reversed) {
    await sb.from("ledger_entries").insert({
      store_id: order.store_id,
      order_id: order.id,
      kind: "chargeback",
      amount_cents: -credited.amount_cents,
      available_at: new Date().toISOString(),
      description: `Chargeback on order ${order.id}`,
    });
  }

  return {
    handled: true,
    note: `dispute on order ${order.id}; payouts held${credited ? ", margin reversed" : ""}`,
  };
}

export async function handleRefund(charge: Stripe.Charge): Promise<HandlerResult> {
  const sb = serviceClient();

  const { data: order } = await sb
    .from("orders").select("id, store_id, total_cents").eq("stripe_charge_id", charge.id).maybeSingle();

  if (!order) return { handled: false, note: `no order for charge ${charge.id}` };

  const fully = charge.amount_refunded >= order.total_cents;

  await sb.from("orders").update({
    payment_status: fully ? "refunded" : "partially_refunded",
    ...(fully ? { status: "refunded" } : {}),
  }).eq("id", order.id);

  const { data: credited } = await sb
    .from("ledger_entries")
    .select("amount_cents").eq("order_id", order.id).eq("kind", "seller_margin").maybeSingle();

  const { data: alreadyReversed } = await sb
    .from("ledger_entries")
    .select("id").eq("order_id", order.id).eq("kind", "refund_reversal").maybeSingle();

  if (fully && credited && !alreadyReversed) {
    await sb.from("ledger_entries").insert({
      store_id: order.store_id,
      order_id: order.id,
      kind: "refund_reversal",
      amount_cents: -credited.amount_cents,
      available_at: new Date().toISOString(),
      description: `Refund reversal on order ${order.id}`,
    });
  }

  return { handled: true, note: `order ${order.id} ${fully ? "refunded" : "partially refunded"}` };
}
