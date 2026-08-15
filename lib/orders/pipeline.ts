import { getProvider } from "@/lib/fulfillment";
import { FulfillmentError, type ProviderId, type SubmitOrderInput } from "@/lib/fulfillment/types";
import { computeEconomics, PASS_CARD_FEES_TO_CUSTOMER, type Economics } from "@/lib/pricing";
import { serviceClient } from "@/lib/supabase/client";

/**
 * Order → vendor submission.
 *
 * This is the path PROJECT.md calls the worst failure mode: money taken, nothing
 * manufactured. Everything here is shaped by that.
 *
 *   - Runs with the service role. There is no user behind it.
 *   - The vendor call is idempotent on orders.idempotency_key, which is sent as
 *     the vendor's external reference. Re-running is safe by design, because the
 *     alternative to re-running safely is not re-running at all.
 *   - A failure is recorded, classified, and scheduled — never swallowed. An
 *     order that cannot reach the vendor has to be visible.
 *
 * Seller margin is written on delivery, not on submission. We owe it only once
 * the garment actually arrives.
 */

const NET_DAYS = 14;

export interface SubmitResult {
  ok: boolean;
  dryRun: boolean;
  externalOrderId: string | null;
  status: string;
  /** What the vendor charges us. Integer cents. */
  vendorCostCents: number | null;
  /** What the customer paid. Integer cents. */
  customerPaidCents: number;
  /** What we owe the seller once delivered. Integer cents. */
  sellerMarginCents: number;
  /** Our take before Stripe fees. Integer cents. */
  platformFeeCents: number;
  /** Full breakdown, populated on a dry run where live vendor pricing is fetched. */
  economics?: Economics & { vendorShippingCents: number; vendorTaxCents: number };
  error?: { kind: string; message: string; retryable: boolean };
}

interface OrderRow {
  id: string;
  store_id: string;
  idempotency_key: string;
  status: string;
  payment_status: string;
  shipping_speed: "standard" | "expedited" | "rush";
  customer_email: string;
  customer_name: string | null;
  ship_line1: string; ship_line2: string | null;
  ship_city: string; ship_state: string | null;
  ship_postal_code: string; ship_country: string; ship_phone: string | null;
  subtotal_cents: number; shipping_cents: number; tax_cents: number; total_cents: number;
}

/**
 * Submits an order to its fulfillment vendor.
 *
 * `dryRun` prices the order against the vendor's real estimator without creating
 * anything. It is how you see the true economics of an order — including what the
 * vendor will actually charge, which is not the cached catalog price — before any
 * garment is committed to.
 */
