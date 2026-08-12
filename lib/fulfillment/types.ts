/**
 * Vendor-agnostic fulfillment interface.
 *
 * RULE: no vendor SDK, endpoint, or field name may appear outside lib/fulfillment/.
 * Application code depends on these types only.
 *
 * All money is integer cents. All currency is USD for v1.
 */

export type ProviderId = "printful" | "apliiq";

export type DecorationMethod =
  | "dtg"
  | "dtf"
  | "screen_print"
  | "embroidery"
  | "applique"
  | "sublimation";

export type PlacementCode =
  | "front"
  | "back"
  | "left_chest"
  | "right_chest"
  | "sleeve_left"
  | "sleeve_right"
  | "neck_inner"
  | "neck_outer";

export type ShippingSpeed = "standard" | "expedited" | "rush";

/**
 * Normalized order lifecycle. Vendor-specific statuses MUST map onto these.
 * Anything unrecognized maps to "unknown" and raises an alert — never silently dropped.
 */
export type FulfillmentStatus =
  | "pending"      // accepted by us, not yet sent to vendor
  | "submitted"    // vendor accepted
  | "in_production"
  | "shipped"
  | "delivered"
  | "cancelled"
  | "failed"
  | "unknown";

/* ------------------------------------------------------------------ */
/* Capabilities — used for routing between vendors                     */
/* ------------------------------------------------------------------ */

export interface ProviderCapabilities {
  decorationMethods: DecorationMethod[];
  /** Custom neck tag / woven label. Core to our positioning. */
  privateLabel: boolean;
  /** Branded packing slip or insert. */
  brandedPackingSlip: boolean;
  cutAndSew: boolean;
  /** Vendor can render mockups server-side; if false we composite ourselves. */
  vendorMockups: boolean;
  /** Vendor supports webhook callbacks for status changes. */
  webhooks: boolean;
  /** Requests per minute, if documented. null = unknown, assume conservative. */
  rateLimitPerMinute: number | null;
}

/* ------------------------------------------------------------------ */
/* Catalog                                                             */
/* ------------------------------------------------------------------ */

export interface CatalogBlank {
  /** Vendor's identifier. Opaque to application code. */
  externalId: string;
  brand: string;          // "Independent Trading Co."
  model: string;          // "SS4500 Midweight Hoodie"
  description: string | null;
  colors: CatalogColor[];
  sizes: string[];
  supportedDecoration: DecorationMethod[];
  placements: PlacementSpec[];
  imageUrl: string | null;
}

export interface CatalogColor {
  name: string;
  hex: string | null;
  /** True for dark garments. Used to force DTF/screen over DTG — DTG on darks
   *  is the single most common print-quality complaint across vendors. */
  isDark: boolean;
}

export interface PlacementSpec {
  code: PlacementCode;
  /** Print area in inches, for validating uploaded artwork resolution. */
  widthIn: number;
  heightIn: number;
  /** Minimum DPI the vendor requires at full print size. */
  minDpi: number;
}

export interface CatalogVariant {
  externalId: string;
  blankExternalId: string;
  color: string;
  size: string;
  /** Vendor's base cost before our fee. Integer cents. */
  baseCostCents: number;
  inStock: boolean;
}

/* ------------------------------------------------------------------ */
/* Artwork and products                                                */
/* ------------------------------------------------------------------ */

export interface ArtworkUpload {
  /** Publicly reachable URL. Vendors fetch by URL rather than accepting bytes. */
  url: string;
  filename: string;
  placement: PlacementCode;
  decoration: DecorationMethod;
}

export interface VendorArtwork {
  externalArtworkId: string;
  url: string;
}

export interface CreateVendorProductInput {
  /** Our internal id, sent as the vendor's external reference for reconciliation. */
  localProductId: string;
  /** Which seller. Determines vendor sub-store where the vendor supports it. */
  storeId: string;
  name: string;
  blankExternalId: string;
  variants: Array<{
    localVariantId: string;
    catalogVariantExternalId: string;
    /** Retail price the customer pays. Integer cents. */
    retailPriceCents: number;
  }>;
  artwork: ArtworkUpload[];
  privateLabel?: PrivateLabelSpec;
}

export interface PrivateLabelSpec {
  neckTagArtworkUrl?: string;
  wovenLabelText?: string;
  removeVendorBranding: boolean;
}

export interface VendorProduct {
  externalProductId: string;
  variants: Array<{
    localVariantId: string;
    externalVariantId: string;
  }>;
}

/* ------------------------------------------------------------------ */
/* Orders                                                              */
/* ------------------------------------------------------------------ */

