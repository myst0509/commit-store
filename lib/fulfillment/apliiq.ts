import {
  APLIIQ_BASE_URL,
  signApliiqRequest,
  type ApliiqCredentials,
} from "./apliiq-auth";
import {
  FulfillmentError,
  type ArtworkUpload,
  type CatalogBlank,
  type CatalogColor,
  type CatalogVariant,
  type CostEstimate,
  type CreateVendorProductInput,
  type DecorationMethod,
  type FulfillmentProvider,
  type FulfillmentStatus,
  type NormalizedWebhookEvent,
  type PlacementCode,
  type PlacementSpec,
  type ProviderCapabilities,
  type ShippingAddress,
  type ShippingQuote,
  type SubmitOrderInput,
  type VendorArtwork,
  type VendorOrder,
  type VendorProduct,
} from "./types";

/**
 * Apliiq adapter.
 *
 * Auth is an HMAC signature — see ./apliiq-auth. Their API answers an unsigned
 * request with a 500 rather than a 401, which is how this vendor spent months
 * recorded as "down" when nothing was wrong. Do not re-derive that conclusion
 * from a 500 alone.
 *
 * VERIFIED against the live API 2026-08-19:
 *   GET /v1/Product  -> 200, 1,520 products
 *   GET /v1/Order    -> 200, [] (no orders on the account yet)
 * Paths are PascalCase and singular. /orders 404s.
 *
 * NOT verified: no order has ever been placed, and the endpoints for artwork,
 * products, shipping quotes and cancellation are not in their public docs.
 * Those methods throw rather than guess — see UNDISCOVERED below.
 *
 * Two things their catalog does NOT provide, which Printful does:
 *   - print area dimensions (Locations[].DesignBox is empty catalog-wide)
 *   - colour hex codes on garment colours
 * Both matter: the first is what design/validate.ts measures artwork against,
 * the second is what decides DTG-on-darks. Handled explicitly below rather than
 * papered over with invented numbers.
 */

/* ------------------------------------------------------------------ */
/* Mapping                                                             */
/* ------------------------------------------------------------------ */

/**
 * Their "Services" mix decoration methods and private-label finishing. Only the
 * decoration ones map onto DecorationMethod; the rest are what makes this
 * vendor worth having and are reported through capabilities().
 */
const SERVICE_TO_DECORATION: Record<string, DecorationMethod> = {
  dtgprint: "dtg",
  transfer_print: "dtf",
  print: "screen_print",
  embroidery: "embroidery",
  applique: "applique",
  sublimation: "sublimation",
};

/**
 * Their location names, lowercased. Anything absent is deliberately dropped
 * rather than guessed: "Top", "Hood Detail" and "Front Detail" have no
 * PlacementCode, and inventing one would put a print somewhere the seller never
 * chose.
 */
const LOCATION_TO_PLACEMENT: Record<string, PlacementCode> = {
  front: "front",
  back: "back",
  "left sleeve": "sleeve_left",
  "right sleeve": "sleeve_right",
  "inside detail": "neck_inner",
};

/** Colour names that mean a dark garment, since no hex is supplied. */
const DARK_WORDS = [
  "black", "navy", "charcoal", "forest", "maroon", "burgundy", "brown",
  "olive", "dark", "midnight", "espresso", "indigo", "graphite", "onyx",
];

export function isDarkColorName(name: string): boolean {
  const n = name.toLowerCase();
  return DARK_WORDS.some((w) => n.includes(w));
}

