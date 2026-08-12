import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Two clients, two very different trust levels. Which one you reach for is a
 * security decision, not a convenience one.
 */

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;

/**
 * Publishable key. Every query goes through RLS.
 *
 * This is the default. Use it for anything a user sees — storefronts, dashboards,
 * catalog browsing. If a query returns nothing, that is RLS working, not a bug to
 * route around with the service client.
 */
export function publicClient(): SupabaseClient {
  return createClient(url, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    auth: { persistSession: false },
  });
}

/**
 * Secret key. BYPASSES RLS ENTIRELY.
 *
 * Only for order processing, vendor calls, and catalog sync — work with no user
 * behind it. Never import this into a client component. The runtime guard below is
 * a backstop, not the protection: the real protection is that the key has no
 * NEXT_PUBLIC_ prefix, so it is never bundled for the browser.
 */
export function serviceClient(): SupabaseClient {
  if (typeof window !== "undefined") {
    throw new Error("serviceClient() called in the browser — this bypasses RLS");
  }

  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set");

  return createClient(url, key, { auth: { persistSession: false } });
}