export interface ShippingAddress {
  name: string;
  line1: string;
  line2?: string | null;
  city: string;
  /** ISO 3166-2 subdivision code where applicable. */
  state: string | null;
  postalCode: string;
  /** ISO 3166-1 alpha-2. */
  country: string;
  phone?: string | null;
  email?: string | null;
}

export interface SubmitOrderInput {
  /**
   * Our order id. MUST be sent to the vendor as their external reference AND used
   * as the idempotency key. Re-submitting the same key must never duplicate an order.
   */
  localOrderId: string;
  storeId: string;
  items: Array<{
    localOrderItemId: string;
    externalVariantId: string;
    quantity: number;
    /** Retail price, for the vendor's packing slip. Integer cents. */
    retailPriceCents: number;
  }>;
  shipping: ShippingAddress;
  shippingSpeed: ShippingSpeed;
  /** When true the vendor should hold rather than auto-fulfil. Used for review queue. */
  holdForReview?: boolean;
}

export interface VendorOrder {
  externalOrderId: string;
  status: FulfillmentStatus;
  /** What the vendor charges us. Integer cents. Null until the vendor prices it. */
  vendorCostCents: number | null;
  shippingCostCents: number | null;
  taxCents: number | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  carrier: string | null;
  estimatedDelivery: string | null; // ISO date
  /** Vendor's own status string, kept verbatim for debugging. */
  rawStatus: string;
}

export interface ShippingQuote {
  speed: ShippingSpeed;
  costCents: number;
  minBusinessDays: number | null;
  maxBusinessDays: number | null;
}

export interface CostEstimate {
  itemsCostCents: number;
  shippingCostCents: number;
  taxCents: number;
  totalCents: number;
}

/* ------------------------------------------------------------------ */
/* Webhooks                                                            */
/* ------------------------------------------------------------------ */

export interface NormalizedWebhookEvent {
  provider: ProviderId;
  /** Vendor's event id if provided, else a hash of the payload. Used for dedup. */
  externalEventId: string;
  type: "status_changed" | "shipped" | "failed" | "cancelled" | "unhandled";
  externalOrderId: string | null;
  status: FulfillmentStatus;
  trackingNumber: string | null;
  trackingUrl: string | null;
  carrier: string | null;
  raw: unknown;
}

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

export type FulfillmentErrorKind =
  | "auth"          // credentials rejected — alert, do not retry
  | "rate_limit"    // back off and retry
  | "validation"    // our payload is wrong — alert, do not retry
  | "out_of_stock"
  | "vendor_down"   // 5xx — retry with backoff
  | "unknown";

export class FulfillmentError extends Error {
  constructor(
    public kind: FulfillmentErrorKind,
    message: string,
    public provider: ProviderId,
    /** Full request/response, needed for vendor support tickets. */
    public context?: { endpoint?: string; status?: number; body?: unknown },
  ) {
    super(message);
    this.name = "FulfillmentError";
  }

  get retryable(): boolean {
    return this.kind === "rate_limit" || this.kind === "vendor_down";
  }
}

/* ------------------------------------------------------------------ */
/* The interface every vendor adapter implements                       */
/* ------------------------------------------------------------------ */

export interface FulfillmentProvider {
  readonly id: ProviderId;
  capabilities(): ProviderCapabilities;

  listBlanks(opts?: { category?: string }): Promise<CatalogBlank[]>;
  getBlank(externalId: string): Promise<CatalogBlank>;
  listVariants(blankExternalId: string): Promise<CatalogVariant[]>;

  uploadArtwork(input: ArtworkUpload): Promise<VendorArtwork>;
  createProduct(input: CreateVendorProductInput): Promise<VendorProduct>;
  deleteProduct(externalProductId: string): Promise<void>;

  quoteShipping(input: {
    items: Array<{ externalVariantId: string; quantity: number }>;
    shipping: ShippingAddress;
  }): Promise<ShippingQuote[]>;

  estimateCost(input: SubmitOrderInput): Promise<CostEstimate>;

  /** MUST be idempotent on input.localOrderId. */
  submitOrder(input: SubmitOrderInput): Promise<VendorOrder>;
  getOrder(externalOrderId: string): Promise<VendorOrder>;
  cancelOrder(externalOrderId: string): Promise<void>;

  /**
   * Verify signature and normalize. Return null for events we don't care about.
   * Throw if the signature is invalid — never process an unverified webhook.
   */
  parseWebhook(
    rawBody: string,
    headers: Record<string, string>,
  ): Promise<NormalizedWebhookEvent | null>;
}
