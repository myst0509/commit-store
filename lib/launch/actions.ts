import { PLATFORM_FEE_CENTS } from "@/lib/pricing";
import { serviceClient } from "@/lib/supabase/client";

import {
  resolveSteps, STEP_BY_KEY, type StepKey, type StepState,
} from "./steps";

/**
 * Performing launch steps.
 *
 * Every step is an action with a side effect. The rules that make this safe:
 *
 *   - Prerequisites are checked here, server-side. A client claiming a step is
 *     complete proves nothing, which is why store_progress is select-only under
 *     RLS and all writes go through this module.
 *   - Each handler is idempotent. A double-clicked button must not create two
 *     stores, and a retried request must not order two samples.
 *   - A step is only marked complete if its action actually succeeded.
 */

export interface LaunchState {
  storeId: string | null;
  steps: StepState[];
  current: StepState | null;
  summary: { done: number; total: number; percent: number };
}

export async function getLaunchState(storeId: string): Promise<LaunchState> {
  const sb = serviceClient();

  const { data } = await sb
    .from("store_progress")
    .select("step_key, status, completed_at")
    .eq("store_id", storeId);

  const completed: Parameters<typeof resolveSteps>[0] = {};
  for (const r of data ?? []) {
    completed[r.step_key as StepKey] = {
      status: r.status as StepState["status"],
      completedAt: r.completed_at,
    };
  }

  const steps = resolveSteps(completed);
  return {
    storeId,
    steps,
    current: steps.find((s) => s.status === "available") ?? null,
    summary: {
      done: steps.filter((s) => s.status === "completed" || s.status === "skipped").length,
      total: steps.length,
      percent: Math.round(
        (steps.filter((s) => s.status === "completed" || s.status === "skipped").length /
          steps.length) * 100,
      ),
    },
  };
}

export class StepBlockedError extends Error {
  constructor(public stepKey: StepKey, public blockedBy: StepKey[]) {
    super(`Step "${stepKey}" is blocked by: ${blockedBy.join(", ")}`);
    this.name = "StepBlockedError";
  }
}

/* ------------------------------------------------------------------ */

type Handler = (storeId: string, input: Record<string, unknown>) => Promise<Record<string, unknown>>;