/** Dollars as a JSON number to integer cents. No float arithmetic downstream. */
export function dollarsToCents(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

/**
 * Their line item sku format is APQ-########S#A# — product, size, colour. We
 * mint the same shape as our externalVariantId so an order line can be built
 * without a second catalog round trip.
 */
export function variantSku(productId: number, sizeId: number, colorId: number): string {
  return `APQ-${String(productId).padStart(8, "0")}S${sizeId}A${colorId}`;
}

export function parseVariantSku(
  sku: string,
): { productId: number; sizeId: number; colorId: number } | null {
  const m = /^APQ-(\d{8})S(\d+)A(\d+)$/.exec(sku);
  if (!m) return null;
  return { productId: Number(m[1]), sizeId: Number(m[2]), colorId: Number(m[3]) };
}

/**
 * Their order id is an integer; ours is a uuid. The mapping has to be
 * deterministic, or a retry of the same order looks like a new one — and
 * idempotency on localOrderId is the one guarantee PROJECT.md requires of every
 * adapter. FNV-1a, clamped to a positive int32.
 *
 * CONFIRMED by Apliiq support 2026-08-19: "If the id + order_number is the
 * same, no new order is submit to the system." So a retry is genuinely safe,
 * provided id and order_number both carry this value. buildOrderPayload sets
 * id, number and order_number to the same integer for exactly that reason, and
 * a test pins it. Change one without the others and idempotency silently dies.
 *
 * They also asked for a minimum 3-5 second gap between retries. Our backoff
 * starts at 10 minutes, so that is satisfied with room to spare.
 */
export function orderIdToInt(localOrderId: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < localOrderId.length; i++) {
    h ^= localOrderId.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % 0x7fffffff;
}

/** Theirs is "upgraded" where ours is "expedited". */
const SHIPPING_CODE: Record<string, string> = {
  standard: "standard",
  expedited: "upgraded",
  rush: "rush",
};

/* ------------------------------------------------------------------ */
/* Vendor payload shapes — confined to this file, per PROJECT.md       */
/* ------------------------------------------------------------------ */

interface ApliiqSize { Id: number; Name: string; Weight?: string; PlusSize_Fee?: number }
interface ApliiqColor { Id: number; Name: string }
interface ApliiqService { Id: number; Name: string; Alt_Name: string }
interface ApliiqLocation { Id: number; Name: string; ImagePath?: string; DesignBox?: unknown[] }

interface ApliiqProduct {
  Id: number;
  Code: string;
  SKU: string;
  Name: string;
  Description: string;
  Price: number;
  Sizes: ApliiqSize[];
  Colors: ApliiqColor[];
  Services: ApliiqService[];
  Locations: ApliiqLocation[];
}

/**
 * Endpoints Apliiq does not publish, and which therefore cannot be written
 * honestly. Each throws with what would have to be discovered first. Guessing a
 * path here buys a silent 404 at the moment an order needs making.
 */
const UNDISCOVERED =
  "Apliiq does not publish this endpoint. Ask developer@apliiq.com for the path " +
  "and payload, then implement it here — do not guess.";

/* ------------------------------------------------------------------ */

export class ApliiqProvider implements FulfillmentProvider {
  readonly id = "apliiq" as const;

  private catalogCache: ApliiqProduct[] | null = null;

  constructor(private creds?: ApliiqCredentials) {}

  private credentials(): ApliiqCredentials {
    const appId = this.creds?.appId ?? process.env.APLIIQ_APP_ID;
    const sharedSecret = this.creds?.sharedSecret ?? process.env.APLIIQ_SHARED_SECRET;
    if (!appId || !sharedSecret) {
      throw new FulfillmentError(
        "auth",
        "APLIIQ_APP_ID and APLIIQ_SHARED_SECRET are not set",
        "apliiq",
      );
    }
    return { appId, sharedSecret };
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const raw = body === undefined ? "" : JSON.stringify(body);
    const signed = signApliiqRequest(this.credentials(), raw);

    let res: Response;
    try {
      res = await fetch(`${APLIIQ_BASE_URL}${path}`, {
        method,
        headers: {
          Authorization: signed.authorization,
          Accept: "application/json",
          ...(raw ? { "Content-Type": "application/json" } : {}),
        },
        ...(raw ? { body: raw } : {}),
      });
    } catch (e) {
      throw new FulfillmentError("vendor_down", `Apliiq unreachable: ${String(e)}`, "apliiq", {
        endpoint: path,
      });
    }

    const text = await res.text();

    if (!res.ok) {
      const kind =
        res.status === 401 || res.status === 403
          ? "auth"
          : res.status === 429
            ? "rate_limit"
            : res.status >= 500
              ? "vendor_down"
              : "validation";

      // A 500 is ambiguous by their design: it is also what a rejected
      // signature returns. Say so in the message, so nobody concludes the
      // vendor is down a second time.
      const hint =
        res.status >= 500
          ? " (note: Apliiq also returns 500 for a rejected signature, so this may be auth)"
          : "";

      throw new FulfillmentError(
        kind,
        `Apliiq ${method} ${path} -> ${res.status}${hint}`,
        "apliiq",
        { endpoint: path, status: res.status, body: text.slice(0, 2000) },
      );
    }

    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new FulfillmentError("unknown", `Apliiq ${path} returned non-JSON`, "apliiq", {
        endpoint: path,
        status: res.status,
        body: text.slice(0, 500),
      });
    }
  }

  capabilities(): ProviderCapabilities {
    return {
      // Observed across their live catalog, not taken from marketing copy.
      decorationMethods: ["dtg", "dtf", "screen_print", "embroidery", "applique", "sublimation"],
      // The reason this vendor is in the project at all: woven_label,
      // printed_label, neck_print and private_label are all live services.
      privateLabel: true,
      brandedPackingSlip: true,
      cutAndSew: false,
      // No mockup endpoint is documented, so we composite ourselves.
      vendorMockups: false,
      // Confirmed absent by Apliiq support 2026-08-19: there is no order
      // status webhook at all. So status has to be polled via getOrder.
      webhooks: false,
      // Undocumented. Null means "assume conservative", per the interface.
      rateLimitPerMinute: null,
    };
  }

  /* ---------------- catalog (verified against the live API) ---------------- */

  private async catalog(): Promise<ApliiqProduct[]> {
    if (this.catalogCache) return this.catalogCache;
    // One ~15MB response covers the whole catalog. There is no pagination and
    // no per-product endpoint, so it is fetched once and held per instance.
    const data = await this.request<{ Products: ApliiqProduct[] }>("GET", "/v1/Product");
    this.catalogCache = data.Products ?? [];
    return this.catalogCache;
  }

  private toBlank(p: ApliiqProduct): CatalogBlank {
    const colors: CatalogColor[] = (p.Colors ?? []).map((c) => ({
      name: c.Name,
      // Their catalog carries no hex. Null is honest; a made-up value would
      // drive the dark-garment rule off fiction.
      hex: null,
      isDark: isDarkColorName(c.Name),
    }));

    const supportedDecoration = [
      ...new Set(
        (p.Services ?? [])
          .map((s) => SERVICE_TO_DECORATION[s.Alt_Name])
          .filter((d): d is DecorationMethod => Boolean(d)),
      ),
    ];

    const placements: PlacementSpec[] = [];
    for (const loc of p.Locations ?? []) {
      const code = LOCATION_TO_PLACEMENT[(loc.Name ?? "").trim().toLowerCase()];
      if (!code) continue;
      if (placements.some((x) => x.code === code)) continue;
      placements.push({
        code,
        // Apliiq publishes no print dimensions — DesignBox is empty across the
        // entire catalog. Zeroes are deliberate and load-bearing: they mean
        // UNKNOWN, and validateAgainstPlacement refuses on them rather than
        // approving artwork against a size nobody ever verified. That guard was
        // added for this adapter; before it, a zero width made the DPI check
        // divide by zero and pass everything.
        widthIn: 0,
        heightIn: 0,
        minDpi: 0,
      });
    }

    return {
      externalId: String(p.Id),
      // They ship no brand field; the SKU is the manufacturer style code.
      brand: p.SKU ?? "",
      model: p.Name ?? "",
      description: p.Description || null,
      colors,
      sizes: (p.Sizes ?? []).map((s) => s.Name),
      supportedDecoration,
      placements,
      imageUrl: normalizeImage(p.Locations?.[0]?.ImagePath),
    };
  }

  async listBlanks(): Promise<CatalogBlank[]> {
    return (await this.catalog()).map((p) => this.toBlank(p));
  }

  async getBlank(externalId: string): Promise<CatalogBlank> {
    const found = (await this.catalog()).find((p) => String(p.Id) === externalId);
    if (!found) {
      throw new FulfillmentError("validation", `Apliiq blank ${externalId} not found`, "apliiq");
    }
    return this.toBlank(found);
  }

  async listVariants(blankExternalId: string): Promise<CatalogVariant[]> {
    const p = (await this.catalog()).find((x) => String(x.Id) === blankExternalId);
    if (!p) {
      throw new FulfillmentError(
        "validation",
        `Apliiq blank ${blankExternalId} not found`,
        "apliiq",
      );
    }

    const variants: CatalogVariant[] = [];
    for (const size of p.Sizes ?? []) {
      for (const color of p.Colors ?? []) {
        variants.push({
          externalId: variantSku(p.Id, size.Id, color.Id),
          blankExternalId,
          color: color.Name,
          size: size.Name,
          // One price per product, plus their plus-size surcharge where set.
          // There is no per-colour pricing in their catalog.
          baseCostCents: dollarsToCents(p.Price) + dollarsToCents(size.PlusSize_Fee ?? 0),
          // No stock field is published. Assuming available is the same
          // assumption their own storefront makes.
          inStock: true,
        });
      }
    }
    return variants;
  }

  /* ---------------- orders ---------------- */

  /**
   * Written from their published schema; NEVER RUN. Submitting a real order
   * costs real money and produces a real garment — which is exactly what
   * FULFILLMENT_LIVE guards. Treat as unproven until one has been placed.
   */
  async submitOrder(input: SubmitOrderInput): Promise<VendorOrder> {
    const res = await this.request<{ id: number }>("POST", "/v1/Order", buildOrderPayload(input));

    return {
      externalOrderId: String(res.id),
      status: "submitted",
      // Their create response carries an id and nothing else — no pricing.
      vendorCostCents: null,
      shippingCostCents: null,
      taxCents: null,
      trackingNumber: null,
      trackingUrl: null,
      carrier: null,
      estimatedDelivery: null,
      rawStatus: "created",
    };
  }

  /**
   * Their only documented order read is the collection, so this filters the
   * list rather than inventing /v1/Order/{id}. The field names inside an order
   * object are UNKNOWN — the account has never had one — so both the id lookup
   * and the status mapping are deliberately defensive.
   */
  async getOrder(externalOrderId: string): Promise<VendorOrder> {
    const list = await this.request<unknown>("GET", "/v1/Order");
    const rows: unknown[] = Array.isArray(list)
      ? list
      : Array.isArray((list as { Orders?: unknown[] })?.Orders)
        ? (list as { Orders: unknown[] }).Orders
        : [];

    const found = rows.find((o) => {
      const r = o as Record<string, unknown>;
      return String(r.id ?? r.Id ?? "") === externalOrderId;
    }) as Record<string, unknown> | undefined;

    if (!found) {
      throw new FulfillmentError(
        "validation",
        `Apliiq order ${externalOrderId} not found`,
        "apliiq",
      );
    }

    const rawStatus = String(found.status ?? found.Status ?? "unknown");
    return {
      externalOrderId,
      status: mapOrderStatus(rawStatus),
      vendorCostCents: null,
      shippingCostCents: null,
      taxCents: null,
      trackingNumber: (found.tracking_number as string) ?? null,
      trackingUrl: (found.tracking_url as string) ?? null,
      carrier: (found.carrier as string) ?? null,
      estimatedDelivery: null,
      rawStatus,
    };
  }

  /* ---------------- not published by the vendor ---------------- */

  async uploadArtwork(_input: ArtworkUpload): Promise<VendorArtwork> {
    throw new FulfillmentError("validation", `uploadArtwork: ${UNDISCOVERED}`, "apliiq");
  }

  async createProduct(_input: CreateVendorProductInput): Promise<VendorProduct> {
    throw new FulfillmentError("validation", `createProduct: ${UNDISCOVERED}`, "apliiq");
  }

  async deleteProduct(_externalProductId: string): Promise<void> {
    throw new FulfillmentError("validation", `deleteProduct: ${UNDISCOVERED}`, "apliiq");
  }

  async quoteShipping(_input: {
    items: Array<{ externalVariantId: string; quantity: number }>;
    shipping: ShippingAddress;
  }): Promise<ShippingQuote[]> {
    throw new FulfillmentError("validation", `quoteShipping: ${UNDISCOVERED}`, "apliiq");
  }

  async estimateCost(_input: SubmitOrderInput): Promise<CostEstimate> {
    throw new FulfillmentError("validation", `estimateCost: ${UNDISCOVERED}`, "apliiq");
  }

  async cancelOrder(_externalOrderId: string): Promise<void> {
    throw new FulfillmentError("validation", `cancelOrder: ${UNDISCOVERED}`, "apliiq");
  }

  /**
   * Apliiq confirmed 2026-08-19 that no order status webhook exists. Anything
   * arriving here is therefore not from them, and returning null would treat a
   * forgery as merely uninteresting. Throwing is the honest answer, and matches
   * the interface rule: never process an unverified webhook.
   */
  async parseWebhook(): Promise<NormalizedWebhookEvent | null> {
    throw new FulfillmentError(
      "validation",
      `parseWebhook: Apliiq publishes no webhook signing scheme. ${UNDISCOVERED}`,
      "apliiq",
    );
  }
}

