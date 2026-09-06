import { resolveDueDrops } from "@/lib/drops/resolve";
import { findStuckOrders, retryDueFulfillments } from "@/lib/orders/retry";
import { isPayoutWindow, PAYOUT_DAY_UTC, PAYOUT_HOUR_UTC, runPayouts } from "@/lib/payouts/run";

/**
 * One scheduled endpoint that runs all the background work.
 *
 * Vercel's Hobby plan allows two cron jobs at most, firing once a day. Three
 * separate schedules — one of them every ten minutes — is rejected at deploy
 * time. Rather than drop the frequency and leave paid orders unsubmitted for up
 * to a day, everything moves behind one URL that any scheduler can call as often
 * as it likes. See DEPLOY.md.
 *
 * Each sweep is independent: one failing must not stop the others, because they
 * fail for unrelated reasons and the ones still working are still needed.
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
  const url = new URL(req.url);
  // `?jobs=retry,drops` to run a subset by hand.
  const only = url.searchParams.get("jobs")?.split(",").map((s) => s.trim());
  const wants = (job: string) => !only || only.includes(job);

  const report: Record<string, unknown> = { ok: true };
  const failures: string[] = [];

  if (wants("retry")) {
    try {
      const sweep = await retryDueFulfillments(25);
      const stuck = await findStuckOrders();
      report.retry = {
        examined: sweep.examined,
        succeeded: sweep.succeeded,
        escalated: sweep.escalated,
        // Above zero means someone paid for something that may never be made.
        alert: {
          paidButNeverSubmitted: stuck.neverSubmitted.length,
          givenUp: stuck.escalated.length,
        },
      };
    } catch (e) {
      failures.push(`retry: ${message(e)}`);
    }
  }

  if (wants("drops")) {
    try {
      const outcomes = await resolveDueDrops();
      report.drops = {
        examined: outcomes.length,
        captured: outcomes.filter((o) => o.action === "captured").length,
        released: outcomes.filter((o) => o.action === "released").length,
        waiting: outcomes.filter((o) => o.action === "waiting").length,
        declines: outcomes.reduce((n, o) => n + o.failures.length, 0),
      };
    } catch (e) {
      failures.push(`drops: ${message(e)}`);
    }
  }

  // Weekly, not daily: Stripe charges per payout sent, so a daily cadence is a
  // real cost that falls hardest on small sellers. See lib/payouts/run.ts.
  if (wants("payouts") && (isPayoutWindow(new Date()) || only?.includes("payouts"))) {
    try {
      const run = await runPayouts();
      report.payouts = {
        storesExamined: run.examined,
        paidCents: run.paidCents,
        paid: run.results.filter((r) => r.status === "paid").length,
        failed: run.results.filter((r) => r.status === "failed").length,
      };
    } catch (e) {
      failures.push(`payouts: ${message(e)}`);
    }
  } else if (wants("payouts")) {
    const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    report.payouts = {
      skipped: `runs weekly, ${days[PAYOUT_DAY_UTC]} at ${PAYOUT_HOUR_UTC}:00 UTC`,
    };
  }

  report.ms = Date.now() - started;

  if (failures.length) {
    // 500 so a scheduler retries, but the report still says what did work.
    report.ok = false;
    report.failures = failures;
    return Response.json(report, { status: 500 });
  }

  return Response.json(report, { status: 200 });
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length || a.length === 0) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
