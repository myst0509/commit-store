import { findStuckOrders, retryDueFulfillments } from "@/lib/orders/retry";

/**
 * Scheduled sweep for orders that were paid but never manufactured.
 *
 * Runs on a schedule (see vercel.json). Protected by a shared secret, because
 * this endpoint places vendor orders — an open URL that spends money is not a
 * URL to leave open, and "nobody knows the path" is not access control.
 *
 * Always returns 200 with a report, even when individual orders failed. A
 * scheduler retrying the whole sweep because one order is unfixable would just
 * hammer the vendor; per-order backoff is handled inside the sweep.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: Request): Promise<Response> {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    return new Response("CRON_SECRET is not configured", { status: 503 });
  }

  // Vercel Cron sends the secret as a bearer token.
  const presented = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!timingSafeEqual(presented, expected)) {
    return new Response("Unauthorized", { status: 401 });
  }

  const started = Date.now();

  try {
    const sweep = await retryDueFulfillments(25);
    const stuck = await findStuckOrders();

    const report = {
      ok: true,
      ms: Date.now() - started,
      retried: sweep.examined,
      succeeded: sweep.succeeded,
      stillFailing: sweep.failed,
      escalated: sweep.escalated,
      // Two counts a person should act on. Anything above zero here means an
      // order was paid for and may never be made.
      alert: {
        paidButNeverSubmitted: stuck.neverSubmitted.length,
        givenUp: stuck.escalated.length,
      },
      outcomes: sweep.outcomes,
      stuck,
    };

    return Response.json(report, { status: 200 });
  } catch (e) {
    // A sweep that cannot run at all IS worth retrying, unlike a single order
    // that cannot be fixed.
    return new Response(
      `Sweep failed: ${e instanceof Error ? e.message : String(e)}`,
      { status: 500 },
    );
  }
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length || a.length === 0) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