const HANDLERS: Record<string, Handler> = {
  /** Day 1. The store row itself is created before this by signup; this names it. */
  async create_store(storeId, input) {
    const name = String(input.name ?? "").trim();
    if (!name) throw new Error("A brand name is required");

    const sb = serviceClient();
    const subdomain = toSubdomain(name);

    // Collisions are the seller's problem to resolve, not something to paper over
    // by silently appending numbers to the brand they just chose.
    const { data: taken } = await sb
      .from("stores").select("id").eq("subdomain", subdomain).neq("id", storeId).maybeSingle();
    if (taken) throw new Error(`"${subdomain}" is already taken — try another name`);

    await sb.from("stores").update({ name, subdomain }).eq("id", storeId);
    return { name, subdomain };
  },

  /** Day 3. Artwork is uploaded to storage first; this records and validates it. */
  async upload_design(storeId, input) {
    const sb = serviceClient();
    const { storagePath, publicUrl, filename, widthPx, heightPx } = input as Record<string, string & number>;

    if (!publicUrl || !storagePath) throw new Error("Upload the file before recording it");

    // No unique constraint on (store_id, storage_path), so upsert cannot be used.
    // Checked explicitly instead, which keeps a double-clicked button from
    // creating two design rows for one file.
    const { data: existing } = await sb
      .from("designs").select("id")
      .eq("store_id", storeId).eq("storage_path", String(storagePath)).maybeSingle();

    if (existing) return { designId: existing.id, reviewStatus: "pending", reused: true };

    const { data, error } = await sb
      .from("designs")
      .insert({
        store_id: storeId,
        filename: String(filename ?? "design"),
        storage_path: String(storagePath),
        public_url: String(publicUrl),
        width_px: widthPx ? Number(widthPx) : null,
        height_px: heightPx ? Number(heightPx) : null,
        review_status: "pending",
      })
      .select("id")
      .single();

    if (error) throw error;
    return { designId: data.id, reviewStatus: "pending" };
  },

  /** Day 5. Records the chosen blank; the product itself is created at pricing. */
  async select_blank(_storeId, input) {
    const sb = serviceClient();
    const blankId = String(input.blankId ?? "");
    if (!blankId) throw new Error("Choose a blank");

    const { data, error } = await sb
      .from("catalog_blanks")
      .select("id, brand, model, is_enabled")
      .eq("id", blankId)
      .single();

    if (error || !data) throw new Error("That blank is not in the catalog");
    if (!data.is_enabled) throw new Error("That blank is not currently offered");

    return { blankId: data.id, blank: `${data.brand} ${data.model}`.trim() };
  },

  /**
   * Day 7. Creates the product and its variants at the seller's chosen price.
   *
   * This is where the platform fee is applied, and where a seller first sees what
   * they earn. The base/fee split is stored but never shown — see 0002.
   */
  async set_price(storeId, input) {
    const sb = serviceClient();
    const blankId = String(input.blankId ?? "");
    const designId = input.designId ? String(input.designId) : null;
    const retailCents = Number(input.retailPriceCents);
    const productName = String(input.name ?? "Untitled");

    if (!blankId) throw new Error("Choose a blank first");
    if (!Number.isInteger(retailCents) || retailCents <= 0) {
      throw new Error("Price must be a whole number of cents");
    }

    const { data: variants, error: vErr } = await sb
      .from("catalog_variants")
      .select("id, base_cost_cents, color, size")
      .eq("blank_id", blankId)
      .eq("in_stock", true);

    if (vErr || !variants?.length) throw new Error("That blank has no available variants");

    const cheapest = Math.min(...variants.map((v) => v.base_cost_cents));
    const unitCost = cheapest + PLATFORM_FEE_CENTS;
    if (retailCents < unitCost) {
      throw new Error(
        `At $${(retailCents / 100).toFixed(2)} you would lose money — ` +
        `this garment costs you $${(unitCost / 100).toFixed(2)}`,
      );
    }

    const { data: product, error: pErr } = await sb
      .from("products")
      .upsert({
        store_id: storeId, blank_id: blankId,
        name: productName, slug: toSlug(productName),
        decoration: "dtg", status: "draft",
      }, { onConflict: "store_id,slug" })
      .select("id")
      .single();
    if (pErr) throw pErr;

    const { error: pvErr } = await sb.from("product_variants").upsert(
      variants.map((v) => ({
        product_id: product.id,
        catalog_variant_id: v.id,
        retail_price_cents: retailCents,
        base_cost_cents: v.base_cost_cents,
        platform_fee_cents: PLATFORM_FEE_CENTS,
        is_enabled: true,
      })),
      { onConflict: "product_id,catalog_variant_id" },
    );
    if (pvErr) throw pvErr;

    if (designId) {
      await sb.from("product_artwork").upsert({
        product_id: product.id, design_id: designId,
        placement: "front", decoration: "dtg",
      }, { onConflict: "product_id,placement" });
    }

    return {
      productId: product.id,
      variantCount: variants.length,
      unitCostCents: unitCost,
      marginCents: retailCents - unitCost,
    };
  },

  /** Day 9. A sample is a real order the seller pays for; see the note below. */
  async order_sample(storeId, input) {
    void input;
    // Deliberately not implemented. A sample is a real vendor order with real
    // money attached, and PROJECT.md gates subsidised samples behind a first
    // sale with a per-account cap, a global budget and a kill switch — none of
    // which exist yet. Wiring a button to "spend money" before those do is how
    // a free-tier feature becomes an unbounded bill.
    throw new Error(
      "Sample ordering is not built yet: it needs the subsidy caps and kill " +
      "switch from PROJECT.md's cost discipline section, plus a payment method.",
    );
  },

  /** Day 12. Reservation-based drop; production triggers at the threshold. */
  async schedule_drop(storeId, input) {
    const sb = serviceClient();
    const productId = String(input.productId ?? "");
    const closesAt = String(input.closesAt ?? "");
    const threshold = input.thresholdUnits ? Number(input.thresholdUnits) : 25;

    if (!productId) throw new Error("Choose which product is dropping");
    if (!closesAt || Number.isNaN(Date.parse(closesAt))) {
      throw new Error("Pick a closing date");
    }
    if (Date.parse(closesAt) <= Date.now()) throw new Error("The closing date must be in the future");

    const { data: existing } = await sb
      .from("drops").select("id").eq("product_id", productId).eq("status", "open").maybeSingle();

    if (existing) {
      await sb.from("drops")
        .update({ closes_at: closesAt, threshold_units: threshold }).eq("id", existing.id);
      return { dropId: existing.id, thresholdUnits: threshold, closesAt };
    }

    const { data, error } = await sb
      .from("drops")
      .insert({
        store_id: storeId, product_id: productId,
        threshold_units: threshold, closes_at: closesAt, status: "open",
      })
      .select("id")
      .single();
    if (error) throw error;

    return { dropId: data.id, thresholdUnits: threshold, closesAt };
  },

  /** Day 14. The waitlist page goes live before the store itself does. */
  async publish_waitlist(storeId) {
    const sb = serviceClient();
    const { data } = await sb.from("stores").select("subdomain, theme").eq("id", storeId).single();

    await sb.from("stores")
      .update({ theme: { ...(data?.theme ?? {}), waitlistOpen: true } })
      .eq("id", storeId);

    return { waitlistUrl: `https://${data?.subdomain}.ourdomain.com` };
  },

  /** Day 21. Store goes public and the product goes on sale. */
  async publish_store(storeId) {
    const sb = serviceClient();

    const { data: products } = await sb
      .from("products").select("id").eq("store_id", storeId).eq("status", "draft");

    if (!products?.length) throw new Error("There is nothing to sell yet");

    await sb.from("products")
      .update({ status: "published" })
      .in("id", products.map((p) => p.id));

    await sb.from("stores").update({ status: "active" }).eq("id", storeId);

    const { data: store } = await sb.from("stores").select("subdomain").eq("id", storeId).single();
    return { live: true, url: `https://${store?.subdomain}.ourdomain.com`, published: products.length };
  },
};