/* ------------------------------------------------------------------ */

/**
 * The POST /v1/Order body.
 *
 * Exported so the idempotency contract can be tested without placing an order.
 * Apliiq dedupes on **id + order_number together**, so those two must always
 * carry the same deterministic value derived from our order id.
 */
export function buildOrderPayload(input: SubmitOrderInput) {
  const id = orderIdToInt(input.localOrderId);

  return {
    id,
    number: id,
    // Our uuid travels here, where it survives as something a human can
    // reconcile against; their numeric fields cannot hold it.
    name: input.localOrderId,
    order_number: id,
    line_items: input.items.map((i) => ({
      id: i.localOrderItemId,
      name: i.externalVariantId,
      quantity: i.quantity,
      // They type price as a string of dollars, not integer cents.
      price: (i.retailPriceCents / 100).toFixed(2),
      sku: i.externalVariantId,
    })),
    shipping_address: toApliiqAddress(input.shipping),
    shipping_lines: [{ code: SHIPPING_CODE[input.shippingSpeed] ?? "standard" }],
  };
}

export function mapOrderStatus(raw: string): FulfillmentStatus {
  const s = raw.toLowerCase();
  if (/cancel/.test(s)) return "cancelled";
  if (/fail|error|reject|decline/.test(s)) return "failed";
  if (/deliver/.test(s)) return "delivered";
  if (/ship|transit|fulfil/.test(s)) return "shipped";
  if (/produc|print|press|manufact/.test(s)) return "in_production";
  if (/receiv|accept|creat|pending|new|submit/.test(s)) return "submitted";
  // Never assume progress. The interface requires unknown to surface.
  return "unknown";
}

export function toApliiqAddress(a: ShippingAddress) {
  const parts = a.name.trim().split(/\s+/);
  return {
    first_name: parts[0] ?? a.name,
    last_name: parts.slice(1).join(" ") || parts[0] || a.name,
    address1: a.line1,
    address2: a.line2 ?? "",
    city: a.city,
    zip: a.postalCode,
    province: a.state ?? "",
    // Their docs require province_code only for US addresses.
    ...(a.country === "US" && a.state ? { province_code: a.state } : {}),
    country: a.country,
    country_code: a.country,
    phone: a.phone ?? "",
  };
}

function normalizeImage(path: string | undefined): string | null {
  if (!path) return null;
  return path.startsWith("//") ? `https:${path}` : path;
}
