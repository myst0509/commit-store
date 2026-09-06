import { stripe } from "@/lib/stripe/client";
import { serviceClient } from "@/lib/supabase/client";

/**
 * Paying sellers what they are owed.
 *
 * This is the other half of holding funds. The ledger records what is owed and
 * when it becomes payable; this turns those entries into Stripe Transfers.
 *
 * The ordering here is the whole safety argument:
 *
 *   1. Read the payable entries.
 *   2. Create a payout row and CLAIM those entries by stamping payout_id.
 *   3. Only then create the Transfer.
 *
 * Claiming before transferring means a crash mid-run leaves money unsent, which
 * is recoverable. The reverse — transfer first, mark after — leaves money sent
 * and unrecorded, which pays twice on the next run and cannot be undone.
 */

/**
 * Below this, a payout costs more in reconciliation than it is worth, and small
 * frequent transfers make a seller's statement unreadable. Balances roll forward.
 */
const MINIMUM_PAYOUT_CENTS = 1000;

/**
 * Payouts run WEEKLY, on Friday at 09:00 UTC.
 *
 * This was daily, which was expensive in a way that is easy to miss. Stripe
 * Connect charges "$2 per monthly active account" plus "0.25% + 25c per payout
 * sent" — the 25c is per payout, not per month. Paying a seller every day costs
 * up to $7.50 a month in payout fees alone.
 *
 * That lands hardest on the smallest sellers, who are the ones this platform
 * exists for. Two shirts a month earns us $9.04; daily payouts could take a
 * quarter of it. Weekly cuts the same seller's payout fees to about $1.16 and
 * still pays them often enough to feel prompt.
 *
 * Friday so the money is moving before the weekend. Changing the day is
 * harmless; changing the frequency is a cost decision.
 */
export const PAYOUT_DAY_UTC = 5;
export const PAYOUT_HOUR_UTC = 9;

/**
 * Pure so the schedule can be tested without waiting a week.
 *
 * The scheduler calls the tick every ten minutes, so this is true several times
 * within the payout hour. That is safe: runPayouts claims ledger entries before
 * transferring, so a second pass in the same hour finds nothing left to pay.
 */
export function isPayoutWindow(now: Date): boolean {
  return now.getUTCDay() === PAYOUT_DAY_UTC && now.getUTCHours() === PAYOUT_HOUR_UTC;
}

export interface PayoutResult {
  storeId: string;
  amountCents: number;
  payoutId: string | null;
  transferId: string | null;
  status: "paid" | "skipped" | "failed";
  note: string;
}

export interface PayoutRun {
  examined: number;
  paidCents: number;
  results: PayoutResult[];
}

/** Stores with something payable right now. */
export async function findPayableStores(): Promise<Array<{
  storeId: string;
  payableCents: number;
  entryIds: string[];
}>> {
  const sb = serviceClient();
  const now = new Date().toISOString();

  const { data: entries } = await sb
    .from("ledger_entries")
    .select("id, store_id, amount_cents")
    .is("payout_id", null)
    .not("available_at", "is", null)
    .lte("available_at", now);

  const byStore = new Map<string, { payableCents: number; entryIds: string[] }>();

  for (const e of entries ?? []) {
    const current = byStore.get(e.store_id) ?? { payableCents: 0, entryIds: [] };
    current.payableCents += e.amount_cents;
    current.entryIds.push(e.id);
    byStore.set(e.store_id, current);
  }

  return [...byStore.entries()].map(([storeId, v]) => ({ storeId, ...v }));
}

export async function runPayouts(): Promise<PayoutRun> {
  const candidates = await findPayableStores();
  const results: PayoutResult[] = [];

  for (const candidate of candidates) {
    results.push(await payOneStore(candidate));
  }

  return {
    examined: results.length,
    paidCents: results.filter((r) => r.status === "paid").reduce((n, r) => n + r.amountCents, 0),
    results,
  };
}

