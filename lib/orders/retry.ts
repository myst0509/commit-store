import { submitOrderToVendor } from "@/lib/orders/pipeline";
import { serviceClient } from "@/lib/supabase/client";

/**
 * Recovering orders that were paid but never manufactured.
 *
 * PROJECT.md names this the worst failure: money taken, nothing made. It has two
 * shapes, and both are handled here.
 *
 *   1. The vendor call failed and left a fulfillment row with a retry time.
 *   2. There is no fulfillment row at all — the webhook died between recording
 *      the payment and attempting submission. This is the quieter and more
 *      dangerous case, because nothing anywhere is flagged as broken.
 *
 * Retries are safe because `submitOrderToVendor` is idempotent on
 * `orders.idempotency_key`: it looks for an existing vendor order before creating
 * one, so a retry after an ambiguous timeout returns the original rather than
 * making a second garment.
 */

/**
 * Backoff, in minutes, indexed by attempts already made.
 *
 * Front-loaded because most failures are transient — a rate limit or a blip —
 * and a customer is waiting. It stretches out afterwards because a fifth failure
 * is usually something a person has to look at, and hammering the vendor will
 * not fix it.
 */
const BACKOFF_MINUTES = [10, 30, 120, 360, 1440];

/** After this many attempts, stop retrying and escalate. */
export const MAX_ATTEMPTS = 6;

/** An order paid longer ago than this with nothing submitted is an incident. */
const STUCK_AFTER_MINUTES = 30;

export type RetryDecision =
  | { action: "retry"; afterMinutes: number }
  | { action: "escalate"; reason: string }
  | { action: "stop"; reason: string };

/**
 * What to do about a failed submission. Pure, so the schedule and the escalation
 * rules can be tested without a database, a vendor, or a running server —
 * everything around this function needs all three, which is exactly why the
 * decision itself should not.
 */
export function decideRetry(kind: string, priorAttempts: number): RetryDecision {
  // Not a failure: fulfillment is switched off deliberately. Counting attempts
  // against it would exhaust the budget while nothing was ever tried.
  if (kind === "blocked") {
    return { action: "stop", reason: "fulfillment disabled" };
  }

  // These fail identically forever. Retrying wastes the attempt budget and
  // delays the moment a person looks at it.
  if (kind === "auth" || kind === "validation") {
    return { action: "escalate", reason: "not retryable" };
  }

  if (priorAttempts + 1 >= MAX_ATTEMPTS) {
    return { action: "escalate", reason: "attempts exhausted" };
  }

  return {
    action: "retry",
    afterMinutes: BACKOFF_MINUTES[Math.min(priorAttempts, BACKOFF_MINUTES.length - 1)],
  };
}

export interface RetryOutcome {
  orderId: string;
  attempt: number;
  ok: boolean;
  note: string;
  /** True when we have given up and a person needs to intervene. */
  escalated: boolean;
}

export interface RetrySweep {
  examined: number;
  succeeded: number;
  failed: number;
  escalated: number;
  outcomes: RetryOutcome[];
}

/**
 * One pass over everything due for retry.
 *
 * `limit` bounds the work so a scheduled run cannot stall on a large backlog —
 * the next run picks up where this one stopped.
 */
export async function retryDueFulfillments(limit = 25): Promise<RetrySweep> {
  const sb = serviceClient();
  const now = new Date().toISOString();

  // Shape 1: recorded failures whose backoff has elapsed.
  const { data: due } = await sb
    .from("fulfillments")
    .select("id, order_id, attempt_count, status, last_error")
    .lte("next_retry_at", now)
    .not("next_retry_at", "is", null)
    .lt("attempt_count", MAX_ATTEMPTS)
    .order("next_retry_at", { ascending: true })
    .limit(limit);

  // Shape 2: paid orders with no fulfillment row at all.
  const orphans = await findUnsubmittedPaidOrders(limit);

  const targets = [
    ...(due ?? []).map((f) => ({ orderId: f.order_id, attempt: f.attempt_count })),
    ...orphans.map((o) => ({ orderId: o.orderId, attempt: 0 })),
  ];

  const seen = new Set<string>();
  const outcomes: RetryOutcome[] = [];

  for (const target of targets) {
    if (seen.has(target.orderId)) continue;
    seen.add(target.orderId);
    outcomes.push(await retryOne(target.orderId, target.attempt));
  }

  return {
    examined: outcomes.length,
    succeeded: outcomes.filter((o) => o.ok).length,
    failed: outcomes.filter((o) => !o.ok && !o.escalated).length,
    escalated: outcomes.filter((o) => o.escalated).length,
    outcomes,
  };
}

