/**
 * The single place order economics are computed. Every number is integer cents.
 *
 * The model, settled 2026-08-11:
 *
 *   - The end customer pays the seller's retail price PLUS shipping. Shipping is
 *     a separate line, quoted live from the vendor, and passed straight through.
 *     We neither profit from it nor subsidise it.
 *   - The seller's unit cost is vendor base + our flat fee. They see one number.
 *     They set retail freely; their margin is retail minus that cost.
 *   - We keep the fee, minus the costs of collecting it.
 *
 * That last clause is the part that is easy to forget. Gross fee is not net
 * revenue: Stripe takes a cut of every payment we process, and the vendor may
 * charge us sales tax on the wholesale purchase. Both come out of our side, not
 * the seller's.
 */

/** US card rate. 2.9% + 30¢. Both integers; no float touches money. */
const STRIPE_PERCENT_BPS = 290; // basis points of a basis point: 2.90%
const STRIPE_FIXED_CENTS = 30;

export interface EconomicsInput {
  /** Seller's retail price for the goods, excluding shipping. */
  itemsRetailCents: number;
  /** Shipping charged to the customer. Normally equals vendorShippingCents. */
  shippingChargedCents: number;
  /** What the vendor charges us for the goods. */
  vendorItemsCents: number;
  /** What the vendor charges us to ship. */
  vendorShippingCents: number;
  /** Sales tax the vendor charges us. Zero if we hold a resale certificate. */
  vendorTaxCents: number;
  /** Our flat per-unit fee, already multiplied by quantity. */
  platformFeeCents: number;
}

export interface Economics {
  /** What the customer's card is charged. */
  customerPaysCents: number;
  /** Total vendor invoice. */
  vendorTotalCents: number;
  /** Owed to the seller, net 14 after delivery. */
  sellerMarginCents: number;
  /** Payment processing, deducted before anything reaches us. */
  stripeFeeCents: number;
  /** What we actually keep. Can be negative — check it. */
  platformNetCents: number;
  /** Fee before the costs of collecting it, for comparison. */
  platformGrossFeeCents: number;
}

export function stripeFee(grossCents: number): number {
  if (grossCents <= 0) return 0;
  return Math.round((grossCents * STRIPE_PERCENT_BPS) / 10_000) + STRIPE_FIXED_CENTS;
}

/**
 * Seller-visible unit cost. The split behind it is never shown — see 0002.
 */
export function sellerUnitCost(vendorBaseCents: number, feeCents: number): number {
  return vendorBaseCents + feeCents;
}

export function computeEconomics(input: EconomicsInput): Economics {
  const customerPaysCents = input.itemsRetailCents + input.shippingChargedCents;
  const vendorTotalCents =
    input.vendorItemsCents + input.vendorShippingCents + input.vendorTaxCents;

  // The seller's margin is on the goods only. Shipping is not theirs to profit
  // from, and not theirs to lose on either.
  const sellerMarginCents =
    input.itemsRetailCents - input.vendorItemsCents - input.platformFeeCents;

  const stripeFeeCents = stripeFee(customerPaysCents);

  const platformNetCents =
    customerPaysCents - vendorTotalCents - sellerMarginCents - stripeFeeCents;

  return {
    customerPaysCents,
    vendorTotalCents,
    sellerMarginCents,
    stripeFeeCents,
    platformNetCents,
    platformGrossFeeCents: input.platformFeeCents,
  };
}

/**
 * The fee needed for a target net, at a given order value.
 *
 * Useful for sanity-checking a fee before committing to it: a flat fee that looks
 * healthy on a $40 order can be nearly consumed by Stripe's 30¢ floor on a $15
 * one.
 */
export function feeForTargetNet(
  targetNetCents: number,
  input: Omit<EconomicsInput, "platformFeeCents">,
): number {
  const withoutFee = computeEconomics({ ...input, platformFeeCents: 0 });
  return targetNetCents - withoutFee.platformNetCents;
}
