import { compareSizes } from "@/lib/size";
import { publicClient } from "@/lib/supabase/client";
import { resolveStore } from "@/lib/store/resolve";
import { serviceClient } from "@/lib/supabase/client";

/**
 * A storefront's public contents, as JSON.
 *
 * The store is resolved from the Host header, so this returns whatever the
 * caller's storefront sells and nothing else. No authentication: it is the same
 * information the server-rendered pages already show a visitor.
 *
 * NOTE ON SEO. `/s/[host]` renders this same data server-side, and that is what
 * PROJECT.md requires — a seller with no audience depends on being findable. A
 * client-rendered storefront built on this endpoint would hand that away. Use
 * it for cart, live drop counts and anything interactive; keep the product
 * pages themselves server-rendered.
 */

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  try {
    const store = await resolveStore(req.headers.get("host") ?? "");
    if (!store) return Response.json({ error: "Storefront not found" }, { status: 404 });

    // Publishable key: the RLS policies decide what a visitor may see, so
    // unpublished products and inactive stores are filtered by the database
    // rather than by a condition someone could forget to write.
    const sb = publicClient();

    const { data: products } = await sb
      .from("products")
      .select(
        `id, name, slug, description,
         catalog_blanks ( brand, model, image_url ),
         product_variants ( id, retail_price_cents, is_enabled, catalog_variants ( color, size, in_stock ) )`,
      )
      .eq("store_id", store.id)
      .eq("status", "published")
      .order("created_at", { ascending: false });

    // Live drop progress, so a storefront can show "18 of 25 reserved". Read
    // with the service role because reservation counts come from orders, which
    // a visitor cannot see — only the aggregate is exposed, never the orders.
    const admin = serviceClient();
    const { data: drops } = await admin
      .from("drops")
      .select("id, product_id, threshold_units, closes_at, status, orders(order_items(quantity))")
      .eq("store_id", store.id)
      .eq("status", "open");

    const dropByProduct = new Map<string, {
      id: string; thresholdUnits: number; reservedUnits: number; closesAt: string;
    }>();

    for (const d of drops ?? []) {
      const reserved = ((d.orders ?? []) as Array<{ order_items: Array<{ quantity: number }> }>)
        .reduce((n, o) => n + (o.order_items ?? []).reduce((m, i) => m + i.quantity, 0), 0);
      dropByProduct.set(d.product_id, {
        id: d.id, thresholdUnits: d.threshold_units,
        reservedUnits: reserved, closesAt: d.closes_at,
      });
    }

    return Response.json({
      store: { name: store.name, subdomain: store.subdomain, theme: store.theme },
      products: (products ?? []).map((p) => {
        const blank = first(p.catalog_blanks);
        const variants = (p.product_variants ?? [])
          .filter((v: { is_enabled: boolean }) => v.is_enabled)
          .map((v: VariantRow) => {
            const cv = first(v.catalog_variants);
            return {
              id: v.id,
              color: cv?.color ?? "",
              size: cv?.size ?? "",
              inStock: cv?.in_stock ?? false,
              priceCents: v.retail_price_cents,
            };
          })
          .sort((x, y) => x.color.localeCompare(y.color) || compareSizes(x.size, y.size));

        return {
          id: p.id,
          name: p.name,
          slug: p.slug,
          description: p.description,
          blank: [blank?.brand, blank?.model].filter(Boolean).join(" ").trim(),
          imageUrl: blank?.image_url ?? null,
          fromPriceCents: variants.length ? Math.min(...variants.map((v) => v.priceCents)) : null,
          variants,
          drop: dropByProduct.get(p.id) ?? null,
        };
      }),
    });
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : "Something went wrong" },
      { status: 500 },
    );
  }
}

interface VariantRow {
  id: string;
  retail_price_cents: number;
  is_enabled: boolean;
  catalog_variants:
    | { color: string; size: string; in_stock: boolean }
    | Array<{ color: string; size: string; in_stock: boolean }>
    | null;
}

function first<T>(rel: T | T[] | null | undefined): T | undefined {
  if (!rel) return undefined;
  return Array.isArray(rel) ? rel[0] : rel;
}
