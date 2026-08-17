import { UserError } from "@/lib/errors";
import { getProvider } from "@/lib/fulfillment";
import type { ShippingAddress } from "@/lib/fulfillment/types";
import {
  computeEconomics, PASS_CARD_FEES_TO_CUSTOMER, type Economics,
} from "@/lib/pricing";
import { stripe } from "@/lib/stripe/client";
import { serviceClient } from "@/lib/supabase/client";

/**
 * Checkout: cart → priced order → Stripe PaymentIntent.
 *
 * Two rules shape everything here.
 *
 * **Prices are never taken from the client.** The browser sends variant ids and
 * quantities; every figure is re-read from the database and re-quoted from the
 * vendor. A checkout that trusts a client-supplied total is a fraud vector, and
 * we are merchant of record so the chargeback lands on us.
 *
 * **Nothing is captured until the order can be fulfilled.** Reservations
 * authorise without capturing, so a drop that misses its threshold releases the
 * hold instead of refunding a charge.
 */

export interface CartLine {
  productVariantId: string;
  quantity: number;
}

export interface CheckoutQuote {
  orderId: string;
  clientSecret: string;
  economics: Economics;
  shippingCents: number;
  lines: Array<{
    productVariantId: string;
    name: string;
    color: string;
    size: string;
    quantity: number;
    unitRetailCents: number;
  }>;
}

const MAX_UNITS_PER_ORDER = 50;

