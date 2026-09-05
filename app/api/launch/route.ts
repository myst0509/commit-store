import { errorResponse, requireSeller } from "@/lib/auth/session";
import { getLaunchState, performStep } from "@/lib/launch/actions";
import type { StepKey } from "@/lib/launch/steps";

/**
 * The launch path, as an API.
 *
 * GET  — the full sequence with each step's status, what it is blocked by, and
 *        which one the seller should be looking at.
 * POST — performs a step.
 *
 * The store comes from the session, never the body. A seller can only advance
 * their own launch path, and prerequisites are enforced server-side because
 * `store_progress` is select-only under RLS — a client claiming completion
 * proves nothing.
 */

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  try {
    const session = await requireSeller(req);
    const state = await getLaunchState(session.storeId);

    return Response.json({
      store: { name: session.storeName, subdomain: session.subdomain },
      progress: state.summary,
      current: state.current && {
        key: state.current.key,
        title: state.current.title,
        outcome: state.current.outcome,
      },
      steps: state.steps.map((s) => ({
        key: s.key,
        day: s.dayIndex,
        title: s.title,
        outcome: s.outcome,
        status: s.status,
        blockedBy: s.blockedBy,
        completedAt: s.completedAt,
        // Whether "Not now" should be offered on this step.
        optional: Boolean(s.optional),
      })),
    });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: Request): Promise<Response> {
  try {
    const session = await requireSeller(req);
    const body = (await req.json().catch(() => ({}))) as {
      step?: string;
      input?: Record<string, unknown>;
      skip?: boolean;
    };

    if (!body.step) {
      return Response.json({ error: "Which step?" }, { status: 400 });
    }

    const result = await performStep(
      session.storeId,
      body.step as StepKey,
      body.input ?? {},
      body.skip === true,
    );

    const state = await getLaunchState(session.storeId);

    return Response.json({
      step: result.step,
      result: result.result,
      progress: state.summary,
      next: state.current && { key: state.current.key, title: state.current.title },
    });
  } catch (e) {
    return errorResponse(e);
  }
}
