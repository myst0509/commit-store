import { normalizeDisplayName } from "@/lib/account";
import { errorResponse, requireSeller } from "@/lib/auth/session";
import { serviceClient } from "@/lib/supabase/client";

/**
 * The person, as distinct from their store.
 *
 * GET   — what we know about them.
 * PATCH — set what they want to be called.
 *
 * The name lives on the auth user rather than on `stores`, because the store is
 * the brand and this is the human. One person may eventually own more than one
 * store, and their name should not be duplicated across them.
 *
 * Written through the service role rather than by the browser calling
 * `supabase.auth.updateUser` directly. That path would work, but it would skip
 * validation entirely, and a 4,000-character "name" reaching a greeting is the
 * sort of thing nobody notices until it is on screen.
 *
 * NOTE: user metadata is writable by the user in Supabase. It is fine for a
 * display name and must never be trusted for anything that grants access.
 */

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  try {
    const session = await requireSeller(req);
    return Response.json({
      name: session.name,
      email: session.email,
      // The screen that asks "what should we call you?" should ask once, not
      // every time the dashboard loads.
      needsName: session.name === null,
    });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function PATCH(req: Request): Promise<Response> {
  try {
    const session = await requireSeller(req);
    const body = (await req.json().catch(() => ({}))) as { name?: unknown };

    // null clears it deliberately; the greeting then disappears rather than
    // falling back to something invented.
    const name = normalizeDisplayName(body.name);

    const sb = serviceClient();
    const { error } = await sb.auth.admin.updateUserById(session.userId, {
      user_metadata: { full_name: name },
    });
    if (error) throw error;

    return Response.json({ name, email: session.email, needsName: name === null });
  } catch (e) {
    return errorResponse(e);
  }
}
