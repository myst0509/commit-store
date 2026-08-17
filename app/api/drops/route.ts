import { errorResponse, requireSeller } from "@/lib/auth/session";
import { serviceClient } from "@/lib/supabase/client";

/**
 * Drops, for the seller running them.
 *
 * GET  — every drop with live reservation counts.
 * POST — schedules one.
 *
 * Reserved units are counted from live orders rather than stored on the drop.
 * A denormalised counter would drift the first time a reservation was cancelled
 * out of band, and this number decides whether people get charged.
 */

export const dynamic = "force-dynamic";

const DEFAULT_THRESHOLD = 25;

async function reservedUnits(dropIds: string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (!dropIds.length) return counts;

  const sb = serviceClient();
  const { data } = await sb
    .from("orders")
    .select("drop_id, order_items(quantity)")
    .in("drop_id", dropIds)
    .not("status", "in", "(cancelled,refunded)");

  for (const order of data ?? []) {
    if (!order.drop_id) continue;
    const units = (order.order_items ?? [])
      .reduce((n: number, i: { quantity: number }) => n + i.quantity, 0);
    counts.set(order.drop_id, (counts.get(order.drop_id) ?? 0) + units);
  }

  return counts;
}

export async function GET(req: Request): Promise<Response> {
  try {
    const session = await requireSeller(req);
    const sb = serviceClient();

    const { data: drops } = await sb
      .from("drops")
      .select("id, product_id, threshold_units, status, opens_at, closes_at, resolved_at, products(name, slug)")
      .eq("store_id", session.storeId)
      .order("created_at", { ascending: false });

    const counts = await reservedUnits((drops ?? []).map((d) => d.id));

    return Response.json({
      drops: (drops ?? []).map((d) => {
        const product = Array.isArray(d.products) ? d.products[0] : d.products;
        const reserved = counts.get(d.id) ?? 0;
        return {
          id: d.id,
          product: { id: d.product_id, name: product?.name, slug: product?.slug },
          status: d.status,
          thresholdUnits: d.threshold_units,
          reservedUnits: reserved,
          // What a seller actually watches.
          unitsRemaining: Math.max(0, d.threshold_units - reserved),
          percentToThreshold: Math.min(100, Math.round((reserved / d.threshold_units) * 100)),
          opensAt: d.opens_at,
          closesAt: d.closes_at,
          resolvedAt: d.resolved_at,
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
      productId?: string; closesAt?: string; thresholdUnits?: number;
    };

    if (!body.productId) {
      return Response.json({ error: "Choose which product is dropping" }, { status: 400 });
    }
    if (!body.closesAt || Number.isNaN(Date.parse(body.closesAt))) {
      return Response.json({ error: "Pick a closing date" }, { status: 400 });
    }
    if (Date.parse(body.closesAt) <= Date.now()) {
      return Response.json({ error: "The closing date must be in the future" }, { status: 400 });
    }

    const threshold = body.thresholdUnits ? Number(body.thresholdUnits) : DEFAULT_THRESHOLD;
    if (!Number.isInteger(threshold) || threshold < 1) {
      return Response.json({ error: "Threshold must be at least one unit" }, { status: 400 });
    }

    const sb = serviceClient();

    const { data: product } = await sb
      .from("products").select("id").eq("id", body.productId).eq("store_id", session.storeId).maybeSingle();

    if (!product) return Response.json({ error: "Product not found" }, { status: 404 });

    // One open drop per product. Two would split reservations between them and
    // neither would reach its threshold.
    const { data: existing } = await sb
      .from("drops").select("id").eq("product_id", product.id).eq("status", "open").maybeSingle();

    if (existing) {
      const { error } = await sb.from("drops")
        .update({ closes_at: body.closesAt, threshold_units: threshold }).eq("id", existing.id);
      if (error) throw error;
      return Response.json({ id: existing.id, updated: true, thresholdUnits: threshold });
    }

    const { data, error } = await sb.from("drops").insert({
      store_id: session.storeId,
      product_id: product.id,
      threshold_units: threshold,
      closes_at: body.closesAt,
      status: "open",
    }).select("id").single();

    if (error) throw error;

    return Response.json({ id: data.id, created: true, thresholdUnits: threshold }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
