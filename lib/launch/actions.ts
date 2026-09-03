import {
  inspectArtwork, validateAgainstPlacement, type PlacementSpec,
} from "@/lib/design/validate";
import { UserError } from "@/lib/errors";
import { PLATFORM_FEE_CENTS } from "@/lib/pricing";
import { createProductFromBlank } from "@/lib/products/create";
// Re-exported: the definition lives with the code that uses it, and two copies
// of a slug rule would drift the first time one was "improved".
export { toSlug } from "@/lib/products/create";
import { serviceClient } from "@/lib/supabase/client";

/** A standard adult front print. Used before a blank has been chosen. */
const REFERENCE_FRONT: PlacementSpec = {
  code: "front", widthIn: 12, heightIn: 16, minDpi: 150,
};

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
    if (!name) throw new UserError("A brand name is required");

    const sb = serviceClient();
    const subdomain = toSubdomain(name);

    // Collisions are the seller's problem to resolve, not something to paper over
    // by silently appending numbers to the brand they just chose.
    const { data: taken } = await sb
      .from("stores").select("id").eq("subdomain", subdomain).neq("id", storeId).maybeSingle();
    if (taken) throw new UserError(`"${subdomain}" is already taken — try another name`);

    await sb.from("stores").update({ name, subdomain }).eq("id", storeId);
    return { name, subdomain };
  },

  /** Day 3. Artwork is uploaded to storage first; this records and validates it. */
  async upload_design(storeId, input) {
    const sb = serviceClient();
    const { storagePath, publicUrl, filename, widthPx, heightPx } = input as Record<string, string & number>;

    if (!publicUrl || !storagePath) throw new UserError("Upload the file before recording it");

    // Inspect the real bytes rather than trusting whatever the client reported.
    // A blank has not been chosen yet at this point in the sequence, so this
    // checks against a standard front print (12″ × 16″ at 150 DPI) — enough to
    // catch artwork that is unusable everywhere. Exact per-placement checks
    // happen once a blank is picked.
    let facts;
    try {
      const res = await fetch(String(publicUrl));
      if (!res.ok) throw new UserError(`could not read the uploaded file (HTTP ${res.status})`);
      facts = await inspectArtwork(Buffer.from(await res.arrayBuffer()));
    } catch (e) {
      throw new UserError(`Could not read that image: ${e instanceof Error ? e.message : e}`);
    }

    const check = validateAgainstPlacement(facts, REFERENCE_FRONT);
    const blocking = check.findings.filter((f) => f.code === "far_too_small");
    if (blocking.length) throw new UserError(blocking[0].message);

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
        // Measured, not reported. widthPx/heightPx from the client are ignored.
        width_px: facts.widthPx,
        height_px: facts.heightPx,
        byte_size: facts.byteSize,
        review_status: "pending",
      })
      .select("id")
      .single();

    if (error) throw error;

    return {
      designId: data.id,
      reviewStatus: "pending",
      dimensions: `${facts.widthPx}×${facts.heightPx}`,
      maxPrintSize: `${check.maxPrintInches.width}″ × ${check.maxPrintInches.height}″`,
      warnings: check.findings.filter((f) => f.severity === "warning").map((f) => f.message),
    };
  },

  /** Day 5. Records the chosen blank; the product itself is created at pricing. */
  async select_blank(_storeId, input) {
    const sb = serviceClient();
    const blankId = String(input.blankId ?? "");
    if (!blankId) throw new UserError("Choose a blank");

    const { data, error } = await sb
      .from("catalog_blanks")
      .select("id, brand, model, is_enabled")
      .eq("id", blankId)
      .single();

    if (error || !data) throw new UserError("That blank is not in the catalog");
    if (!data.is_enabled) throw new UserError("That blank is not currently offered");

    return { blankId: data.id, blank: `${data.brand} ${data.model}`.trim() };
  },

  /**
   * Day 7. Creates the product and its variants at the seller's chosen price.
   *
   * This is where the platform fee is applied, and where a seller first sees what
   * they earn. The base/fee split is stored but never shown — see 0002.
   */
  async set_price(storeId, input) {
    // Shared with POST /api/products, so the price floor and the variant
    // fan-out cannot differ between a seller's first product and their fifth.
    const created = await createProductFromBlank({
      storeId,
      blankId: String(input.blankId ?? ""),
      name: String(input.name ?? "Untitled"),
      retailPriceCents: Number(input.retailPriceCents),
      designId: input.designId ? String(input.designId) : null,
    });

    return {
      productId: created.productId,
      variantCount: created.variantCount,
      unitCostCents: created.unitCostCents,
      marginCents: created.marginCents,
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
    throw new UserError(
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

    if (!productId) throw new UserError("Choose which product is dropping");
    if (!closesAt || Number.isNaN(Date.parse(closesAt))) {
      throw new UserError("Pick a closing date");
    }
    if (Date.parse(closesAt) <= Date.now()) throw new UserError("The closing date must be in the future");

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

    if (!products?.length) throw new UserError("There is nothing to sell yet");

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
  if (s.length < 3) throw new UserError("Brand name is too short for a web address");
  return s;
}


