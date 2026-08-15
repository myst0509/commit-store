import { resolveDueDrops } from "@/lib/drops/resolve";

/**
 * Scheduled drop resolution: charge the holds when a threshold is met, release
 * them when a drop closes short.
 *
 * Secret-gated like the other scheduled routes — this one both captures money
 * and cancels authorisations, so an open URL here is worse than merely noisy.
 *
 * Hourly. Stripe authorisations lapse after roughly a week, so a drop that hits
 * its threshold should be captured well within that; hourly leaves ample margin
 * without charging people at unpredictable hours.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: Request): Promise<Response> {
  const expected = process.env.CRON_SECRET;
  if (!expected) return new Response("CRON_SECRET is not configured", { status: 503 });

  const presented = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!timingSafeEqual(presented, expected)) {
    return new Response("Unauthorized", { status: 401 });
  }

  const started = Date.now();

  try {
    const outcomes = await resolveDueDrops();

    return Response.json({
      ok: true,
      ms: Date.now() - started,
      examined: outcomes.length,
      captured: outcomes.filter((o) => o.action === "captured").length,
      released: outcomes.filter((o) => o.action === "released").length,
      waiting: outcomes.filter((o) => o.action === "waiting").length,
      // Declined cards on an otherwise successful drop. Worth seeing: those
      // customers reserved something they will not receive.
      declines: outcomes.reduce((n, o) => n + o.failures.length, 0),
      outcomes,
    }, { status: 200 });
  } catch (e) {
    return new Response(
      `Drop resolution failed: ${e instanceof Error ? e.message : String(e)}`,
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
