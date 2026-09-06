/**
 * Printful adapter.
 *
 * Auth: Bearer token, Account-level private token from the Printful Developer Portal.
 *   - Account-level (NOT Store-level) so one token reaches every seller's sub-store.
 *   - NOT a Public App — that model has sellers connect their own Printful accounts,
 *     which breaks merchant-of-record and destroys margin capture.
 *
 * Store-per-seller: create a Printful "Manual orders / API platform" store for each
 * seller and pass its id in the X-PF-Store-Id header on store-scoped calls.
 *
 * v1 is stable; v2 is beta. PROJECT.md commits to v1 for orders. Two consequences of
 * that choice are load-bearing and are handled explicitly below:
 *
 *   1. v1 has NO idempotency header. Request signing and idempotency are v2 features.
 *      Idempotency here is built on external_id + a pre-flight lookup. See submitOrder.
 *   2. v1 webhooks are UNSIGNED. There is nothing to cryptographically verify. See
 *      parseWebhook for what we do instead.
 *
 * Endpoint paths and response shapes below were checked against developers.printful.com
 * in Aug 2026. Anything still uncertain is marked UNVERIFIED.
 */

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
  type ShippingSpeed,
  type SubmitOrderInput,
  type VendorArtwork,
  type VendorOrder,
  type VendorProduct,
} from "./types";

const BASE = "https://api.printful.com";

/** Verified: 120 requests per 60s, reported in X-Ratelimit-Policy as "120;w=60". */
const RATE_LIMIT_PER_MINUTE = 120;

/** Catalog hydration fans out one request per blank. Stay well under the limit. */
const CATALOG_CONCURRENCY = 4;

/**
 * Printful returns `color: null` on some all-over-print garments, where the print
 * covers the whole garment and there is no colourway to choose. Both
 * catalog_variants.color and catalog_colors.name are NOT NULL, and CatalogVariant
 * declares color as a plain string, so a label is required.
 *
 * This is a display label standing in for "no choice", not invented product data.
 * The alternative — making colour nullable — pushes optionality through the schema,
 * the interface and every consumer for a handful of blanks.
 */
const UNNAMED_COLOR = "Default";

const MAX_RETRIES = 3;

/**
 * Undocumented, found by testing lengths against the live API: Printful rejects
 * an order external_id longer than 32 characters. A UUID with hyphens is 36.
 */
const EXTERNAL_ID_MAX = 32;

/**
 * Printful names products "Unisex Staple T-Shirt | Bella + Canvas 3001".
 * Everything after the pipe is the brand and SKU, which already have their own
 * columns, so keeping it would print the brand twice in the UI.
 *
 * Returns null when nothing useful is left, so callers can fall back to the
 * model rather than rendering an empty string.
 */
export function humanName(raw: string | null): string | null {
  if (!raw) return null;
  const name = raw.split("|")[0].trim();
  return name.length ? name : null;
}

export class PrintfulProvider implements FulfillmentProvider {
  readonly id = "printful" as const;

  private token(): string {
    const t = process.env.PRINTFUL_API_TOKEN;
    if (!t) throw new FulfillmentError("auth", "PRINTFUL_API_TOKEN not set", "printful");
    return t;
  }

  /** Remaining quota, learned from response headers. Null until the first call. */
  private remaining: number | null = null;
  private resetAt = 0;

  /** Cached store id used to satisfy store-scoped catalog reads. See catalogStoreId. */
  private catalogStore: string | null = null;

  /**
   * Several endpoints are store-scoped even though their data is not tied to any
   * one store — /mockup-generator/printfiles and /shipping/rates both are, and an
   * account-level token gets `400 This endpoint requires store_id!` without the
   * header. Used wherever a call needs *a* store rather than a seller's store.
   *
   * Any store on the account returns the same print areas, so this resolves one and
   * caches it. Set PRINTFUL_CATALOG_STORE_ID to pin it; otherwise the first store on
   * the account is used.
   */
  private async catalogStoreId(): Promise<string> {
    if (this.catalogStore) return this.catalogStore;

    const pinned = process.env.PRINTFUL_CATALOG_STORE_ID;
    if (pinned) {
      this.catalogStore = pinned;
      return pinned;
    }

    const stores = await this.call<Array<{ id: number }>>("GET", "/stores");
    if (!stores.length) {
      throw new FulfillmentError(
        "validation",
        "Printful account has no stores; cannot read store-scoped catalog data",
        "printful",
        { endpoint: "/stores" },
      );
    }

    this.catalogStore = String(stores[0].id);
    return this.catalogStore;
  }

