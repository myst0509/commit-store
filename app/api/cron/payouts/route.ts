import { runPayouts } from "@/lib/payouts/run";

/**
 * Scheduled payout run.
 *
 * Same protection as the retry sweep: this endpoint moves money out of the
 * platform account, so it is secret-gated rather than merely obscure.
 *
 * Daily, not hourly. Nothing becomes payable faster than net-14 allows, and a
 * once-a-day run keeps a seller's statement legible.
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
    const run = await runPayouts();

    return Response.json({
      ok: true,
      ms: Date.now() - started,
      storesExamined: run.examined,
      paidCents: run.paidCents,
      paid: run.results.filter((r) => r.status === "paid").length,
      skipped: run.results.filter((r) => r.status === "skipped").length,
      // Above zero means a seller expected money and did not get it.
      failed: run.results.filter((r) => r.status === "failed").length,
      results: run.results,
    }, { status: 200 });
  } catch (e) {
    return new Response(
      `Payout run failed: ${e instanceof Error ? e.message : String(e)}`,
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
