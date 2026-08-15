import type Stripe from "stripe";

import {
  handleAmountCapturable, handleDispute, handlePaymentFailed,
  handlePaymentSucceeded, handleRefund,
} from "@/lib/orders/payment";
import { requireWebhookSecret, stripe } from "@/lib/stripe/client";
import { serviceClient } from "@/lib/supabase/client";

/**
 * Stripe webhooks.
 *
 * This endpoint is where "the customer paid" becomes "the garment gets made". It
 * is the single most consequential route in the application, so the ordering is
 * deliberate:
 *
 *   1. Verify the signature. An unverified payload is discarded, full stop —
 *      anyone can POST to this URL, and acting on a forged event means
 *      manufacturing goods nobody paid for.
 *   2. Record the event. Stripe delivers at-least-once and retries for three
 *      days, so a duplicate arriving is normal, not exceptional.
 *   3. Only then act.
 *
 * Response codes matter here, because they control Stripe's retries:
 *   400 — bad signature. Never retry; the payload is not ours.
 *   200 — received and handled, or already handled.
 *   500 — we failed to process it. Stripe retries, which is what we want.
 */

// Signature verification needs the exact bytes Stripe signed, so this route must
// never run on a parsed or re-encoded body.
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const signature = req.headers.get("stripe-signature");
  if (!signature) return new Response("Missing stripe-signature", { status: 400 });

  const raw = await req.text();

  let event: Stripe.Event;
  try {
    event = stripe().webhooks.constructEvent(raw, signature, requireWebhookSecret());
  } catch (e) {
    // Includes replay attempts outside Stripe's tolerance window.
    return new Response(
      `Signature verification failed: ${e instanceof Error ? e.message : "unknown"}`,
      { status: 400 },
    );
  }

  const sb = serviceClient();
  const orderId = extractOrderId(event);

  // Claim the event. The unique constraint on stripe_event_id is what makes
  // duplicate delivery harmless — the second insert loses and we stop.
  const { error: claimError } = await sb.from("payment_events").insert({
    stripe_event_id: event.id,
    type: event.type,
    payload: event as unknown as Record<string, unknown>,
    order_id: orderId,
    attempt_count: 1,
  });

  if (claimError) {
    // 23505 is unique_violation: we have seen this event before.
    if ((claimError as { code?: string }).code === "23505") {
      const { data: prior } = await sb
        .from("payment_events").select("processed_at").eq("stripe_event_id", event.id).maybeSingle();

      if (prior?.processed_at) {
        return Response.json({ received: true, duplicate: true }, { status: 200 });
      }
      // Seen but never processed — a previous attempt died mid-flight. Count the
      // retry and fall through to try again, rather than silently dropping an
      // event whose side effects may never have run.
      const { data: prior2 } = await sb
        .from("payment_events").select("attempt_count").eq("stripe_event_id", event.id).maybeSingle();

      await sb.from("payment_events")
        .update({ attempt_count: (prior2?.attempt_count ?? 0) + 1 })
        .eq("stripe_event_id", event.id);
    } else {
      return new Response(`Could not record event: ${JSON.stringify(claimError)}`, { status: 500 });
    }
  }

  try {
    const result = await dispatch(event);

    await sb.from("payment_events")
      .update({ processed_at: new Date().toISOString(), process_error: result.handled ? null : result.note })
      .eq("stripe_event_id", event.id);

    // An unhandled event is not an error — Stripe sends plenty we do not care
    // about, and asking it to retry those forever would be pointless.
    return Response.json({ received: true, note: result.note }, { status: 200 });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);

    await sb.from("payment_events")
      .update({ process_error: message })
      .eq("stripe_event_id", event.id);

    // Left unprocessed on purpose: 500 makes Stripe redeliver, and the
    // unprocessed index is what an alert watches.
    return new Response(`Handler failed: ${message}`, { status: 500 });
  }
}

async function dispatch(event: Stripe.Event) {
  switch (event.type) {
    case "payment_intent.succeeded":
      return handlePaymentSucceeded(event.data.object as Stripe.PaymentIntent);

    case "payment_intent.payment_failed":
      return handlePaymentFailed(event.data.object as Stripe.PaymentIntent);

    case "payment_intent.amount_capturable_updated":
      return handleAmountCapturable(event.data.object as Stripe.PaymentIntent);

    case "charge.dispute.created":
    case "charge.dispute.funds_withdrawn":
      return handleDispute(event.data.object as Stripe.Dispute);

    case "charge.refunded":
      return handleRefund(event.data.object as Stripe.Charge);

    default:
      return { handled: false, note: `ignored ${event.type}` };
  }
}

/** Best-effort link back to an order, for the audit trail. */
function extractOrderId(event: Stripe.Event): string | null {
  const object = event.data.object as { metadata?: Record<string, string> };
  return object.metadata?.order_id ?? null;
}