export async function createCheckout(input: {
  storeId: string;
  lines: CartLine[];
  shipping: ShippingAddress;
  /** Reservation for a drop: authorise now, capture when the threshold is met. */
  dropId?: string;
}): Promise<CheckoutQuote> {
  const sb = serviceClient();

  if (!input.lines.length) throw new UserError("Cart is empty");

  const units = input.lines.reduce((n, l) => n + l.quantity, 0);
  if (units > MAX_UNITS_PER_ORDER) {
    // PROJECT.md's fraud section: card testing and laundering both like large
    // orders on brand-new stores.
    throw new UserError(`Orders are limited to ${MAX_UNITS_PER_ORDER} units`);
  }
  if (input.lines.some((l) => !Number.isInteger(l.quantity) || l.quantity < 1)) {
    throw new UserError("Quantities must be whole numbers of at least one");
  }

  // Authoritative prices. Note the store filter: a variant id from another
  // seller's store must not be purchasable through this storefront.
  const { data: variants, error } = await sb
    .from("product_variants")
    .select(
      `id, retail_price_cents, base_cost_cents, platform_fee_cents, is_enabled,
       products!inner ( id, name, status, store_id ),
       catalog_variants ( external_id, color, size, in_stock )`,
    )
    .in("id", input.lines.map((l) => l.productVariantId))
    .eq("products.store_id", input.storeId);

  if (error) throw error;

  const byId = new Map((variants ?? []).map((v) => [v.id, v]));

  for (const line of input.lines) {
    const v = byId.get(line.productVariantId);
    if (!v) throw new UserError("That item is not available from this store");

    const product = first(v.products);
    if (!v.is_enabled || product?.status !== "published") {
      throw new UserError("That item is no longer for sale");
    }
    if (!first(v.catalog_variants)?.in_stock) {
      throw new UserError(`${first(v.catalog_variants)?.color} ${first(v.catalog_variants)?.size} is out of stock`);
    }
  }

  const lines = input.lines.map((l) => {
    const v = byId.get(l.productVariantId)!;
    const cv = first(v.catalog_variants)!;
    return {
      productVariantId: v.id,
      externalVariantId: cv.external_id,
      name: first(v.products)!.name,
      color: cv.color,
      size: cv.size,
      quantity: l.quantity,
      unitRetailCents: v.retail_price_cents,
      unitBaseCostCents: v.base_cost_cents,
      unitPlatformFeeCents: v.platform_fee_cents,
    };
  });

  // Live shipping, not a guess. Quoted from the vendor for this exact basket and
  // destination, then passed through to the customer at cost.
  const provider = getProvider("printful");
  const quotes = await provider.quoteShipping({
    items: lines.map((l) => ({ externalVariantId: l.externalVariantId, quantity: l.quantity })),
    shipping: input.shipping,
  });

  const standard = quotes.find((q) => q.speed === "standard") ?? quotes[0];
  if (!standard) throw new UserError("We cannot ship to that address");

  const itemsRetailCents = lines.reduce((n, l) => n + l.unitRetailCents * l.quantity, 0);
  const platformFeeCents = lines.reduce((n, l) => n + l.unitPlatformFeeCents * l.quantity, 0);
  const sellerUnitCostCents = lines.reduce(
    (n, l) => n + (l.unitBaseCostCents + l.unitPlatformFeeCents) * l.quantity, 0,
  );
  const vendorItemsCents = lines.reduce((n, l) => n + l.unitBaseCostCents * l.quantity, 0);

  const economics = computeEconomics({
    itemsRetailCents,
    shippingChargedCents: standard.costCents,
    vendorItemsCents,
    vendorShippingCents: standard.costCents,
    // Vendor tax is only known once the vendor prices the order. Treated as zero
    // here and reconciled against the real invoice at submission — it comes out
    // of our margin, never out of the seller's or the customer's total.
    vendorTaxCents: 0,
    platformFeeCents,
    sellerUnitCostCents,
    passCardFeesToCustomer: PASS_CARD_FEES_TO_CUSTOMER,
  });

  const { data: order, error: orderErr } = await sb
    .from("orders")
    .insert({
      store_id: input.storeId,
      order_number: await nextOrderNumber(input.storeId),
      status: input.dropId ? "reserved" : "pending",
      payment_status: "requires_payment",
      customer_email: input.shipping.email ?? "",
      customer_name: input.shipping.name,
      ship_line1: input.shipping.line1,
      ship_line2: input.shipping.line2 ?? null,
      ship_city: input.shipping.city,
      ship_state: input.shipping.state,
      ship_postal_code: input.shipping.postalCode,
      ship_country: input.shipping.country,
      ship_phone: input.shipping.phone ?? null,
      shipping_speed: "standard",
      subtotal_cents: itemsRetailCents,
      shipping_cents: economics.customerPaysCents - itemsRetailCents,
      total_cents: economics.customerPaysCents,
      drop_id: input.dropId ?? null,
    })
    .select("id, idempotency_key")
    .single();

  if (orderErr) throw orderErr;

  const { error: itemsErr } = await sb.from("order_items").insert(
    lines.map((l) => ({
      order_id: order.id,
      product_variant_id: l.productVariantId,
      quantity: l.quantity,
      unit_retail_cents: l.unitRetailCents,
      unit_base_cost_cents: l.unitBaseCostCents,
      unit_platform_fee_cents: l.unitPlatformFeeCents,
    })),
  );
  if (itemsErr) throw itemsErr;

  const intent = await stripe().paymentIntents.create(
    {
      amount: economics.customerPaysCents,
      currency: "usd",
      // A reservation is authorised and held. Capture happens when the drop
      // threshold is met; if it is not, the hold is released and no money ever
      // moves — which is cleaner for the customer than a refund.
      capture_method: input.dropId ? "manual" : "automatic",
      // No transfer_data. Separate charges and transfers: the seller is paid by
      // a Transfer once delivery clears, not at the moment of purchase.
      metadata: {
        order_id: order.id,
        store_id: input.storeId,
        idempotency_key: order.idempotency_key,
        drop_id: input.dropId ?? "",
      },
      description: `Order ${order.id}`,
      receipt_email: input.shipping.email ?? undefined,
    },
    // Stripe's own idempotency, keyed on our order. A retried checkout returns
    // the same intent rather than charging twice.
    { idempotencyKey: `pi_${order.idempotency_key}` },
  );

  await sb.from("orders")
    .update({ stripe_payment_intent_id: intent.id })
    .eq("id", order.id);

  return {
    orderId: order.id,
    clientSecret: intent.client_secret!,
    economics,
    shippingCents: standard.costCents,
    lines: lines.map(({ productVariantId, name, color, size, quantity, unitRetailCents }) => ({
      productVariantId, name, color, size, quantity, unitRetailCents,
    })),
  };
}

/** Per-store, human-facing. Sequential enough to be quotable in support. */
async function nextOrderNumber(storeId: string): Promise<string> {
  const sb = serviceClient();
  const { count } = await sb
    .from("orders").select("id", { count: "exact", head: true }).eq("store_id", storeId);
  return String(1001 + (count ?? 0));
}

function first<T>(rel: T | T[] | null | undefined): T | undefined {
  if (!rel) return undefined;
  return Array.isArray(rel) ? rel[0] : rel;
}
