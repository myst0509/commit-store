import { errorResponse, requireSeller } from "@/lib/auth/session";
import { serviceClient } from "@/lib/supabase/client";

/**
 * One product, for the seller who owns it.
 *
 * GET   — detail, including variants at seller cost (never the split).
 * PATCH — rename, reprice, publish or unpublish.
 *
 * Ownership is re-checked on every call against the session's store, not taken
 * from the URL. A product id is guessable; a session is not.
 */

export const dynamic = "force-dynamic";

async function ownedProduct(storeId: string, productId: string) {
  const sb = serviceClient();
  const { data } = await sb
    .from("products")
    .select("id, name, slug, description, status, decoration, blank_id, created_at")
    .eq("id", productId)
    .eq("store_id", storeId)
    .maybeSingle();
  return data;
}

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const session = await requireSeller(req);
    const { id } = await ctx.params;

    const product = await ownedProduct(session.storeId, id);
    // 404 rather than 403: confirming a product exists but belongs to someone
    // else is itself a small leak.
    if (!product) return Response.json({ error: "Product not found" }, { status: 404 });

    const sb = serviceClient();
    const [variants, blank, artwork] = await Promise.all([
      sb.from("product_variants")
        .select("id, retail_price_cents, seller_cost_cents, is_enabled, catalog_variants(color, size, in_stock)")
        .eq("product_id", id),
      sb.from("catalog_blanks").select("brand, model, image_url").eq("id", product.blank_id).single(),
      sb.from("product_artwork")
        .select("placement, decoration, designs(id, public_url)").eq("product_id", id),
    ]);

    const rows = variants.data ?? [];

    return Response.json({
      id: product.id,
      name: product.name,
      slug: product.slug,
      description: product.description,
      status: product.status,
      decoration: product.decoration,
      blank: blank.data ? `${blank.data.brand} ${blank.data.model}`.trim() : null,
      imageUrl: blank.data?.image_url ?? null,
      variants: rows.map((v) => {
        const cv = Array.isArray(v.catalog_variants) ? v.catalog_variants[0] : v.catalog_variants;
        return {
          id: v.id,
          color: cv?.color, size: cv?.size, inStock: cv?.in_stock,
          priceCents: v.retail_price_cents,
          // One number. The base/fee split is not the seller's to see.
          unitCostCents: v.seller_cost_cents,
          marginCents: v.retail_price_cents - v.seller_cost_cents,
          enabled: v.is_enabled,
        };
      }),
      artwork: (artwork.data ?? []).map((a) => {
        const design = Array.isArray(a.designs) ? a.designs[0] : a.designs;
        return { placement: a.placement, decoration: a.decoration, url: design?.public_url ?? null };
      }),
    });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const session = await requireSeller(req);
    const { id } = await ctx.params;

    const product = await ownedProduct(session.storeId, id);
    if (!product) return Response.json({ error: "Product not found" }, { status: 404 });

    const body = (await req.json().catch(() => ({}))) as {
      name?: string; description?: string;
      status?: "draft" | "published" | "archived";
      retailPriceCents?: number;
    };

    const sb = serviceClient();
    const patch: Record<string, unknown> = {};
    if (typeof body.name === "string" && body.name.trim()) patch.name = body.name.trim();
    if (typeof body.description === "string") patch.description = body.description;
    if (body.status && ["draft", "published", "archived"].includes(body.status)) {
      patch.status = body.status;
    }

    if (Object.keys(patch).length) {
      const { error } = await sb.from("products").update(patch).eq("id", id);
      if (error) throw error;
    }

    // Repricing applies to every variant. Refused below cost, with the real
    // number named — a seller should never be able to price into a loss by
    // accident, and "invalid price" would not tell them why.
    if (body.retailPriceCents !== undefined) {
      const price = Number(body.retailPriceCents);
      if (!Number.isInteger(price) || price <= 0) {
        return Response.json({ error: "Price must be a whole number of cents" }, { status: 400 });
      }

      const { data: costs } = await sb
        .from("product_variants").select("seller_cost_cents").eq("product_id", id);

      const highest = Math.max(0, ...(costs ?? []).map((c) => c.seller_cost_cents));
      if (price < highest) {
        return Response.json({
          error: `At $${(price / 100).toFixed(2)} you would lose money — ` +
            `this garment costs you $${(highest / 100).toFixed(2)}`,
        }, { status: 400 });
      }

      const { error } = await sb
        .from("product_variants").update({ retail_price_cents: price }).eq("product_id", id);
      if (error) throw error;
    }

    return GET(req, ctx);
  } catch (e) {
    return errorResponse(e);
  }
}
