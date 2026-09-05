import { errorResponse } from "@/lib/auth/session";
import { rootDomain } from "@/lib/store/resolve";
import { publicClient } from "@/lib/supabase/client";

/**
 * The public store directory.
 *
 * No authentication: this is the front door, and the whole point is that a
 * stranger can browse it. Read with the ANON client so RLS decides what is
 * visible — `public reads active stores` and `public reads published products`
 * already say exactly the right thing, and routing this through the service
 * role would mean re-implementing that by hand and getting it wrong eventually.
 *
 * A store appears only if it is active AND has at least one published product.
 * An empty storefront in a directory is worse than a shorter directory: it
 * sends a visitor to a dead end and makes the platform look abandoned.
 */

export const dynamic = "force-dynamic";

const MAX = 24;

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

    const sb = publicClient();

    // RLS filters to active stores; the inner select filters to published
    // products. Both are enforced by the database, not by this code.
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

    const stores = rows.map((r) => ({
      name: r.name,
      subdomain: r.subdomain,
      url: `https://${r.subdomain}.${rootDomain()}`,
      productCount: r.products.length,
      coverImageUrl: covers.get(r.products[0]?.blank_id) ?? null,
      openedAt: r.created_at,
    }));

    return Response.json({
      newest: stores.slice(0, limit),

      /**
       * Ranked by how much a seller has published, NOT by sales.
       *
       * Sales figures live in `orders`, which anonymous visitors cannot read
       * and should not — a public directory that reveals how much each seller
       * is selling is a decision about exposing their performance, not a
       * sorting detail. Until that is decided deliberately, this ranks on
       * public data and says so rather than implying a popularity it cannot
       * measure.
       */
      popular: [...stores]
        .sort((a, b) => b.productCount - a.productCount)
        .slice(0, limit),

      rankedBy: "product_count",
      total: stores.length,
    });
  } catch (e) {
    return errorResponse(e);
  }
}
