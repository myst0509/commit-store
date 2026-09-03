import { errorResponse, requireSeller } from "@/lib/auth/session";
import { UserError } from "@/lib/errors";
import { createProductFromBlank, slugTaken } from "@/lib/products/create";
import { serviceClient } from "@/lib/supabase/client";

/**
 * The seller's products.
 *
 * GET  — the list. Previously only available bundled inside /api/dashboard.
 * POST — create one from a catalog blank.
 *
 * Before this, the launch path's price step was the only thing that could make
 * a product, and it presents as a one-time rung of a sequence. A seller could
 * build exactly one product and had no route to a second.
 */

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  try {
    const session = await requireSeller(req);
    const sb = serviceClient();

    const { data } = await sb
      .from("products")
      // seller_cost_cents, never the base/fee split. Migration 0002 revokes
      // those columns from sellers and the service role bypasses that, so the
      // omission has to be enforced by naming columns here.
      .select("id, name, slug, status, created_at, product_variants(retail_price_cents, seller_cost_cents, is_enabled)")
      .eq("store_id", session.storeId)
      .order("created_at", { ascending: false });

    return Response.json({
      products: (data ?? []).map((p) => {
        const variants = (p.product_variants ?? []) as Array<{
          retail_price_cents: number; seller_cost_cents: number; is_enabled: boolean;
        }>;
        const live = variants.filter((v) => v.is_enabled);
        return {
          id: p.id,
          name: p.name,
          slug: p.slug,
          status: p.status,
          createdAt: p.created_at,
          variantCount: live.length,
          priceCents: live.length ? Math.min(...live.map((v) => v.retail_price_cents)) : null,
          unitCostCents: live.length ? Math.min(...live.map((v) => v.seller_cost_cents)) : null,
        };
      }),
    });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: Request): Promise<Response> {
  try {
    const session = await requireSeller(req);
    const body = (await req.json().catch(() => ({}))) as {
      blankId?: string;
      name?: string;
      retailPriceCents?: number;
      designId?: string | null;
    };

    const name = String(body.name ?? "").trim();
    if (!name) throw new UserError("Give the product a name");

    // The underlying upsert keys on (store_id, slug), so a repeated name would
    // quietly edit the existing product instead of creating a new one. Said
    // plainly here rather than letting a seller wonder where their product went.
    if (await slugTaken(session.storeId, name)) {
      throw new UserError(`You already have a product called "${name}". Pick another name`);
    }

    const created = await createProductFromBlank({
      storeId: session.storeId,
      blankId: String(body.blankId ?? ""),
      name,
      retailPriceCents: Number(body.retailPriceCents),
      designId: body.designId ?? null,
    });

    return Response.json(created, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
