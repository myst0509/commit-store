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
  | "sample" | "drop_date" | "waitlist" | "launch";

export type StepStatus = "locked" | "available" | "completed" | "skipped";

export interface StepDefinition {
  key: StepKey;
  dayIndex: number;
  /** What the button says. Imperative — it describes what will happen. */
  title: string;
  /** Dispatch target in ./actions. */
  actionKey: string;
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
export const STEPS: StepDefinition[] = [
  {
    key: "name", dayIndex: 1, title: "Name your brand",
    actionKey: "create_store", requires: [],
    outcome: "Creates your storefront at yourname.ourdomain.com",
  },
  {
    key: "design", dayIndex: 3, title: "Upload your first design",
    actionKey: "upload_design", requires: ["name"],
    outcome: "Checks your artwork is high enough resolution to print",
  },
  {
    key: "blank", dayIndex: 5, title: "Choose your blank",
    actionKey: "select_blank", requires: ["design"],
    outcome: "Picks the garment your design gets printed on",
  },
  {
    key: "price", dayIndex: 7, title: "Set your price",
    actionKey: "set_price", requires: ["blank"],
    outcome: "Creates your product and shows what you earn per sale",
  },
  {
    key: "sample", dayIndex: 9, title: "Order your sample",
    actionKey: "order_sample", requires: ["price"],
    outcome: "Sends one unit to you, so you see it before anyone buys",
  },
  {
    key: "drop_date", dayIndex: 12, title: "Pick your drop date",
    actionKey: "schedule_drop", requires: ["sample"],
    outcome: "Sets the day your product goes on sale",
  },
  {
    key: "waitlist", dayIndex: 14, title: "Open your waitlist",
    actionKey: "publish_waitlist", requires: ["drop_date"],
    outcome: "Puts a signup page live so people can be told when you launch",
  },
  {
    key: "launch", dayIndex: 21, title: "Launch",
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
