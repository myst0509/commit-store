import { errorResponse, requireSeller } from "@/lib/auth/session";
import { serviceClient } from "@/lib/supabase/client";

/**
 * Everything a seller's dashboard needs, in one call.
 *
 * One request rather than six, because a dashboard that fires a request per
 * card renders in pieces and looks broken on a slow connection.
 *
 * What is deliberately absent: vendor cost and the base/fee split. Migration
 * 0002 revoked those columns from sellers, and this route reads with the
 * service role — which bypasses that. So the omission has to be enforced here,
 * by naming columns rather than selecting everything.
 */

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  try {
    const session = await requireSeller(req);
    const sb = serviceClient();

    const [store, orders, ledger, payouts, products] = await Promise.all([
      sb.from("stores")
        .select("status, payouts_held, stripe_account_id, stripe_payouts_enabled, first_sale_at")
        .eq("id", session.storeId).single(),

      sb.from("orders")
        .select("id, order_number, status, payment_status, total_cents, placed_at, delivered_at")
        .eq("store_id", session.storeId)
        .order("placed_at", { ascending: false })
        .limit(25),

      sb.from("ledger_entries")
        .select("kind, amount_cents, available_at, payout_id, created_at")
        .eq("store_id", session.storeId),

      sb.from("payouts")
        .select("id, amount_cents, status, scheduled_for, paid_at")
        .eq("store_id", session.storeId)
        .order("created_at", { ascending: false })
        .limit(10),

      // seller_cost_cents, never base_cost_cents + platform_fee_cents.
      sb.from("products")
        .select("id, name, slug, status, product_variants(retail_price_cents, seller_cost_cents, is_enabled)")
        .eq("store_id", session.storeId),
    ]);

    const now = Date.now();
    const entries = ledger.data ?? [];

    const payable = entries
      .filter((e) => !e.payout_id && e.available_at && Date.parse(e.available_at) <= now)
      .reduce((n, e) => n + e.amount_cents, 0);

    const pending = entries
      .filter((e) => !e.payout_id && (!e.available_at || Date.parse(e.available_at) > now))
      .reduce((n, e) => n + e.amount_cents, 0);

    const lifetime = entries
      .filter((e) => e.kind === "seller_margin")
      .reduce((n, e) => n + e.amount_cents, 0);

    const orderRows = orders.data ?? [];

    return Response.json({
      // Null unless an OAuth provider gave us a real name. The UI greets by
      // name only when this is present, and never invents one.
      seller: { name: session.name, email: session.email },
      store: {
        name: session.storeName,
        subdomain: session.subdomain,
        status: store.data?.status,
        url: `https://${session.subdomain}.ourdomain.com`,
        // Viewable today, without a domain. See /api/store.
        previewUrl: `${new URL(req.url).origin}/s/${session.subdomain}`,
        firstSaleAt: store.data?.first_sale_at ?? null,
      },
      earnings: {
        // Payable now, versus still inside the net-14 window. Sellers ask why
        // a sale has not paid out; showing both answers it before they ask.
        payableCents: Math.max(payable, 0),
        pendingCents: Math.max(pending, 0),
        lifetimeCents: lifetime,
        // Surfaced honestly rather than hidden — a seller wondering why nothing
        // arrived deserves to know it is held, not lost.
        payoutsHeld: store.data?.payouts_held ?? true,
      },
      bank: {
        connected: Boolean(store.data?.stripe_account_id),
        ready: Boolean(store.data?.stripe_payouts_enabled),
      },
      sales: {
        orderCount: orderRows.length,
        grossCents: orderRows
          .filter((o) => o.payment_status === "captured")
          .reduce((n, o) => n + o.total_cents, 0),
        recent: orderRows.map((o) => ({
          id: o.id,
          number: o.order_number,
          status: o.status,
          totalCents: o.total_cents,
          placedAt: o.placed_at,
          deliveredAt: o.delivered_at,
        })),
      },
      payouts: (payouts.data ?? []).map((p) => ({
        id: p.id,
        amountCents: p.amount_cents,
        status: p.status,
        scheduledFor: p.scheduled_for,
        paidAt: p.paid_at,
      })),
      products: (products.data ?? []).map((p) => {
        const variants = (p.product_variants ?? []) as Array<{
          retail_price_cents: number; seller_cost_cents: number; is_enabled: boolean;
        }>;
        const live = variants.filter((v) => v.is_enabled);
        return {
          id: p.id,
          name: p.name,
          slug: p.slug,
          status: p.status,
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
