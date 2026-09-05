/**
 * The guided launch sequence.
 *
 * PROJECT.md is emphatic that this is the product, not onboarding polish, and
 * that every step is a BUTTON THAT PERFORMS AN ACTION — never advice text. So a
 * step is defined by the action it dispatches, and there is deliberately nowhere
 * to put a paragraph of encouragement.
 *
 * This module is pure. Unlock logic has no database access so it can be tested
 * directly and reasoned about without a running Supabase. The handlers that
 * actually do things live in ./actions.
 */

export type StepKey =
  | "name" | "design" | "blank" | "price"
  | "style" | "story" | "socials" | "sample"
  | "bank" | "drop_date" | "waitlist" | "launch";

export type StepStatus = "locked" | "available" | "completed" | "skipped";

/** Three phases: make something, build the store around it, then sell it. */
export type StepPhase = "make" | "build" | "sell";

export const PHASES: Array<{ key: StepPhase; title: string; blurb: string }> = [
  { key: "make",  title: "Make something", blurb: "A design on a real garment, priced so you earn on every sale" },
  { key: "build", title: "Build your store", blurb: "Make it look like yours and tell people who you are" },
  { key: "sell",  title: "Start selling", blurb: "Set a date, gather people, open the doors" },
];

export interface StepDefinition {
  key: StepKey;
  dayIndex: number;
  /** What the button says. Imperative — it describes what will happen. */
  title: string;
  /** Dispatch target in ./actions. */
  actionKey: string;
  /** Grouping for display. Unlocking still comes from `requires`. */
  phase: StepPhase;
  /**
   * Can a seller move past this without doing it?
   *
   * Only `sample` is, and deliberately: order_sample is not built, because a
   * sample is a real vendor order and PROJECT.md gates subsidised samples
   * behind caps and a kill switch that do not exist. Without a way past it,
   * drop_date requires sample and the whole back half of the path is
   * unreachable — nobody could ever finish, or open a store.
   */
  optional?: boolean;
  /** Must be completed before this unlocks. */
  requires: StepKey[];
  /** Shown under the button. States the outcome, not advice. */
  outcome: string;
}

/**
 * The eight steps PROJECT.md names. Day numbers are placeholders — the full
 * 21-day sequence is still undefined, and inventing the other thirteen would be
 * making product decisions in a code file.
 */
/**
 * The guide, in three phases.
 *
 * Reshaped 2026-08-19. It used to be a single run at launching a drop, which
 * left a seller with a live store that was a bare product grid. It now also
 * covers building the store itself, because "make a thing" and "have a brand"
 * are not the same job.
 *
 * Every step performs an action, per PROJECT.md. None of them are advice.
 *
 * `phase` groups them for display only; ordering and unlocking still come from
 * `requires`. Day numbers are spread across the 21 days PROJECT.md describes.
 */
export const STEPS: StepDefinition[] = [
  /* ---- Phase 1: make something ---- */
  {
    key: "name", dayIndex: 1, phase: "make", title: "Name your brand",
    actionKey: "create_store", requires: [],
    outcome: "Creates your storefront at yourname.ourdomain.com",
  },
  {
    key: "design", dayIndex: 3, phase: "make", title: "Upload your first design",
    actionKey: "upload_design", requires: ["name"],
    outcome: "Checks your artwork is high enough resolution to print",
  },
  {
    key: "blank", dayIndex: 5, phase: "make", title: "Choose your garment",
    actionKey: "select_blank", requires: ["design"],
    outcome: "Picks the garment your design gets printed on",
  },
  {
    key: "price", dayIndex: 7, phase: "make", title: "Set your price",
    actionKey: "set_price", requires: ["blank"],
    outcome: "Creates your product and shows what you earn per sale",
  },

  /* ---- Phase 2: build the store ---- */
  {
    key: "style", dayIndex: 9, phase: "build", title: "Style your store",
    actionKey: "set_theme", requires: ["price"],
    outcome: "Sets the colours your storefront uses",
  },
  {
    key: "story", dayIndex: 10, phase: "build", title: "Say who you are",
    actionKey: "set_story", requires: ["price"],
    outcome: "Adds an introduction to your storefront",
  },
  {
    key: "socials", dayIndex: 11, phase: "build", title: "Add your links",
    actionKey: "set_socials", requires: ["price"],
    outcome: "Shows people where else to find you",
  },
  {
    // Not built, and skippable so it cannot wall off the rest of the path.
    key: "sample", dayIndex: 12, phase: "build", title: "Order your sample",
    actionKey: "order_sample", requires: ["price"], optional: true,
    outcome: "Sends one unit to you, so you see it before anyone buys",
  },

  /* ---- Phase 3: get ready to sell ---- */
  {
    // Optional: a seller can open a store without a bank attached. Earnings
    // simply wait, which is better than blocking a launch on Stripe.
    key: "bank", dayIndex: 14, phase: "sell", title: "Connect your bank",
    actionKey: "connect_bank", requires: ["price"], optional: true,
    outcome: "Sets up where your earnings get paid out",
  },
  {
    key: "drop_date", dayIndex: 16, phase: "sell", title: "Pick your drop date",
    actionKey: "schedule_drop", requires: ["style", "story", "socials"],
    outcome: "Sets the day your product goes on sale",
  },
  {
    key: "waitlist", dayIndex: 18, phase: "sell", title: "Open your waitlist",
    actionKey: "publish_waitlist", requires: ["drop_date"],
    outcome: "Puts a signup page live so people can be told when you launch",
  },
  {
    key: "launch", dayIndex: 21, phase: "sell", title: "Launch",
    actionKey: "publish_store", requires: ["waitlist"],
    outcome: "Makes your storefront public and opens orders",
  },
];

export const STEP_BY_KEY: Record<StepKey, StepDefinition> = Object.fromEntries(
  STEPS.map((s) => [s.key, s]),
) as Record<StepKey, StepDefinition>;

export interface StepState extends StepDefinition {
  status: StepStatus;
  completedAt: string | null;
  /** Which prerequisites are still outstanding. Empty unless locked. */
  blockedBy: StepKey[];
}

/**
 * Resolves every step against what a store has already done.
 *
 * A step is available when all of its prerequisites are complete. Skipping is
 * honoured as completion — a seller who already has a design should not be
 * forced to re-upload one to get past day three.
 */
export function resolveSteps(
  completed: Partial<Record<StepKey, { status: StepStatus; completedAt: string | null }>>,
): StepState[] {
  const isDone = (k: StepKey) => {
    const s = completed[k]?.status;
    return s === "completed" || s === "skipped";
  };

  return STEPS.map((def) => {
    const existing = completed[def.key];

    if (existing && (existing.status === "completed" || existing.status === "skipped")) {
      return { ...def, status: existing.status, completedAt: existing.completedAt, blockedBy: [] };
    }

    const blockedBy = def.requires.filter((r) => !isDone(r));

    return {
      ...def,
      status: blockedBy.length === 0 ? "available" : "locked",
      completedAt: null,
      blockedBy,
    };
  });
}

/** The step a seller should be looking at: the first one they can actually do. */
export function currentStep(states: StepState[]): StepState | null {
  return states.find((s) => s.status === "available") ?? null;
}

export function progressSummary(states: StepState[]) {
  const done = states.filter((s) => s.status === "completed" || s.status === "skipped").length;
  return { done, total: states.length, percent: Math.round((done / states.length) * 100) };
}
