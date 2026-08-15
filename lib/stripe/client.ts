import Stripe from "stripe";

/**
 * Stripe, server-only.
 *
 * PROJECT.md commits to Connect Express with **separate charges and transfers**,
 * not destination charges. The distinction is load-bearing: a destination charge
 * moves money to the seller at the moment the customer pays, and we need to hold
 * it until the garment is delivered and the net-14 window closes. A chargeback
 * has to be recoverable, and it cannot be if the money already left.
 *
 * So: charge on our own account with no transfer_data, then create a Transfer to
 * the seller's connected account when a payout is actually due.
 */

let cached: Stripe | null = null;

export function stripe(): Stripe {
  if (typeof window !== "undefined") {
    throw new Error("stripe() called in the browser — the secret key is server-only");
  }
  if (cached) return cached;

  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY is not set");

  cached = new Stripe(key, {
    // Pinned to the version this SDK was built against. Stripe changes response
    // shapes between versions, and an unpinned integration breaks on their
    // schedule rather than ours. Bump deliberately, alongside the SDK.
    apiVersion: "2026-07-29.dahlia",
    typescript: true,
    appInfo: { name: "Commit", version: "0.1.0" },
  });

  return cached;
}

/** True when we are pointed at test keys. Guards anything that moves real money. */
export function isTestMode(): boolean {
  return (process.env.STRIPE_SECRET_KEY ?? "").startsWith("sk_test_");
}

export function requireWebhookSecret(): string {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new Error("STRIPE_WEBHOOK_SECRET is not set");
  return secret;
}