export async function submitOrderToVendor(
  orderId: string,
  opts: { dryRun?: boolean; provider?: ProviderId } = {},
): Promise<SubmitResult> {
  const dryRun = opts.dryRun ?? false;
  const sb = serviceClient();

  const { data: order, error: orderErr } = await sb
    .from("orders")
    .select(
      `id, store_id, idempotency_key, status, payment_status, shipping_speed,
       customer_email, customer_name,
       ship_line1, ship_line2, ship_city, ship_state, ship_postal_code,
       ship_country, ship_phone,
       subtotal_cents, shipping_cents, tax_cents, total_cents`,
    )
    .eq("id", orderId)
    .single<OrderRow>();

  if (orderErr || !order) throw new Error(`Order ${orderId} not found`);

  // Nothing reaches a vendor before the money is captured. A dry run is exempt —
  // that is the whole point of it.
  if (!dryRun && order.payment_status !== "captured") {
    throw new Error(
      `Order ${orderId} has payment_status=${order.payment_status}; ` +
      `refusing to submit before capture`,
    );
  }

  const { data: items, error: itemsErr } = await sb
    .from("order_items")
    .select(
      `id, quantity, unit_retail_cents, unit_base_cost_cents, unit_platform_fee_cents,
       product_variants ( id, catalog_variants ( external_id ) )`,
    )
    .eq("order_id", orderId);

  if (itemsErr || !items?.length) throw new Error(`Order ${orderId} has no items`);

  // Which vendor variant each line maps to. Missing ids are fatal rather than
  // skippable — a partial order means a customer paid for something we never sent.
  const lines = items.map((it) => {
    const pv = first(it.product_variants);
    const cv = first(pv?.catalog_variants);
    if (!cv?.external_id) {
      throw new Error(`Order item ${it.id} has no vendor variant id; cannot submit`);
    }
    return {
      localOrderItemId: it.id,
      externalVariantId: cv.external_id,
      quantity: it.quantity,
      retailPriceCents: it.unit_retail_cents,
      baseCostCents: it.unit_base_cost_cents,
      feeCents: it.unit_platform_fee_cents,
    };
  });

  const sellerMarginCents = lines.reduce(
    (sum, l) => sum + (l.retailPriceCents - l.baseCostCents - l.feeCents) * l.quantity,
    0,
  );
  const platformFeeCents = lines.reduce((sum, l) => sum + l.feeCents * l.quantity, 0);

  const { data: store } = await sb
    .from("stores").select("vendor_store_id, vendor_provider").eq("id", order.store_id).single();

  const providerId: ProviderId = opts.provider ?? store?.vendor_provider ?? "printful";
  const provider = getProvider(providerId);

  const input: SubmitOrderInput = {
    // The idempotency key, not the order id. Re-submitting the same key must
    // never produce a second garment.
    localOrderId: order.idempotency_key,
    storeId: store?.vendor_store_id ?? process.env.PRINTFUL_CATALOG_STORE_ID ?? "",
    items: lines.map((l) => ({
      localOrderItemId: l.localOrderItemId,
      externalVariantId: l.externalVariantId,
      quantity: l.quantity,
      retailPriceCents: l.retailPriceCents,
    })),
    shipping: {
      name: order.customer_name ?? order.customer_email,
      line1: order.ship_line1,
      line2: order.ship_line2,
      city: order.ship_city,
      state: order.ship_state,
      postalCode: order.ship_postal_code,
      country: order.ship_country,
      phone: order.ship_phone,
      email: order.customer_email,
    },
    shippingSpeed: order.shipping_speed,
  };

  const base: SubmitResult = {
    ok: false, dryRun,
    externalOrderId: null, status: "pending",
    vendorCostCents: null,
    customerPaidCents: order.total_cents,
    sellerMarginCents, platformFeeCents,
  };

  try {
    if (dryRun) {
      // Real vendor pricing, nothing created. Shipping is passed straight
      // through to the customer, so what the vendor quotes is what we charge.
      const estimate = await provider.estimateCost(input);
      const itemsRetailCents = lines.reduce(
        (sum, l) => sum + l.retailPriceCents * l.quantity, 0,
      );

      const economics = computeEconomics({
        itemsRetailCents,
        shippingChargedCents: estimate.shippingCostCents,
        vendorItemsCents: estimate.itemsCostCents,
        vendorShippingCents: estimate.shippingCostCents,
        vendorTaxCents: estimate.taxCents,
        platformFeeCents,
        passCardFeesToCustomer: PASS_CARD_FEES_TO_CUSTOMER,
      });

      return {
        ...base,
        ok: true,
        status: "estimated",
        vendorCostCents: estimate.totalCents,
        customerPaidCents: economics.customerPaysCents,
        sellerMarginCents: economics.sellerMarginCents,
        economics: {
          ...economics,
          vendorShippingCents: estimate.shippingCostCents,
          vendorTaxCents: estimate.taxCents,
        },
      };
    }

    const vendorOrder = await provider.submitOrder(input);

    await recordFulfillment(orderId, providerId, {
      external_order_id: vendorOrder.externalOrderId,
      status: vendorOrder.status,
      raw_status: vendorOrder.rawStatus,
      vendor_cost_cents: vendorOrder.vendorCostCents,
      shipping_cost_cents: vendorOrder.shippingCostCents,
      tax_cents: vendorOrder.taxCents,
      submitted_at: new Date().toISOString(),
      last_error: null,
      next_retry_at: null,
    });

    await sb.from("orders")
      .update({ status: "in_fulfillment", vendor_cost_cents: vendorOrder.vendorCostCents })
      .eq("id", orderId);

    return {
      ...base, ok: true,
      externalOrderId: vendorOrder.externalOrderId,
      status: vendorOrder.status,
      vendorCostCents: vendorOrder.vendorCostCents,
    };
  } catch (e) {
    const err = e instanceof FulfillmentError
      ? e
      : new FulfillmentError("unknown", String(e), providerId);

    if (!dryRun) {
      // Recorded even on the paths we will retry, so an order stuck in limbo is
      // visible in the database rather than only in a log line.
      await recordFulfillment(orderId, providerId, {
        status: "failed",
        last_error: { kind: err.kind, message: err.message, context: err.context ?? null },
        next_retry_at: err.retryable ? nextRetryAt() : null,
      });
    }

    return {
      ...base,
      status: "failed",
      error: { kind: err.kind, message: err.message, retryable: err.retryable },
    };
  }
}

