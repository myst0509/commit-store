import { NextResponse, type NextRequest } from "next/server";

import { isStorefrontHost, normalizeHost } from "@/lib/store/resolve";

/**
 * Two jobs.
 *
 * For page requests: map a seller's host onto the internal /s/[host] tree.
 * String work only — no database call. Proxy runs on every matched request, and
 * the Next 16 docs are explicit that this layer is not for data fetching.
 *
 * For /api requests: apply CORS, so a frontend hosted somewhere else can call
 * us. Handled here rather than in fifteen route files, which would drift.
 *
 * (Next 16 renamed Middleware to Proxy; same functionality, new convention.)
 */

/**
 * Origins allowed to call the API, comma-separated in CORS_ALLOWED_ORIGINS.
 *
 * An allowlist rather than `*`. These routes act on a seller's behalf with a
 * bearer token, and while `*` cannot itself leak a token, it invites every
 * page on the internet to make authenticated calls if one is ever exposed.
 */
function allowedOrigins(): string[] {
  const configured = (process.env.CORS_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);

  // Local development always works without configuration.
  return [...configured, "http://localhost:3000", "http://localhost:5173", "http://127.0.0.1:3000"];
}

function corsHeaders(origin: string | null): Headers {
  const headers = new Headers();
  if (!origin) return headers;

  const allowed = allowedOrigins();
  const permitted = allowed.some((entry) => {
    if (entry === origin) return true;
    // A single leading wildcard, for preview deployments on a shared domain:
    // https://*.lovable.app matches https://anything.lovable.app
    if (entry.startsWith("https://*.")) {
      return origin.startsWith("https://") && origin.endsWith(entry.slice("https://*".length));
    }
    return false;
  });

  if (!permitted) return headers;

  headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
  headers.set("Access-Control-Allow-Headers", "authorization,content-type");
  headers.set("Access-Control-Max-Age", "86400");
  // Origin decides the response, so caches must not serve one origin's response
  // to another.
  headers.set("Vary", "Origin");
  return headers;
}

export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (pathname.startsWith("/api/")) {
    const cors = corsHeaders(req.headers.get("origin"));

    // Preflight. Answered here because App Router returns 405 for a route with
    // no OPTIONS export, and adding one to every route would drift.
    if (req.method === "OPTIONS") {
      return new NextResponse(null, { status: 204, headers: cors });
    }

    const res = NextResponse.next();
    cors.forEach((value, key) => res.headers.set(key, value));
    return res;
  }

  const host = normalizeHost(req.headers.get("host") ?? "");

  // Our own hosts — marketing site, seller dashboard — render normally.
  if (!isStorefrontHost(host)) return NextResponse.next();

  const url = req.nextUrl.clone();
  url.pathname = `/s/${host}${pathname}`;
  return NextResponse.rewrite(url);
}

export const config = {
  // /api is now included, for CORS. Still skips Next internals and static files.
  matcher: ["/((?!_next/|favicon.ico|.*\\..*).*)"],
};
