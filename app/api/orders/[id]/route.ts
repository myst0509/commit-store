import { errorResponse, requireSeller } from "@/lib/auth/session";
import { serviceClient } from "@/lib/supabase/client";

/**
 * One order, for the seller whose store it belongs to.
 *
 * Shows what the seller legitimately needs — what sold, what they earn, where
 * the parcel is — and deliberately not what we paid the vendor. The customer's
 * address is included because a seller fields "where is my order" questions and
 * cannot answer without it.
 */

export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const session = await requireSeller(req);
    const { id } = await ctx.params;
    const sb = serviceClient();

    const { data: order } = await sb
      .from("orders")
      .select(
        `id, order_number, status, payment_status, shipping_speed,
         customer_email, customer_name,
         ship_line1, ship_line2, ship_city, ship_state, ship_postal_code, ship_country,
         subtotal_cents, shipping_cents, total_cents,
         placed_at, paid_at, delivered_at, cancelled_at, drop_id`,
      )
      .eq("id", id)
      .eq("store_id", session.storeId)
      .maybeSingle();

    if (!order) return Response.json({ error: "Order not found" }, { status: 404 });

    const [items, fulfilment, ledger] = await Promise.all([
      sb.from("order_items")
        .select(`quantity, unit_retail_cents, unit_base_cost_cents, unit_platform_fee_cents,
                 product_variants(catalog_variants(color, size), products(name))`)
        .eq("order_id", id),
      sb.from("fulfillments")
        .select("status, raw_status, tracking_number, tracking_url, carrier, estimated_delivery, submitted_at")
        .eq("order_id", id).maybeSingle(),
      sb.from("ledger_entries")
        .select("kind, amount_cents, available_at").eq("order_id", id),
    ]);

    const lines = items.data ?? [];

    // Computed here rather than selected, so the components never leave.
    const earningsCents = lines.reduce(
      (n, i) => n + (i.unit_retail_cents - i.unit_base_cost_cents - i.unit_platform_fee_cents) * i.quantity,
      0,
    );

    const margin = (ledger.data ?? []).find((e) => e.kind === "seller_margin");

    return Response.json({
      id: order.id,
      number: order.order_number,
      status: order.status,
      paymentStatus: order.payment_status,
      isReservation: Boolean(order.drop_id),
      customer: {
        name: order.customer_name,
        email: order.customer_email,
        address: [
          order.ship_line1, order.ship_line2, order.ship_city,
          order.ship_state, order.ship_postal_code, order.ship_country,
        ].filter(Boolean).join(", "),
      },
      items: lines.map((i) => {
        const pv = Array.isArray(i.product_variants) ? i.product_variants[0] : i.product_variants;
        const cv = pv && (Array.isArray(pv.catalog_variants) ? pv.catalog_variants[0] : pv.catalog_variants);
        const product = pv && (Array.isArray(pv.products) ? pv.products[0] : pv.products);
        return {
          name: product?.name ?? "(deleted product)",
          color: cv?.color, size: cv?.size,
          quantity: i.quantity,
          unitPriceCents: i.unit_retail_cents,
        };
      }),
      totals: {
        goodsCents: order.subtotal_cents,
        shippingCents: order.shipping_cents,
        customerPaidCents: order.total_cents,
        yourEarningsCents: earningsCents,
      },
      earnings: {
        credited: Boolean(margin),
        // Net 14 after delivery. Sellers ask why a sale has not paid out; this
        // is the answer.
        availableAt: margin?.available_at ?? null,
      },
      shipment: fulfilment.data ? {
        status: fulfilment.data.status,
        carrier: fulfilment.data.carrier,
        trackingNumber: fulfilment.data.tracking_number,
        trackingUrl: fulfilment.data.tracking_url,
        estimatedDelivery: fulfilment.data.estimated_delivery,
        submittedAt: fulfilment.data.submitted_at,
      } : null,
      timeline: {
        placedAt: order.placed_at,
        paidAt: order.paid_at,
        deliveredAt: order.delivered_at,
        cancelledAt: order.cancelled_at,
      },
    });
  } catch (e) {
    return errorResponse(e);
  }
}
