import { errorResponse, requireSeller } from "@/lib/auth/session";
import { createOnboardingLink, syncConnectStatus } from "@/lib/payouts/connect";

/**
 * Bank details, via Stripe's hosted onboarding.
 *
 * GET  — where the seller stands, and what Stripe still wants.
 * POST — a fresh link into the hosted flow.
 *
 * The link is generated per click and never stored: Stripe's are single-use and
 * short-lived by design. We never see identity documents or bank numbers, which
 * is the entire reason for using Express accounts.
 */

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  try {
    const session = await requireSeller(req);
    const status = await syncConnectStatus(session.storeId);

    return Response.json({
      connected: Boolean(status.accountId),
      ready: status.payoutsEnabled,
      detailsSubmitted: status.detailsSubmitted,
      // Stripe's own requirement codes. Shown so a stalled seller learns what
      // is missing rather than staring at "pending".
      outstanding: status.requirements,
      disabledReason: status.disabledReason,
    });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: Request): Promise<Response> {
  try {
    const session = await requireSeller(req);
    const body = (await req.json().catch(() => ({}))) as {
      returnUrl?: string; refreshUrl?: string;
    };

    // Server-only, so deliberately not NEXT_PUBLIC_: that prefix would inline
    // the value into the browser bundle and pin it at build time.
    const base = process.env.APP_ORIGIN ?? "http://app.localhost:3000";

    // Only our own URLs. An attacker-supplied return_url would send a seller
    // back from Stripe onto a page of someone else's choosing.
    const safe = (url: string | undefined, fallback: string) =>
      url && url.startsWith(base) ? url : fallback;

    const link = await createOnboardingLink(session.storeId, {
      returnUrl: safe(body.returnUrl, `${base}/settings/payouts?done=1`),
      refreshUrl: safe(body.refreshUrl, `${base}/settings/payouts?refresh=1`),
    });

    return Response.json({ url: link });
  } catch (e) {
    return errorResponse(e);
  }
}