/* ------------------------------------------------------------------ */

/**
 * Runs a step's action, then records completion.
 *
 * Order matters: the action runs first and progress is only written if it
 * succeeded. Marking a step done and then attempting the work would leave a
 * seller looking at a completed step that never happened.
 */
export async function performStep(
  storeId: string,
  stepKey: StepKey,
  input: Record<string, unknown> = {},
): Promise<{ step: StepKey; result: Record<string, unknown> }> {
  const def = STEP_BY_KEY[stepKey];
  if (!def) throw new Error(`Unknown step: ${stepKey}`);

  const state = await getLaunchState(storeId);
  const step = state.steps.find((s) => s.key === stepKey)!;

  if (step.status === "locked") throw new StepBlockedError(stepKey, step.blockedBy);

  const handler = HANDLERS[def.actionKey];
  if (!handler) throw new Error(`No handler for action "${def.actionKey}"`);

  const result = await handler(storeId, input);

  const sb = serviceClient();
  await sb.from("store_progress").upsert({
    store_id: storeId,
    step_key: stepKey,
    status: "completed",
    completed_at: new Date().toISOString(),
    result,
  }, { onConflict: "store_id,step_key" });

  return { step: stepKey, result };
}

/* ------------------------------------------------------------------ */

export function toSubdomain(name: string): string {
  const s = name.toLowerCase().normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
  if (s.length < 3) throw new Error("Brand name is too short for a web address");
  return s;
}

export function toSlug(name: string): string {
  return name.toLowerCase().normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "product";
}