  capabilities(): ProviderCapabilities {
    return {
      decorationMethods: ["dtg", "dtf", "embroidery", "sublimation"],
      privateLabel: false,      // inside labels only; not true custom neck tags
      brandedPackingSlip: true,
      // Verified: 111 catalog products carry the CUT-SEW technique.
      cutAndSew: true,
      vendorMockups: true,
      webhooks: true,
      rateLimitPerMinute: RATE_LIMIT_PER_MINUTE,
    };
  }

  /* ---------------------------------------------------------------- */
  /* Transport                                                        */
  /* ---------------------------------------------------------------- */

  private async call<T>(
    method: string,
    path: string,
    opts: { body?: unknown; storeId?: string; query?: Record<string, string> } = {},
  ): Promise<T> {
    const url = new URL(BASE + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token()}`,
      "Content-Type": "application/json",
    };
    // Store-scoped calls need this. Only account-level tokens may set it.
    if (opts.storeId) headers["X-PF-Store-Id"] = opts.storeId;

    let lastError: FulfillmentError | null = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      // If a previous response said we are out of quota, wait rather than
      // spending an attempt on a guaranteed 429.
      if (this.remaining !== null && this.remaining <= 0 && Date.now() < this.resetAt) {
        await sleep(this.resetAt - Date.now());
      }

      let res: Response;
      try {
        res = await fetch(url, {
          method,
          headers,
          body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        });
      } catch (e) {
        // Network-level failure. Retryable — the request may never have landed,
        // which is exactly why submitOrder checks for an existing order first.
        lastError = new FulfillmentError("vendor_down", String(e), "printful", {
          endpoint: path,
        });
        await sleep(backoffMs(attempt));
        continue;
      }

      this.readRateLimit(res);

      const text = await res.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }

      if (res.ok) {
        // Printful v1 wraps every payload in { code, result }.
        return (parsed as { result: T }).result;
      }

      const err = new FulfillmentError(
        mapErrorKind(res.status),
        `Printful ${method} ${path} -> ${res.status}: ${printfulMessage(parsed)}`,
        "printful",
        { endpoint: path, status: res.status, body: parsed },
      );

      if (!err.retryable || attempt === MAX_RETRIES) throw err;

      lastError = err;
      const retryAfter = Number(res.headers.get("Retry-After"));
      await sleep(
        Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : backoffMs(attempt),
      );
    }

    throw lastError ?? new FulfillmentError("unknown", "retries exhausted", "printful", {
      endpoint: path,
    });
  }

  /** Verified header names: X-Ratelimit-Limit / -Remaining / -Reset / -Policy. */
  private readRateLimit(res: Response) {
    const remaining = Number(res.headers.get("X-Ratelimit-Remaining"));
    if (Number.isFinite(remaining)) this.remaining = remaining;

    const reset = Number(res.headers.get("X-Ratelimit-Reset"));
    if (Number.isFinite(reset) && reset > 0) {
      // Documented as seconds until the bucket refills.
      this.resetAt = Date.now() + reset * 1000;
    }
  }

  /* ---------------------------------------------------------------- */
  /* Catalog                                                          */
  /* ---------------------------------------------------------------- */

  /**
   * Full catalog, hydrated.
   *
   * GET /products returns a shallow list with no variants, colors, or print areas —
   * but CatalogBlank promises all three, so each entry is hydrated via getBlank.
   * That is one request per blank, which is why this is rate-limited and why the
   * results belong in catalog_blanks. Never call this from a page load.
   */
  async listBlanks(opts: { category?: string } = {}): Promise<CatalogBlank[]> {
    const list = await this.call<PfCatalogProduct[]>("GET", "/products", {
      query: opts.category ? { category_id: opts.category } : undefined,
    });

    const live = list.filter((p) => !p.is_discontinued);
    const hydrated = await mapWithConcurrency(live, CATALOG_CONCURRENCY, (p) =>
      this.getBlank(String(p.id)),
    );

    // Sideline blanks we cannot decorate. A blank whose every technique failed to
    // map (all-over cotton, UV, knitwear, digital) is not a product a seller can
    // build on — surfacing it means offering a garment the design tool will then
    // refuse. Better to never show it.
    //
    // This currently hides ~21 all-over cotton blanks. To bring them back, add an
    // `all_over` member to DecorationMethod in types.ts AND to the decoration_method
    // enum in 0001_init.sql, then map DIRECT-TO-FABRIC to it. Both are additive.
    return hydrated.filter((b) => b.supportedDecoration.length > 0);
  }

  async getBlank(externalId: string): Promise<CatalogBlank> {
    const res = await this.call<{ product: PfCatalogProduct; variants: PfVariant[] }>(
      "GET",
      `/products/${encodeURIComponent(externalId)}`,
    );

    const { product, variants } = res;

    // Colors and sizes are properties of the variant list, not the product.
    const colors = new Map<string, CatalogColor>();
    const sizes = new Set<string>();
    for (const v of variants) {
      sizes.add(v.size);
      const name = v.color || UNNAMED_COLOR;
      if (!colors.has(name)) {
        colors.set(name, {
          name,
          hex: v.color_code ?? null,
          isDark: isDarkHex(v.color_code),
        });
      }
    }

    return {
      externalId: String(product.id),
      // Printful leaves brand null on its own-label goods. Falling back to
      // type_name there just duplicates the model ("All-Over Print Recycled Unisex
      // Hoodie / All-Over Print Recycled Unisex Hoodie"), so an unbranded blank
      // gets an empty brand and the UI shows the model alone.
      brand: product.brand ?? "",
      // `model` is the garment SKU. It reads well on some blanks ("SS4500
      // Midweight Hoodie") and is a bare number on most ("3001"), which is why
      // displayName exists rather than this being reworded.
      model: product.model || product.title || "",
      // "Unisex Staple T-Shirt | Bella + Canvas 3001" -> "Unisex Staple T-Shirt".
      // The brand and SKU after the pipe already have their own columns.
      displayName: humanName(product.name ?? product.title ?? null),
      garmentType: product.type ?? product.type_name ?? null,
      description: product.description ?? null,
      colors: [...colors.values()],
      sizes: [...sizes],
      supportedDecoration: mapTechniques(product.techniques),
      placements: await this.placementsFor(String(product.id)),
      imageUrl: product.image ?? null,
    };
  }

  async listVariants(blankExternalId: string): Promise<CatalogVariant[]> {
    const res = await this.call<{ product: PfCatalogProduct; variants: PfVariant[] }>(
      "GET",
      `/products/${encodeURIComponent(blankExternalId)}`,
    );

    return res.variants.map((v) => ({
      externalId: String(v.id),
      blankExternalId,
      color: v.color || UNNAMED_COLOR,
      size: v.size,
      // Printful returns price as a decimal STRING ("9.85"). Parsed without
      // floats — see dollarsToCents.
      baseCostCents: dollarsToCents(v.price),
      inStock: v.in_stock ?? false,
    }));
  }

  /**
   * Print areas, used to validate uploaded artwork resolution.
   *
   * GET /mockup-generator/printfiles/{id} returns printfile dimensions in PIXELS
   * plus the dpi, so inches = pixels / dpi.
   *
   * A blank with genuinely no printfile data is not an error — some catalog items
   * are not printable — so a 404 yields an empty placement list and the design tool
   * refuses to build on it.
   *
   * Only a 404. An earlier version swallowed every `validation` error here, which
   * silently turned a missing store header into "this blank has no print areas" for
   * the entire catalog. Broad catches around configuration errors do not degrade
   * gracefully, they degrade invisibly.
   */
  private async placementsFor(productId: string): Promise<PlacementSpec[]> {
    let res: PfPrintfiles;
    try {
      res = await this.call<PfPrintfiles>(
        "GET",
        `/mockup-generator/printfiles/${encodeURIComponent(productId)}`,
        { storeId: await this.catalogStoreId() },
      );
    } catch (e) {
      if (e instanceof FulfillmentError && e.context?.status === 404) return [];
      throw e;
    }

    const byId = new Map(res.printfiles?.map((p) => [p.printfile_id, p]) ?? []);
    const out: PlacementSpec[] = [];
    const seen = new Set<PlacementCode>();

    // available_placements maps a Printful placement key to a display name.
    // variant_printfiles maps each variant's placements to a printfile id; the
    // dimensions live on the printfile, so we join through the first variant
    // that has the placement.
    //
    // Because keys are technique-scoped, one PlacementCode can have several
    // candidates with DIFFERENT print areas (front vs front_dtfabric). PlacementSpec
    // has no technique field, so only one can win. Bare keys are sorted first so the
    // default technique's print area is the one recorded — the conservative choice,
    // since it is the process most blanks actually use.
    //
    // KNOWN LIMITATION: a seller choosing a non-default technique on the same blank
    // may see a print area that is slightly off. Fixing it properly means keying
    // PlacementSpec by decoration method, which is an interface change.
    const keys = Object.keys(res.available_placements ?? {}).sort(
      (a, b) => affixCount(a) - affixCount(b),
    );

    for (const key of keys) {
      const code = mapPlacement(key);
      if (!code || seen.has(code)) continue;

      const withPlacement = res.variant_printfiles?.find((vp) => vp.placements?.[key]);
      const pf = withPlacement ? byId.get(withPlacement.placements[key]) : undefined;
      if (!pf || !pf.dpi) continue;

      seen.add(code);
      out.push({
        code,
        widthIn: round2(pf.width / pf.dpi),
        heightIn: round2(pf.height / pf.dpi),
        minDpi: pf.dpi,
      });
    }

    return out;
  }

  /* ---------------------------------------------------------------- */
  /* Artwork and products                                             */
  /* ---------------------------------------------------------------- */

  /**
   * POST /files with { url }. Printful fetches by URL rather than accepting bytes,
   * and dedupes on identical URLs — so the artwork must live at a stable, publicly
   * reachable URL for the lifetime of the product, not a short-lived signed one.
   * (See the `artwork` bucket in 0001_init.sql.)
   */
  async uploadArtwork(input: ArtworkUpload): Promise<VendorArtwork> {
    const file = await this.call<PfFile>("POST", "/files", {
      body: { url: input.url, filename: input.filename },
    });

    if (file.status === "failed") {
      throw new FulfillmentError(
        "validation",
        `Printful could not process artwork ${input.filename}: ${file.error ?? "unknown"}`,
        "printful",
        { endpoint: "/files", body: file },
      );
    }

    return { externalArtworkId: String(file.id), url: file.url ?? input.url };
  }

  async createProduct(input: CreateVendorProductInput): Promise<VendorProduct> {
    const files = input.artwork.map((a) => ({
      type: placementToFileType(a.placement),
      url: a.url,
    }));

    const body = {
      sync_product: {
        name: input.name,
        // external_id is how webhooks and orders are reconciled back to us.
        // Always our local id, never a display string.
        external_id: input.localProductId,
      },
      sync_variants: input.variants.map((v) => ({
        external_id: v.localVariantId,
        variant_id: Number(v.catalogVariantExternalId),
        retail_price: centsToDollars(v.retailPriceCents),
        files,
      })),
    };

    const res = await this.call<{ sync_product: PfSyncProduct; sync_variants: PfSyncVariant[] }>(
      "POST",
      "/store/products",
      { body, storeId: input.storeId },
    );

    return {
      externalProductId: String(res.sync_product.id),
      variants: res.sync_variants.map((v) => ({
        localVariantId: v.external_id,
        externalVariantId: String(v.id),
      })),
    };
  }

  async deleteProduct(externalProductId: string): Promise<void> {
    await this.call<unknown>(
      "DELETE",
      `/store/products/${encodeURIComponent(externalProductId)}`,
    );
  }

  /* ---------------------------------------------------------------- */
  /* Orders                                                           */
  /* ---------------------------------------------------------------- */

  async quoteShipping(input: {
    items: Array<{ externalVariantId: string; quantity: number }>;
    shipping: ShippingAddress;
  }): Promise<ShippingQuote[]> {
    // Store-scoped, like the catalog endpoints, even though rates depend only on
    // the basket and destination. Any store on the account returns the same
    // answer; an account-level token just has to name one.
    const rates = await this.call<PfShippingRate[]>("POST", "/shipping/rates", {
      storeId: await this.catalogStoreId(),
      body: {
        recipient: toRecipient(input.shipping),
        items: input.items.map((i) => ({
          variant_id: Number(i.externalVariantId),
          quantity: i.quantity,
        })),
        currency: "USD",
      },
    });

    // Printful's rate ids are vendor vocabulary and must not leak past this file.
    return rates.map((r) => ({
      speed: mapShippingSpeed(r.id),
      costCents: dollarsToCents(r.rate),
      minBusinessDays: r.minDeliveryDays ?? null,
      maxBusinessDays: r.maxDeliveryDays ?? null,
    }));
  }

  /**
   * Real vendor cost at checkout, so seller margin is computed against what we will
   * actually be charged rather than a cached catalog price.
   */
  async estimateCost(input: SubmitOrderInput): Promise<CostEstimate> {
    const res = await this.call<{ costs: PfCosts }>("POST", "/orders/estimate-costs", {
      body: this.orderBody(input),
      storeId: input.storeId,
    });

    const c = res.costs;
    return {
      itemsCostCents: dollarsToCents(c.subtotal),
      shippingCostCents: dollarsToCents(c.shipping),
      taxCents: dollarsToCents(c.tax) + dollarsToCents(c.vat ?? "0"),
      totalCents: dollarsToCents(c.total),
    };
  }

  /**
   * Idempotent on input.localOrderId.
   *
   * Printful v1 has no idempotency header — that is a v2 feature. So idempotency is
   * built from two things that v1 does guarantee:
   *
   *   1. external_id is unique per store. A duplicate POST is rejected, not accepted twice.
   *   2. GET /orders/@{external_id} resolves an order by that same key.
   *
   * We look before we leap, and we also catch the duplicate-rejection on the way out,
   * because a network timeout can leave an order created with no response delivered.
   * Both paths converge on "fetch and return the existing order".
   *
   * A duplicate here means we pay twice and ship twice, so this is deliberately
   * belt-and-braces.
   */
  async submitOrder(input: SubmitOrderInput): Promise<VendorOrder> {
    const existing = await this.findByExternalId(input.localOrderId, input.storeId);
    if (existing) return toVendorOrder(existing);

    try {
      const created = await this.call<PfOrder>("POST", "/orders", {
        body: this.orderBody(input),
        storeId: input.storeId,
        // confirm=1 submits straight to fulfilment. Omitting it leaves the order as
        // a draft, which is what the review queue needs.
        query: input.holdForReview ? undefined : { confirm: "1" },
      });
      return toVendorOrder(created);
    } catch (e) {
      // The order may have been created despite the error we saw.
      if (e instanceof FulfillmentError && (e.kind === "validation" || e.kind === "vendor_down")) {
        const raced = await this.findByExternalId(input.localOrderId, input.storeId);
        if (raced) return toVendorOrder(raced);
      }
      throw e;
    }
  }

  /** Returns null when the order does not exist, rather than throwing. */
  private async findByExternalId(localOrderId: string, storeId?: string): Promise<PfOrder | null> {
    try {
      return await this.call<PfOrder>(
        "GET",
        `/orders/@${encodeURIComponent(localOrderId)}`,
        { storeId },
      );
    } catch (e) {
      if (e instanceof FulfillmentError && e.context?.status === 404) return null;
      throw e;
    }
  }

  async getOrder(externalOrderId: string): Promise<VendorOrder> {
    const res = await this.call<PfOrder>(
      "GET",
      `/orders/${encodeURIComponent(externalOrderId)}`,
    );
    return toVendorOrder(res);
  }

  /**
   * Only possible before production starts. A failure here is expected — an order
   * already in production genuinely cannot be cancelled — so it surfaces as a
   * validation error for the caller to record, never as something to retry forever.
   */
  async cancelOrder(externalOrderId: string): Promise<void> {
    await this.call<unknown>("DELETE", `/orders/${encodeURIComponent(externalOrderId)}`);
  }

  private orderBody(input: SubmitOrderInput) {
    // Printful caps external_id at 32 characters and reports anything longer as
    // "Invalid External ID specified", which sends you looking at the format
    // rather than the length. Fail here instead, with a message that says what is
    // actually wrong. A 36-character UUID is the obvious way to hit this.
    if (input.localOrderId.length > EXTERNAL_ID_MAX) {
      throw new FulfillmentError(
        "validation",
        `localOrderId is ${input.localOrderId.length} chars; Printful allows ` +
        `${EXTERNAL_ID_MAX}. See migration 0004 — idempotency keys must be ` +
        `hyphen-free UUIDs.`,
        "printful",
      );
    }

    return {
      external_id: input.localOrderId,
      shipping: shippingSpeedToService(input.shippingSpeed),
      recipient: toRecipient(input.shipping),
      items: input.items.map((i) => ({
        external_id: i.localOrderItemId,
        variant_id: Number(i.externalVariantId),
        quantity: i.quantity,
        // Printful prints this on the packing slip. It is the CUSTOMER's price,
        // not what we pay.
        retail_price: centsToDollars(i.retailPriceCents),
      })),
    };
  }

  /* ---------------------------------------------------------------- */
  /* Webhooks                                                         */
  /* ---------------------------------------------------------------- */

  /**
   * Configure with POST /webhooks (GET to read, DELETE to disable).
   *
   * SECURITY: Printful v1 webhooks are UNSIGNED. There is no HMAC, no signature
   * header, no shared secret in the request — request signing is a v2-only feature.
   * So there is nothing here to cryptographically verify, and pretending otherwise
   * would be worse than admitting it.
   *
   * Two mitigations, both required:
   *
   *   1. The webhook route lives at a secret, unguessable path segment. The route
   *      handler compares that segment against PRINTFUL_WEBHOOK_SECRET and passes
   *      the result in as the x-internal-webhook-secret header. A mismatch throws,
   *      honouring the interface contract that an unverified webhook is never
   *      processed.
   *   2. The payload is treated as a HINT, never as truth. It tells us WHICH order
   *      changed; getOrder tells us what it changed to. Every status in the returned
   *      event comes from that re-fetch, so a forged payload cannot move an order
   *      into a state Printful does not agree with.
   *
   * Printful's own docs advise treating webhooks as unreliable and polling as a
   * backstop, so a reconciliation sweep over open orders is still required.
   */
  async parseWebhook(
    rawBody: string,
    headers: Record<string, string>,
  ): Promise<NormalizedWebhookEvent | null> {
    const expected = process.env.PRINTFUL_WEBHOOK_SECRET;
    if (!expected) {
      throw new FulfillmentError("auth", "PRINTFUL_WEBHOOK_SECRET not set", "printful");
    }

    const presented = headers["x-internal-webhook-secret"] ?? headers["X-Internal-Webhook-Secret"];
    if (!presented || !timingSafeEqual(presented, expected)) {
      throw new FulfillmentError("auth", "Webhook secret mismatch", "printful", {
        endpoint: "/webhook",
      });
    }

    let payload: PfWebhook;
    try {
      payload = JSON.parse(rawBody) as PfWebhook;
    } catch {
      throw new FulfillmentError("validation", "Webhook body is not JSON", "printful");
    }

    const type = mapWebhookType(payload.type);
    if (type === "unhandled") return null;

    const externalOrderId =
      payload.data?.order?.id != null ? String(payload.data.order.id) : null;

    // Printful supplies no event id, so dedupe on a hash of the payload.
    const externalEventId = await hashPayload(rawBody);

    if (!externalOrderId) {
      return {
        provider: "printful",
        externalEventId,
        type,
        externalOrderId: null,
        status: "unknown",
        trackingNumber: null,
        trackingUrl: null,
        carrier: null,
        raw: payload,
      };
    }

    // Authoritative state, not the payload's claim about it.
    const authoritative = await this.getOrder(externalOrderId);

    return {
      provider: "printful",
      externalEventId,
      type,
      externalOrderId,
      status: authoritative.status,
      trackingNumber: authoritative.trackingNumber,
      trackingUrl: authoritative.trackingUrl,
      carrier: authoritative.carrier,
      raw: payload,
    };
  }
}

/* ------------------------------------------------------------------ */
/* Money                                                              */
/* ------------------------------------------------------------------ */

/**
 * Printful returns money as decimal strings ("9.85"). Converting with
 * Math.round(parseFloat(x) * 100) is the classic penny-loss bug — 8.115 and
 * friends land on the wrong side. This parses the digits directly, so no
 * float ever touches a monetary value.
 */
export function dollarsToCents(value: string | number | null | undefined): number {
  if (value === null || value === undefined || value === "") return 0;

  const s = String(value).trim();
  const m = /^(-)?(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m) {
    throw new FulfillmentError("validation", `Unparseable money value: ${s}`, "printful");
  }

  const [, sign, whole, frac = ""] = m;
  const cents = frac.slice(0, 2).padEnd(2, "0");
  // Third decimal place, if present, rounds the cent.
  const roundUp = frac.length > 2 && Number(frac[2]) >= 5 ? 1 : 0;

  const total = Number(whole || "0") * 100 + Number(cents) + roundUp;
  return sign ? -total : total;
}

/** Integer cents back to the decimal string Printful expects. */
export function centsToDollars(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(Math.trunc(cents));
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/* ------------------------------------------------------------------ */
/* Mapping                                                            */
/* ------------------------------------------------------------------ */

function mapErrorKind(status: number) {
  if (status === 401 || status === 403) return "auth" as const;
  if (status === 429) return "rate_limit" as const;
  if (status >= 400 && status < 500) return "validation" as const;
  if (status >= 500) return "vendor_down" as const;
  return "unknown" as const;
}

/**
 * Printful status string -> our normalized status.
 *
 * Anything unmapped returns "unknown", which MUST raise an alert rather than being
 * silently treated as a no-op. Note "canceled" — Printful spells it with one l.
 *
 * Printful has no "delivered" state; delivery is inferred from carrier tracking
 * downstream, never from here.
 */
export function mapPrintfulStatus(raw: string): FulfillmentStatus {
  switch (raw) {
    case "draft":
      return "pending";
    case "pending":
    case "onhold":
      return "submitted";
    case "inprocess":
    case "partial":
      return "in_production";
    case "fulfilled":
    case "completed":
    case "archived":
      return "shipped";
    case "canceled":
      return "cancelled";
    case "failed":
      return "failed";
    default:
      return "unknown";
  }
}

function mapWebhookType(raw: string): NormalizedWebhookEvent["type"] {
  switch (raw) {
    case "package_shipped":
      return "shipped";
    case "order_failed":
      return "failed";
    case "order_canceled":
      return "cancelled";
    case "order_updated":
    case "order_put_hold":
    case "order_remove_hold":
    case "package_returned":
      return "status_changed";
    default:
      return "unhandled";
  }
}

/**
 * Printful technique keys -> our DecorationMethod.
 *
 * VERIFIED Aug 2026 against the live catalog (525 products). The keys are
 * UPPERCASE, which the docs do not show. The full observed set, by frequency:
 *
 *   EMBROIDERY (200)        "Embroidery"          -> embroidery
 *   DTG (141)               "DTG printing"        -> dtg
 *   DTFILM (124)            "DTF printing"        -> dtf
 *   CUT-SEW (111)           "All-over synthetic"  -> sublimation (all-over on
 *                                                    polyester IS sublimation)
 *   SUBLIMATION (74)        "Sublimation"         -> sublimation
 *   DIGITAL (50)            "Digital printing"    -> dropped, non-apparel
 *   UV (22)                 "UV printing"         -> dropped, non-apparel
 *   DIRECT-TO-FABRIC (21)   "All-over cotton"     -> dropped, see below
 *   KNITWEAR (8)            "Knitting"            -> dropped, not a decoration
 *
 * DIRECT-TO-FABRIC has no honest home in DecorationMethod. It is all-over
 * printing on cotton — not sublimation (that is polyester) and not DTG (that is
 * a placement-bounded print, not a full garment panel). Mapping it to either
 * would mean a seller picks one process and receives another. It is dropped, so
 * those 21 blanks currently surface with no decoration methods and the design
 * tool will refuse them. Fixing that properly means adding an `all_over` member
 * to DecorationMethod in types.ts — an interface change, so it is flagged rather
 * than made here.
 */
function mapTechniques(techniques: PfTechnique[] | undefined): DecorationMethod[] {
  const out = new Set<DecorationMethod>();
  for (const t of techniques ?? []) {
    switch (t.key?.toUpperCase()) {
      case "DTG":
        out.add("dtg");
        break;
      case "DTFILM":
        out.add("dtf");
        break;
      case "EMBROIDERY":
        out.add("embroidery");
        break;
      case "SUBLIMATION":
      case "CUT-SEW":
        out.add("sublimation");
        break;
    }
  }
  return [...out];
}

/**
 * Printful placement keys -> our PlacementCode.
 *
 * VERIFIED Aug 2026 by sampling 20 apparel blanks. Placement keys are
 * TECHNIQUE-SCOPED, which the docs do not mention: the same physical location
 * appears as `front`, `front_dtfabric`, or `chest_left_dtf` depending on the
 * decoration process. Matching bare keys alone — as the skeleton did — drops
 * every placement on an all-over or DTF blank, leaving no print areas and no way
 * to validate artwork resolution.
 *
 * So the technique affix is stripped first, then the bare location is matched.
 *
 * Observed keys that deliberately have NO PlacementCode: pocket, hood,
 * label_panel, details, top_front, top_back, embroidery_sleeve_left_top. They are
 * dropped rather than approximated — a placement we cannot describe is one the
 * design tool must not offer.
 */
function mapPlacement(key: string): PlacementCode | null {
  // Strip technique affixes: front_dtfabric -> front, embroidery_chest_left ->
  // chest_left, chest_left_dtf -> chest_left.
  const bare = key
    .replace(/^(embroidery|dtg|dtf|sublimation)_/, "")
    .replace(/_(dtfabric|dtfilm|dtf|dtg|sublimation|embroidery)$/, "");

  switch (bare) {
    case "front":
    case "default":
      return "front";
    case "back":
      return "back";
    case "chest_left":
    case "left_chest":
      return "left_chest";
    case "chest_right":
    case "right_chest":
      return "right_chest";
    case "sleeve_left":
    case "left":
      return "sleeve_left";
    case "sleeve_right":
    case "right":
      return "sleeve_right";
    case "label_inside":
    case "inside_label":
      return "neck_inner";
    case "label_outside":
    case "outside_label":
      return "neck_outer";
    default:
      return null;
  }
}

/** Our placement -> the `type` Printful expects on a sync variant file. */
function placementToFileType(code: PlacementCode): string {
  switch (code) {
    case "front":
      return "front";
    case "back":
      return "back";
    case "left_chest":
      return "embroidery_chest_left";
    case "right_chest":
      return "embroidery_chest_right";
    case "sleeve_left":
      return "sleeve_left";
    case "sleeve_right":
      return "sleeve_right";
    case "neck_inner":
      return "label_inside";
    case "neck_outer":
      return "label_outside";
  }
}

/**
 * Printful rate ids are strings like "STANDARD", "PRINTFUL_FAST", "EXPRESS".
 * Unknown ids fall back to standard — the slowest, cheapest promise we can keep.
 */
function mapShippingSpeed(rateId: string): ShippingSpeed {
  const id = rateId.toUpperCase();
  if (id.includes("EXPRESS") || id.includes("OVERNIGHT")) return "rush";
  if (id.includes("FAST") || id.includes("PRIORITY")) return "expedited";
  return "standard";
}

function shippingSpeedToService(speed: ShippingSpeed): string | undefined {
  switch (speed) {
    case "rush":
      return "EXPRESS";
    case "expedited":
      return "PRINTFUL_FAST";
    case "standard":
      return undefined; // omit → Printful's default
  }
}

function toRecipient(a: ShippingAddress) {
  return {
    name: a.name,
    address1: a.line1,
    address2: a.line2 ?? undefined,
    city: a.city,
    state_code: a.state ?? undefined,
    country_code: a.country,
    zip: a.postalCode,
    phone: a.phone ?? undefined,
    email: a.email ?? undefined,
  };
}

function toVendorOrder(o: PfOrder): VendorOrder {
  // Tracking lives on shipments. Take the most recent one that has a number.
  const shipment = [...(o.shipments ?? [])].reverse().find((s) => s.tracking_number);

  return {
    externalOrderId: String(o.id),
    status: mapPrintfulStatus(o.status),
    vendorCostCents: o.costs ? dollarsToCents(o.costs.total) : null,
    shippingCostCents: o.costs ? dollarsToCents(o.costs.shipping) : null,
    taxCents: o.costs
      ? dollarsToCents(o.costs.tax) + dollarsToCents(o.costs.vat ?? "0")
      : null,
    trackingNumber: shipment?.tracking_number ?? null,
    trackingUrl: shipment?.tracking_url ?? null,
    carrier: shipment?.carrier ?? null,
    estimatedDelivery: o.estimated_fulfillment
      ? new Date(o.estimated_fulfillment * 1000).toISOString().slice(0, 10)
      : null,
    rawStatus: o.status,
  };
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                      */
/* ------------------------------------------------------------------ */

/**
 * Perceived luminance (ITU-R BT.601). Used to block DTG on dark garments, which is
 * the single most common print-quality complaint across every POD vendor.
 * Unknown colour codes are treated as dark — the conservative direction, since a
 * false "dark" only costs a different print method.
 */
export function isDarkHex(hex: string | null | undefined): boolean {
  if (!hex) return true;
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return true;

  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 < 0.5;
}

function printfulMessage(parsed: unknown): string {
  if (parsed && typeof parsed === "object") {
    const e = parsed as { error?: { message?: string }; result?: unknown };
    if (e.error?.message) return e.error.message;
    if (typeof e.result === "string") return e.result;
  }
  return typeof parsed === "string" ? parsed.slice(0, 200) : "";
}

function backoffMs(attempt: number): number {
  // 1s, 2s, 4s with jitter, so parallel retries do not resonate.
  return (2 ** attempt) * 1000 + Math.floor(Math.random() * 250);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, Math.max(0, ms)));
}

/** Constant-time compare, so a secret cannot be recovered by timing the response. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hashPayload(body: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** 0 for a bare placement key, 1 for a technique-scoped one. Bare keys win. */
function affixCount(key: string): number {
  return /^(embroidery|dtg|dtf|sublimation)_|_(dtfabric|dtfilm|dtf|dtg|sublimation|embroidery)$/.test(key)
    ? 1
    : 0;
}

/** Bounded-concurrency map, so catalog hydration cannot blow the rate limit. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let cursor = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      out[i] = await fn(items[i]);
    }
  });

  await Promise.all(workers);
  return out;
}

/* ------------------------------------------------------------------ */
/* Printful wire types — private to this file.                        */
/* No shape below may appear anywhere else in the codebase.           */
/* ------------------------------------------------------------------ */

interface PfTechnique {
  key: string;
  display_name?: string;
  is_default?: boolean;
}

interface PfCatalogProduct {
  id: number;
  type_name?: string;
  title?: string;
  name?: string;
  type?: string;
  brand?: string | null;
  model?: string;
  image?: string;
  variant_count?: number;
  description?: string;
  is_discontinued?: boolean;
  techniques?: PfTechnique[];
}

interface PfVariant {
  id: number;
  product_id: number;
  name: string;
  size: string;
  // Null on all-over-print garments. The docs show it as a plain string, which is
  // why a non-null declaration here let a NOT NULL violation reach the database.
  color: string | null;
  color_code?: string;
  image?: string;
  price: string;
  in_stock?: boolean;
}

interface PfPrintfiles {
  product_id: number;
  available_placements?: Record<string, string>;
  printfiles?: Array<{
    printfile_id: number;
    width: number;
    height: number;
    dpi: number;
  }>;
  variant_printfiles?: Array<{
    variant_id: number;
    placements: Record<string, number>;
  }>;
}

interface PfFile {
  id: number;
  url?: string;
  status?: string;
  error?: string;
}

interface PfSyncProduct {
  id: number;
  external_id: string;
  name: string;
}

interface PfSyncVariant {
  id: number;
  external_id: string;
  variant_id: number;
}

interface PfShippingRate {
  id: string;
  name: string;
  rate: string;
  currency: string;
  minDeliveryDays?: number;
  maxDeliveryDays?: number;
}

interface PfCosts {
  subtotal: string;
  discount?: string;
  shipping: string;
  digitization?: string;
  tax: string;
  vat?: string;
  total: string;
}

interface PfOrder {
  id: number;
  external_id?: string;
  status: string;
  costs?: PfCosts;
  estimated_fulfillment?: number;
  shipments?: Array<{
    carrier?: string;
    service?: string;
    tracking_number?: string;
    tracking_url?: string;
  }>;
}

interface PfWebhook {
  type: string;
  created?: number;
  retries?: number;
  store?: number;
  data?: {
    order?: { id?: number; external_id?: string; status?: string };
  };
}
