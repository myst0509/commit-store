import { createClient } from "@supabase/supabase-js";

import { UserError } from "@/lib/errors";
import { serviceClient } from "@/lib/supabase/client";

/**
 * Who is calling, and which store may they act on.
 *
 * Every seller-facing API route starts here. The rule that makes the rest safe:
 * a request supplies a token, never a store id. The store is derived from
 * ownership on our side, so a caller cannot address someone else's store by
 * changing a parameter — the commonest way a multi-tenant API leaks.
 *
 * The token is verified with Supabase rather than decoded locally. That costs a
 * round trip and buys revocation: a signed-out or deleted user stops working
 * immediately instead of whenever their JWT happens to expire.
 */

export interface SellerSession {
  userId: string;
  email: string | null;
  /**
   * The person's own name, when we actually know it.
   *
   * Supplied by an OAuth provider such as Google, which returns it in the
   * user's metadata after they consent. Null for email-and-password signups,
   * because nothing ever asked them.
   *
   * NOT derived from the email address. "sohamp1005@gmail.com" would yield
   * "Sohamp1005", and greeting someone by a mangled version of their address
   * is worse than not greeting them at all.
   */
  name: string | null;
  storeId: string;
  storeName: string;
  subdomain: string;
}

export class AuthError extends Error {
  constructor(message: string, public status: 401 | 403 | 404) {
    super(message);
    this.name = "AuthError";
  }
}

/** Bearer token from the Authorization header. */
export function bearerToken(req: Request): string | null {
  const header = req.headers.get("authorization");
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1] : null;
}

/**
 * Verifies the caller and resolves the store they own.
 *
 * Throws rather than returning null: every caller must handle the failure, and
 * an ignored null here is an unauthenticated request served as if it were
 * authenticated.
 */
export async function requireSeller(req: Request): Promise<SellerSession> {
  const token = bearerToken(req);
  if (!token) throw new AuthError("Sign in to continue", 401);

  const anon = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { persistSession: false } },
  );

  const { data, error } = await anon.auth.getUser(token);
  if (error || !data.user) throw new AuthError("Your session has expired", 401);

  // Ownership is read with the service role deliberately. This is the lookup
  // that DECIDES what the caller may touch, so it must see the truth rather
  // than a view already filtered by the caller's own permissions.
  const sb = serviceClient();
  const { data: store } = await sb
    .from("stores")
    .select("id, name, subdomain")
    .eq("owner_id", data.user.id)
    .maybeSingle();

  if (!store) throw new AuthError("You do not have a store yet", 404);

  // Google returns `full_name` and `name`; other providers vary. Take the
  // first that is actually a non-empty string.
  const metadata = (data.user.user_metadata ?? {}) as Record<string, unknown>;
  const name = [metadata.full_name, metadata.name]
    .map((v) => (typeof v === "string" ? v.trim() : ""))
    .find((v) => v.length > 0) ?? null;

  return {
    userId: data.user.id,
    email: data.user.email ?? null,
    name,
    storeId: store.id,
    storeName: store.name,
    subdomain: store.subdomain,
  };
}

/**
 * Turns an AuthError into a response, and anything else into a 500 that does
 * not leak internals to the caller.
 */
export function errorResponse(e: unknown): Response {
  if (e instanceof AuthError) {
    return Response.json({ error: e.message }, { status: e.status });
  }

  // Written for the caller by the code that threw it, so passed through.
  if (e instanceof UserError) {
    return Response.json({ error: e.message }, { status: 400 });
  }

  // Anything else is ours — a bug, a missing environment variable, a database
  // error. The message may carry internals, so it does not leave the server.
  return Response.json({ error: "Something went wrong" }, { status: 500 });
}