/**
 * Credits the seller their margin, payable net 14 after delivery.
 *
 * Idempotent on (order, kind) — running twice must not pay twice. Writes nothing
 * until the order is actually delivered, because that is when we owe it.
 */
export async function recordSellerMargin(orderId: string): Promise<number | null> {
  const sb = serviceClient();

  const { data: order } = await sb
    .from("orders").select("id, store_id, status, delivered_at").eq("id", orderId).single();

  if (!order || order.status !== "delivered" || !order.delivered_at) return null;

  const { data: existing } = await sb
    .from("ledger_entries")
    .select("id").eq("order_id", orderId).eq("kind", "seller_margin").maybeSingle();

  if (existing) return null;

  const { data: items } = await sb
    .from("order_items")
    .select("quantity, unit_retail_cents, unit_base_cost_cents, unit_platform_fee_cents")
    .eq("order_id", orderId);

  const amount = (items ?? []).reduce(
    (sum, i) =>
      sum + (i.unit_retail_cents - i.unit_base_cost_cents - i.unit_platform_fee_cents) * i.quantity,
    0,
  );

  const availableAt = new Date(order.delivered_at);
  availableAt.setUTCDate(availableAt.getUTCDate() + NET_DAYS);

  await sb.from("ledger_entries").insert({
    store_id: order.store_id,
    order_id: orderId,
    kind: "seller_margin",
    amount_cents: amount,
    available_at: availableAt.toISOString(),
    description: `Margin on order ${orderId}`,
  });

  return amount;
}

/* ------------------------------------------------------------------ */

async function recordFulfillment(
  orderId: string,
  provider: ProviderId,
  patch: Record<string, unknown>,
) {
  const sb = serviceClient();

  const { data: existing } = await sb
    .from("fulfillments").select("id, attempt_count")
    .eq("order_id", orderId).eq("provider", provider).maybeSingle();

  const row = {
    order_id: orderId,
    provider,
    attempt_count: (existing?.attempt_count ?? 0) + 1,
    last_attempt_at: new Date().toISOString(),
    ...patch,
  };

  if (existing) {
    await sb.from("fulfillments").update(row).eq("id", existing.id);
  } else {
    await sb.from("fulfillments").insert(row);
  }
}

/** Ten minutes out. The retry worker decides the real cadence; this is a floor. */
function nextRetryAt(): string {
  return new Date(Date.now() + 10 * 60_000).toISOString();
}

function first<T>(rel: T | T[] | null | undefined): T | undefined {
  if (!rel) return undefined;
  return Array.isArray(rel) ? rel[0] : rel;
}
