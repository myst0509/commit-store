import { errorResponse, requireSeller } from "@/lib/auth/session";
import { UserError } from "@/lib/errors";
import { rootDomain, type StoreTheme } from "@/lib/store/resolve";
import { normalizeBrandName, normalizeSubdomain, normalizeTheme, THEME_KEYS } from "@/lib/store/settings";
import { serviceClient } from "@/lib/supabase/client";

/**
 * The seller's own store settings.
 *
 * GET   — name, web address, status and theme.
 * PATCH — change any of them.
 *
 * Until this existed a store could only ever be named once, by the launch
 * path's first step, and `stores.theme` was read by the storefront and written
 * by nothing at all.
 *
 * The store comes from the session, never the body. A seller can only edit
 * their own.
 */

export const dynamic = "force-dynamic";

interface StoreRow {
  id: string;
  name: string;
  subdomain: string;
  status: string;
  theme: StoreTheme | null;
  custom_domain: string | null;
  first_sale_at: string | null;
}

/**
 * `stores.theme` is not purely a theme. The launch path's waitlist step writes
 * `waitlistOpen` into the same jsonb column, and normalizeTheme rejects keys it
 * does not know — so handing the raw column to a settings screen that sends it
 * back would fail the moment a seller opened their waitlist.
 *
 * The API therefore shows only the five theme keys, and PATCH puts back
 * whatever else was in there.
 */
function splitTheme(stored: Record<string, unknown> | null) {
  const theme: Record<string, unknown> = {};
  const other: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(stored ?? {})) {
    if ((THEME_KEYS as readonly string[]).includes(k)) theme[k] = v;
    else other[k] = v;
  }
  return { theme, other };
}

function present(row: StoreRow) {
  return {
    name: row.name,
    subdomain: row.subdomain,
    status: row.status,
    url: `https://${row.subdomain}.${rootDomain()}`,
    customDomain: row.custom_domain,
    theme: splitTheme(row.theme as Record<string, unknown> | null).theme,
    // Changing a web address after people have the old one is a different
    // decision from changing it before launch, so the screen needs to know.
    hasSold: Boolean(row.first_sale_at),
  };
}

async function load(storeId: string): Promise<StoreRow> {
  const sb = serviceClient();
  const { data, error } = await sb
    .from("stores")
    .select("id, name, subdomain, status, theme, custom_domain, first_sale_at")
    .eq("id", storeId)
    .single();

  if (error || !data) throw new Error(`Store ${storeId} not found`);
  return data as StoreRow;
}

export async function GET(req: Request): Promise<Response> {
  try {
    const session = await requireSeller(req);
    return Response.json(present(await load(session.storeId)));
  } catch (e) {
    return errorResponse(e);
  }
}

export async function PATCH(req: Request): Promise<Response> {
  try {
    const session = await requireSeller(req);
    const body = (await req.json().catch(() => ({}))) as {
      name?: unknown;
      subdomain?: unknown;
      theme?: unknown;
    };

    const patch: Record<string, unknown> = {};

    if (body.name !== undefined) {
      patch.name = normalizeBrandName(body.name);
    }

    if (body.subdomain !== undefined) {
      const subdomain = normalizeSubdomain(body.subdomain);
      const sb = serviceClient();

      // Collisions are the seller's to resolve. Silently appending a number to
      // the address they just chose is worse than saying it is taken.
      const { data: taken } = await sb
        .from("stores")
        .select("id")
        .eq("subdomain", subdomain)
        .neq("id", session.storeId)
        .maybeSingle();

      if (taken) throw new UserError(`"${subdomain}" is already taken. Try another`);
      patch.subdomain = subdomain;
    }

    if (body.theme !== undefined) {
      // Replaces the THEME keys rather than merging them. A partial merge makes
      // "remove this colour" impossible to express, and the screen always holds
      // the whole theme. Non-theme flags living in the same column, such as the
      // waitlist step's waitlistOpen, are carried across untouched.
      const current = await load(session.storeId);
      const { other } = splitTheme(current.theme as Record<string, unknown> | null);
      patch.theme = { ...other, ...normalizeTheme(body.theme) };
    }

    if (Object.keys(patch).length === 0) {
      throw new UserError("Nothing to change");
    }

    const sb = serviceClient();
    const { error } = await sb.from("stores").update(patch).eq("id", session.storeId);
    if (error) throw error;

    return Response.json(present(await load(session.storeId)));
  } catch (e) {
    return errorResponse(e);
  }
}
