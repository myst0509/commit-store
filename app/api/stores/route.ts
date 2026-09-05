import { errorResponse } from "@/lib/auth/session";
import { rootDomain } from "@/lib/store/resolve";
import { publicClient, serviceClient } from "@/lib/supabase/client";

/**
 * The public store directory.
 *
 * No authentication: this is the front door, and the point is that a stranger
 * can browse it.
 *
 * A store appears only if it is active AND has at least one published product.
 * An empty storefront in a directory is worse than a shorter directory: it
 * sends a visitor to a dead end and makes the platform look abandoned.
 */

export const dynamic = "force-dynamic";

const MAX = 24;

/** Highest earners is a top 5 by default, never more than 10. */
const EARNERS_DEFAULT = 5;
const EARNERS_MAX = 10;

/**
 * Below this many qualifying stores, the leaderboard is not published at all.
 *
 * A ranking hides the amounts but not the ORDER, and order is itself
 * information. "Top 5" drawn from six stores tells everyone who is last, and
 * with two stores it is simply publishing which seller is doing better. The
 * amounts stay private either way; this keeps the ranking from being a
 * personal comparison while the platform is small.
 */
const MIN_STORES_TO_RANK = 5;

interface Row {
  id: string;
  name: string;
  subdomain: string;
  created_at: string;
  products: Array<{ id: string; name: string; blank_id: string }>;
}

export async function GET(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const limit = Math.min(Number(url.searchParams.get("limit")) || 12, MAX);
    const earnerLimit = Math.min(
      Number(url.searchParams.get("earners")) || EARNERS_DEFAULT,
      EARNERS_MAX,
    );

    // Read with the ANON client so RLS decides what is visible. The policies
    // `public reads active stores` and `public reads published products`
    // already say the right thing, and routing this through the service role
    // would mean re-implementing them by hand and getting it wrong eventually.
    const sb = publicClient();

    const { data, error } = await sb
      .from("stores")
      .select("id, name, subdomain, created_at, products!inner(id, name, blank_id)")
      .eq("status", "active")
      .eq("products.status", "published")
      .order("created_at", { ascending: false })
      .limit(MAX * 2);

    if (error) throw error;

    const rows = (data ?? []) as unknown as Row[];

    // Cover art comes from the catalog blank rather than the seller's design.
    // catalog_blanks is publicly readable when enabled; `designs` is not, so a
    // join through it would return nulls for anonymous visitors.
    const blankIds = [...new Set(rows.flatMap((r) => r.products.map((p) => p.blank_id)))];
    const covers = new Map<string, string | null>();

    if (blankIds.length) {
      const { data: blanks } = await sb
        .from("catalog_blanks")
        .select("id, image_url")
        .in("id", blankIds);
      for (const b of blanks ?? []) covers.set(b.id, b.image_url);
    }

    const card = (r: Row) => ({
      name: r.name,
      subdomain: r.subdomain,
      url: `https://${r.subdomain}.${rootDomain()}`,
      productCount: r.products.length,
      coverImageUrl: covers.get(r.products[0]?.blank_id) ?? null,
      openedAt: r.created_at,
    });

    return Response.json({
      newest: rows.slice(0, limit).map(card),
      topEarners: await rankByEarnings(rows, earnerLimit, card),
    });
  } catch (e) {
    return errorResponse(e);
  }
}

/**
 * Stores ordered by what their seller has actually earned, highest first.
 *
 * DELIBERATE SERVICE-ROLE EXCEPTION. `ledger_entries` is invisible to anonymous
 * readers by design, and should stay that way — it is where seller margin
 * lives. Ranking on it needs a cross-tenant aggregate, which is exactly what
 * RLS exists to prevent, so it is computed here with the service role and the
 * money never leaves this function.
 *
 * What crosses the boundary is the ORDER and nothing else: no totals, no
 * counts, no currency. A caller cannot tell whether first place earned ten
 * dollars or ten thousand, nor the gap between any two.
 *
 * Worth knowing: sellers have not agreed to being ranked publicly. If that
 * becomes a concern, the fix is an opt-out on the store, not a change here.
 */
async function rankByEarnings(
  rows: Row[],
  limit: number,
  card: (r: Row) => Record<string, unknown>,
): Promise<Array<Record<string, unknown>>> {
  // Not enough stores to rank without it reading as a personal comparison.
  if (rows.length < MIN_STORES_TO_RANK) return [];

  const byId = new Map(rows.map((r) => [r.id, r]));

  const sb = serviceClient();
  const { data, error } = await sb
    .from("ledger_entries")
    .select("store_id, amount_cents, kind")
    .in("store_id", [...byId.keys()])
    .eq("kind", "seller_margin");

  if (error) throw error;

  const earned = new Map<string, number>();
  for (const e of data ?? []) {
    // Signed: a clawback is negative and must pull a store down, not up.
    earned.set(e.store_id, (earned.get(e.store_id) ?? 0) + e.amount_cents);
  }

  return [...earned.entries()]
    // A store that has earned nothing is not a "highest earner". Leaving them
    // out is kinder than ranking them last.
    .filter(([, cents]) => cents > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([storeId], i) => ({
      ...card(byId.get(storeId)!),
      // Position only. No amount, ever.
      rank: i + 1,
    }));
}
