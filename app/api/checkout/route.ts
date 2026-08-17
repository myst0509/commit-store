import { errorResponse } from "@/lib/auth/session";
import { createCheckout } from "@/lib/orders/checkout";
import type { ShippingAddress } from "@/lib/fulfillment/types";
import { resolveStore } from "@/lib/store/resolve";

/**
 * Public checkout. Called by a shopper on a storefront, so no authentication —
 * but the store is resolved from the Host header rather than taken from the
 * body, so a request cannot buy from a store it is not visiting.
 *
 * The body carries variant ids, quantities and an address. It carries no money.
 * Every price is re-read from the database and shipping is re-quoted live from
 * the vendor, because we are merchant of record and a client-supplied total is
 * a fraud vector.
 */

export const dynamic = "force-dynamic";

interface CheckoutBody {
  lines?: Array<{ productVariantId?: string; quantity?: number }>;
  shipping?: Partial<ShippingAddress>;
  dropId?: string;
}

export async function POST(req: Request): Promise<Response> {
  try {
    const host = req.headers.get("host") ?? "";
    const store = await resolveStore(host);
    if (!store) {
      return Response.json({ error: "Storefront not found" }, { status: 404 });
    }

    const body = (await req.json().catch(() => ({}))) as CheckoutBody;

    const lines = (body.lines ?? [])
      .filter((l) => typeof l.productVariantId === "string" && Number.isInteger(l.quantity))
      .map((l) => ({ productVariantId: l.productVariantId!, quantity: l.quantity! }));

    if (!lines.length) {
      return Response.json({ error: "Your cart is empty" }, { status: 400 });
    }

    const shipping = body.shipping ?? {};
    const missing = (["name", "line1", "city", "postalCode", "country"] as const)
      .filter((field) => !shipping[field]);

    if (missing.length) {
      return Response.json(
        { error: `Delivery address is missing: ${missing.join(", ")}` },
        { status: 400 },
      );
    }

    const quote = await createCheckout({
      storeId: store.id,
      lines,
      dropId: body.dropId,
      shipping: {
        name: shipping.name!,
        line1: shipping.line1!,
        line2: shipping.line2 ?? null,
        city: shipping.city!,
        state: shipping.state ?? null,
        postalCode: shipping.postalCode!,
        country: shipping.country!.toUpperCase(),
        phone: shipping.phone ?? null,
        email: shipping.email ?? null,
      },
    });

    // Deliberately narrow. The client needs enough to render a summary and
    // confirm the payment — it does not need our cost basis, the seller's
    // margin, or what we keep.
    return Response.json({
      orderId: quote.orderId,
      clientSecret: quote.clientSecret,
      lines: quote.lines,
      totals: {
        goodsCents: quote.economics.subtotalCents - quote.shippingCents,
        shippingCents: quote.shippingCents,
        serviceFeeCents: quote.economics.serviceFeeCents,
        totalCents: quote.economics.customerPaysCents,
      },
    }, { status: 200 });
  } catch (e) {
    return errorResponse(e);
  }
}