async function retryOne(orderId: string, priorAttempts: number): Promise<RetryOutcome> {
  const sb = serviceClient();
  const attempt = priorAttempts + 1;

  let result;
  try {
    result = await submitOrderToVendor(orderId);
  } catch (e) {
    result = {
      ok: false,
      error: { kind: "unknown", message: e instanceof Error ? e.message : String(e), retryable: true },
    } as Awaited<ReturnType<typeof submitOrderToVendor>>;
  }

  if (result.ok) {
    // submitOrderToVendor has already cleared the retry state.
    return { orderId, attempt, ok: true, note: `submitted as ${result.externalOrderId}`, escalated: false };
  }

  const kind = result.error?.kind ?? "unknown";
  const decision = decideRetry(kind, priorAttempts);

  if (decision.action === "stop") {
    await sb.from("fulfillments").update({ next_retry_at: null }).eq("order_id", orderId);
    return { orderId, attempt, ok: false, escalated: false, note: `${decision.reason}; not retrying` };
  }

  if (decision.action === "escalate") {
    await sb.from("fulfillments").update({
      status: "failed",
      next_retry_at: null,
      last_error: {
        kind, message: result.error?.message,
        escalated: true, reason: decision.reason,
      },
    }).eq("order_id", orderId);

    return {
      orderId, attempt, ok: false, escalated: true,
      note: `${decision.reason}: ${kind} — ${result.error?.message}`,
    };
  }

  await sb.from("fulfillments").update({
    next_retry_at: new Date(Date.now() + decision.afterMinutes * 60_000).toISOString(),
  }).eq("order_id", orderId);

  return {
    orderId, attempt, ok: false, escalated: false,
    note: `${kind}: retrying in ${decision.afterMinutes}m`,
  };
}

/**
 * Paid orders that never reached the vendor.
 *
 * The dangerous silence: money captured, no fulfillment row, nothing marked
 * failed anywhere.
 */
export async function findUnsubmittedPaidOrders(limit = 25): Promise<Array<{
  orderId: string;
  paidAt: string;
  totalCents: number;
  minutesSincePaid: number;
}>> {
  const sb = serviceClient();

  const { data: paid } = await sb
    .from("orders")
    .select("id, paid_at, total_cents")
    .eq("payment_status", "captured")
    .eq("status", "paid")
    .not("paid_at", "is", null)
    .order("paid_at", { ascending: true })
    .limit(limit * 4);

  if (!paid?.length) return [];

  const { data: existing } = await sb
    .from("fulfillments")
    .select("order_id")
    .in("order_id", paid.map((o) => o.id));

  const has = new Set((existing ?? []).map((f) => f.order_id));

  return paid
    .filter((o) => !has.has(o.id))
    .slice(0, limit)
    .map((o) => ({
      orderId: o.id,
      paidAt: o.paid_at!,
      totalCents: o.total_cents,
      minutesSincePaid: Math.floor((Date.now() - Date.parse(o.paid_at!)) / 60_000),
    }));
}

/**
 * Everything a human needs to see. Meant for an alert, not a dashboard.
 *
 * Reported separately from the sweep because these are the cases the sweep could
 * not fix on its own.
 */
export async function findStuckOrders(): Promise<{
  neverSubmitted: Awaited<ReturnType<typeof findUnsubmittedPaidOrders>>;
  escalated: Array<{ orderId: string; attempts: number; error: unknown }>;
}> {
  const sb = serviceClient();

  const neverSubmitted = (await findUnsubmittedPaidOrders(100))
    .filter((o) => o.minutesSincePaid >= STUCK_AFTER_MINUTES);

  const { data: escalated } = await sb
    .from("fulfillments")
    .select("order_id, attempt_count, last_error")
    .eq("status", "failed")
    .is("next_retry_at", null)
    .limit(100);

  return {
    neverSubmitted,
    escalated: (escalated ?? [])
      // Blocked-by-kill-switch is not an incident.
      .filter((f) => (f.last_error as { kind?: string } | null)?.kind !== "blocked")
      .map((f) => ({ orderId: f.order_id, attempts: f.attempt_count, error: f.last_error })),
  };
}