async function payOneStore(candidate: {
  storeId: string; payableCents: number; entryIds: string[];
}): Promise<PayoutResult> {
  const sb = serviceClient();
  const base = { storeId: candidate.storeId, amountCents: candidate.payableCents, payoutId: null, transferId: null };

  const { data: store } = await sb
    .from("stores")
    .select("id, name, stripe_account_id, stripe_payouts_enabled, payouts_held")
    .eq("id", candidate.storeId)
    .single();

  if (!store) return { ...base, status: "skipped", note: "store not found" };

  // A negative or zero balance means clawbacks have caught up with earnings.
  // Nothing to send, and nothing to correct — it rolls forward.
  if (candidate.payableCents <= 0) {
    return { ...base, status: "skipped", note: "nothing payable" };
  }

  // The chargeback defence. PROJECT.md holds payouts by default and releases
  // them deliberately; a disputed store must not be paid on schedule.
  if (store.payouts_held) {
    return { ...base, status: "skipped", note: "payouts held on this store" };
  }

  if (!store.stripe_account_id) {
    return { ...base, status: "skipped", note: "seller has not connected a bank account" };
  }

  if (!store.stripe_payouts_enabled) {
    return { ...base, status: "skipped", note: "Stripe onboarding incomplete" };
  }

  if (candidate.payableCents < MINIMUM_PAYOUT_CENTS) {
    return {
      ...base, status: "skipped",
      note: `below the $${(MINIMUM_PAYOUT_CENTS / 100).toFixed(2)} minimum; rolling forward`,
    };
  }

  // Step 1: record the intent.
  const { data: payout, error: payoutErr } = await sb
    .from("payouts")
    .insert({
      store_id: store.id,
      amount_cents: candidate.payableCents,
      status: "scheduled",
      scheduled_for: new Date().toISOString(),
    })
    .select("id")
    .single();

  if (payoutErr || !payout) {
    return { ...base, status: "failed", note: `could not record payout: ${JSON.stringify(payoutErr)}` };
  }

  // Step 2: claim the entries. The `is null` filter is the concurrency guard —
  // if another run claimed them first, this updates nothing and we bail rather
  // than paying for entries we do not own.
  const { data: claimed, error: claimErr } = await sb
    .from("ledger_entries")
    .update({ payout_id: payout.id })
    .in("id", candidate.entryIds)
    .is("payout_id", null)
    .select("id, amount_cents");

  if (claimErr) {
    await sb.from("payouts").update({ status: "failed", failure_reason: "claim failed" }).eq("id", payout.id);
    return { ...base, payoutId: payout.id, status: "failed", note: `could not claim entries: ${JSON.stringify(claimErr)}` };
  }

  // Recompute from what was actually claimed. If a concurrent run took some,
  // we send what we hold rather than what we hoped to hold.
  const claimedCents = (claimed ?? []).reduce((n, e) => n + e.amount_cents, 0);

  if (claimedCents !== candidate.payableCents) {
    await sb.from("payouts").update({ amount_cents: Math.max(claimedCents, 0) }).eq("id", payout.id);
  }

  if (claimedCents < MINIMUM_PAYOUT_CENTS) {
    // Release and try again next run.
    await sb.from("ledger_entries").update({ payout_id: null }).eq("payout_id", payout.id);
    await sb.from("payouts").update({ status: "cancelled", failure_reason: "raced; below minimum after claim" }).eq("id", payout.id);
    return { ...base, payoutId: payout.id, status: "skipped", note: "raced with another run" };
  }

  // Step 3: move the money. Keyed on the payout id, so a retry after a timeout
  // reuses the same transfer instead of sending twice.
  try {
    const transfer = await stripe().transfers.create(
      {
        amount: claimedCents,
        currency: "usd",
        destination: store.stripe_account_id,
        description: `Payout for ${store.name}`,
        metadata: { store_id: store.id, payout_id: payout.id },
      },
      { idempotencyKey: `payout_${payout.id}` },
    );

    await sb.from("payouts").update({
      status: "paid",
      stripe_transfer_id: transfer.id,
      paid_at: new Date().toISOString(),
      amount_cents: claimedCents,
    }).eq("id", payout.id);

    // The negative side of the ledger: what was paid out.
    await sb.from("ledger_entries").insert({
      store_id: store.id,
      payout_id: payout.id,
      kind: "payout",
      amount_cents: -claimedCents,
      available_at: new Date().toISOString(),
      description: `Payout ${payout.id}`,
    });

    return {
      storeId: store.id, amountCents: claimedCents,
      payoutId: payout.id, transferId: transfer.id,
      status: "paid", note: `transferred to ${store.stripe_account_id}`,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);

    // Release the claim so the balance is payable again next run. Without this
    // a failed transfer would strand the seller's money permanently.
    await sb.from("ledger_entries").update({ payout_id: null }).eq("payout_id", payout.id);
    await sb.from("payouts")
      .update({ status: "failed", failure_reason: message.slice(0, 500) })
      .eq("id", payout.id);

    return {
      ...base, payoutId: payout.id, status: "failed",
      note: `transfer failed, entries released: ${message}`,
    };
  }
}
