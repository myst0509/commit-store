import { NextResponse, type NextRequest } from "next/server";

import { isStorefrontHost, normalizeHost } from "@/lib/store/resolve";

/**
 * Maps a seller's host onto the internal /s/[host] tree.
 *
 * (Next 16 renamed Middleware to Proxy; same functionality, new file convention.)
 *
 * This does string work only — no database call. Proxy runs on every matched
 * request, so a Supabase lookup here would put a round trip in front of every
 * storefront page. The docs are explicit that this layer is not for data fetching.
 * Resolution happens in the server component instead, where the result can be
 * cached and a miss can render a real 404.
 */
export function proxy(req: NextRequest) {
  const host = normalizeHost(req.headers.get("host") ?? "");

  // Our own hosts — marketing site, seller dashboard — render normally.
  if (!isStorefrontHost(host)) return NextResponse.next();

  const url = req.nextUrl.clone();
  url.pathname = `/s/${host}${req.nextUrl.pathname}`;
  return NextResponse.rewrite(url);
}

export const config = {
  // Skip Next internals, API routes, and anything with a file extension.
  matcher: ["/((?!_next/|api/|favicon.ico|.*\\..*).*)"],
};
