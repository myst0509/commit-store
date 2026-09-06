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

/**
 * Platform-wide, settled 2026-08-11: we absorb card processing rather than
 * adding a service fee line at checkout. Checkout stays a clean two lines —
 * goods and shipping — which for a brand nobody has heard of is worth more than
 * the ~95c per order the fee would recover.
 *
 * The cost of this choice: our margin declines as sellers price higher, because
 * Stripe's percentage grows with the order while our fee is flat. Across the
 * realistic $25-40 band that is about 60c. It matters if sellers start moving
 * $80 hoodies, at which point volume pricing with Stripe is the answer.
 *
 * Flip to true to pass it on — every consumer of computeEconomics reads this,
 * so the change is one line. `npm run pricing:model` shows both.
 */
export const PASS_CARD_FEES_TO_CUSTOMER = false;

/**
 * Our flat per-unit fee. PROJECT.md: a flat amount (~$4–6), never a percentage.
 *
 * Lowered from 631 to 500 on 2026-08-19, for two reasons.
 *
 * 631 sat above the $4–6 band PROJECT.md specifies. It had been reverse-derived
 * so the reference blank, a Bella + Canvas 3001 at $11.69, landed on a seller
 * cost of exactly $18.00 — a tidy anchor, but the anchor was chosen and the fee
 * followed, rather than the other way round.
 *
 * More importantly a flat fee is regressive, and 631 made that bite. Measured
 * across the twelve enabled blanks it was 68% on the cheapest ($9.25 Gildan
 * 5000) and 33% on the dearest ($18.95 AS Colour 5001). The sellers with least
 * money to start with were paying the highest markup, which is backwards for a
 * platform aimed at people with no money and no audience. At 500 the same
 * spread is 54% to 26%.
 *
 * This is stored per variant in product_variants.platform_fee_cents, so
 * existing products keep the fee they were created with and only new ones move.
 * Changing it changes every future seller's unit cost, so it is a business
 * decision rather than a tuning knob.
 */
export const PLATFORM_FEE_CENTS = 500;

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
  /**
   * What the seller was told a unit costs them, already multiplied by quantity.
   *
   * Supply this whenever the seller-facing cost includes anything beyond
   * `vendorItems + fee` — vendor tax, for instance. Margin is then
   * `retail − sellerUnitCost`, which is what the seller was shown, so the number
   * on their dashboard and the number credited to their ledger cannot diverge.
   *
   * Omit it and margin falls back to `retail − vendorItems − fee`.
   */
  sellerUnitCostCents?: number;
  /**
   * When true, a service fee line is added so the customer covers card
   * processing and we keep the full platform fee.
   *
   * NOTE: this must be a uniform service fee applied to every order regardless
   * of payment method — not a card surcharge. Several US states restrict
   * surcharging, and the card networks prohibit surcharging debit entirely.
   */
  passCardFeesToCustomer?: boolean;
}

export interface Economics {
  /** What the customer's card is charged, service fee included. */
  customerPaysCents: number;
  /** Goods plus shipping, before any service fee. */
  subtotalCents: number;
  /** The service fee line. Zero unless passCardFeesToCustomer is set. */
  serviceFeeCents: number;
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
 * The amount to charge so that, after Stripe takes its cut, exactly
 * `targetNetCents` lands.
 *
 * Not simply `target + fee`: Stripe's percentage applies to the whole charge
 * including the part added to cover Stripe, so the fee grows with the amount.
 * Solving charge − (charge × rate + fixed) = target gives:
 *
 *     charge = (target + fixed) / (1 − rate)
 *
 * Rounded UP. Rounding down would leave us a cent short on some orders, and
 * being a cent short on every order is a slow leak nobody notices.
 */
export function grossUpForStripe(targetNetCents: number): number {
  if (targetNetCents <= 0) return 0;
  const numerator = (targetNetCents + STRIPE_FIXED_CENTS) * 10_000;
  const denominator = 10_000 - STRIPE_PERCENT_BPS;
  return Math.ceil(numerator / denominator);
}

/**
 * Seller-visible unit cost. The split behind it is never shown — see 0002.
 */
export function sellerUnitCost(vendorBaseCents: number, feeCents: number): number {
  return vendorBaseCents + feeCents;
}

export function computeEconomics(input: EconomicsInput): Economics {
  const vendorTotalCents =
    input.vendorItemsCents + input.vendorShippingCents + input.vendorTaxCents;

  // The seller's margin is on the goods only. Shipping is not theirs to profit
  // from, and not theirs to lose on either.
  //
  // Derived from the cost they were quoted when one is given. A seller shown
  // "$18.00 per unit" must earn exactly retail − $18.00; computing it from parts
  // instead lets the displayed figure drift from the credited one.
  const sellerMarginCents =
    input.sellerUnitCostCents !== undefined
      ? input.itemsRetailCents - input.sellerUnitCostCents
      : input.itemsRetailCents - input.vendorItemsCents - input.platformFeeCents;

  const subtotalCents = input.itemsRetailCents + input.shippingChargedCents;

  let customerPaysCents = subtotalCents;
  let serviceFeeCents = 0;

  if (input.passCardFeesToCustomer) {
    // Everything that has to leave our account, plus the fee we intend to keep.
    const requiredNet = vendorTotalCents + sellerMarginCents + input.platformFeeCents;
    customerPaysCents = grossUpForStripe(requiredNet);
    serviceFeeCents = customerPaysCents - subtotalCents;
  }

  const stripeFeeCents = stripeFee(customerPaysCents);

  const platformNetCents =
    customerPaysCents - vendorTotalCents - sellerMarginCents - stripeFeeCents;

  return {
    customerPaysCents,
    subtotalCents,
    serviceFeeCents,
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
