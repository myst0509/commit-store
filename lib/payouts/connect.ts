import { stripe } from "@/lib/stripe/client";
import { serviceClient } from "@/lib/supabase/client";

/**
 * Stripe Connect Express onboarding.
 *
 * Express accounts, not Standard: sellers here are first-time brand owners, and
 * Stripe hosts the identity and bank-details flow so we never touch either. We
 * are not equipped to collect a stranger's SSN, and should not be.
 *
 * The account exists only to RECEIVE money. Customers always pay our platform
 * account — see the separate-charges-and-transfers note in lib/stripe/client.ts.
 * A connected account with no charge capability is exactly what we want.
 */

export interface ConnectStatus {
  accountId: string | null;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
  /** What Stripe still wants before it will pay out. Shown to the seller. */
  requirements: string[];
  disabledReason: string | null;
}

/**
 * Creates the seller's connected account if they do not have one.
 *
 * Idempotent on the store: a second call returns the existing account rather
 * than creating a duplicate, because a store with two Stripe accounts is a
 * reconciliation problem nobody wants.
 */
export async function ensureConnectAccount(storeId: string): Promise<string> {
  const sb = serviceClient();

  const { data: store, error } = await sb
    .from("stores")
    .select("id, name, stripe_account_id, owner_id")
    .eq("id", storeId)
    .single();

  if (error || !store) throw new Error(`Store ${storeId} not found`);
  if (store.stripe_account_id) return store.stripe_account_id;

  const { data: owner } = await sb.auth.admin.getUserById(store.owner_id);

  const account = await stripe().accounts.create(
    {
      type: "express",
      email: owner?.user?.email ?? undefined,
      business_profile: {
        name: store.name,
        product_description: "Independent clothing brand",
      },
      capabilities: {
        // Transfers only. We do not want this account processing charges —
        // every payment belongs to the platform account.
        transfers: { requested: true },
      },
      metadata: { store_id: storeId },
    },
    { idempotencyKey: `connect_${storeId}` },
  );

  await sb.from("stores").update({ stripe_account_id: account.id }).eq("id", storeId);

  return account.id;
}

/**
 * A one-time link into Stripe's hosted onboarding.
 *
 * Deliberately short-lived and single-use — that is Stripe's design, not a
 * limitation. Generate one when the seller clicks, never store it.
 */
export async function createOnboardingLink(
  storeId: string,
  urls: { refreshUrl: string; returnUrl: string },
): Promise<string> {
  const accountId = await ensureConnectAccount(storeId);

  const link = await stripe().accountLinks.create({
    account: accountId,
    type: "account_onboarding",
    refresh_url: urls.refreshUrl,
    return_url: urls.returnUrl,
  });

  return link.url;
}

/**
 * Reads the truth from Stripe and records it.
 *
 * `payouts_enabled` is Stripe's answer, never ours to infer. A seller who
 * abandoned onboarding halfway looks complete from our side and is not.
 */
export async function syncConnectStatus(storeId: string): Promise<ConnectStatus> {
  const sb = serviceClient();

  const { data: store } = await sb
    .from("stores").select("stripe_account_id").eq("id", storeId).single();

  if (!store?.stripe_account_id) {
    return {
      accountId: null, payoutsEnabled: false, detailsSubmitted: false,
      requirements: [], disabledReason: null,
    };
  }

  const account = await stripe().accounts.retrieve(store.stripe_account_id);

  const status: ConnectStatus = {
    accountId: account.id,
    payoutsEnabled: account.payouts_enabled ?? false,
    detailsSubmitted: account.details_submitted ?? false,
    requirements: [
      ...(account.requirements?.currently_due ?? []),
      ...(account.requirements?.past_due ?? []),
    ],
    disabledReason: account.requirements?.disabled_reason ?? null,
  };

  await sb.from("stores")
    .update({ stripe_payouts_enabled: status.payoutsEnabled })
    .eq("id", storeId);

  return status;
}
