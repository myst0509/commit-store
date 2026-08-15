/**
 * Compares pricing models against real vendor numbers.
 *
 *   npx tsx scripts/pricing-model.ts
 *   npx tsx scripts/pricing-model.ts --cost=1800 --retail=32
 *
 * Exists because per-order margin is not obvious by inspection: Stripe charges a
 * percentage of the whole transaction including shipping, so who absorbs that
 * fee changes how the platform's margin behaves as sellers raise their prices.
 */

import { computeEconomics, stripeFee } from "../lib/pricing";
import { args } from "./_env";

const a = args();

/** Live Printful figures for a Bella + Canvas 3001 shipped within the US. */
const BLANK_CENTS = 1169;
const SHIP_CENTS = 475;
const TAX_CENTS = 42;

const sellerCost = Number(a.get("cost") ?? 1800);
const usd = (c: number) => `${c < 0 ? "-" : ""}$${Math.floor(Math.abs(c) / 100)}.${String(Math.abs(c) % 100).padStart(2, "0")}`;
const pad = (s: string, n: number) => s.padStart(n);

function run(retailCents: number, absorbStripe: boolean, taxCents: number) {
  // Seller cost is blank + tax + our fee, so the fee is what is left over.
  const feeCents = sellerCost - BLANK_CENTS - taxCents;

  const e = computeEconomics({
    itemsRetailCents: retailCents,
    shippingChargedCents: SHIP_CENTS,
    vendorItemsCents: BLANK_CENTS,
    vendorShippingCents: SHIP_CENTS,
    vendorTaxCents: taxCents,
    platformFeeCents: feeCents,
    sellerUnitCostCents: sellerCost,
    passCardFeesToCustomer: !absorbStripe,
  });

  return { ...e, feeCents, sellerProfit: retailCents - sellerCost };
}

console.log(`Blank ${usd(BLANK_CENTS)}  ·  shipping ${usd(SHIP_CENTS)}  ·  vendor tax ${usd(TAX_CENTS)}`);
console.log(`Seller's unit cost set to ${usd(sellerCost)}\n`);

for (const [label, absorb, tax] of [
  ["A. We absorb Stripe (your proposal)", true, TAX_CENTS],
  ["B. We absorb Stripe, resale certificate on file", true, 0],
  ["C. Customer pays a service fee", false, TAX_CENTS],
] as Array<[string, boolean, number]>) {
  console.log(label);
  console.log("   seller sets   they earn   customer pays   Stripe takes   we keep");

  for (const retail of [1800, 2400, 3200, 4500, 6000, 10000]) {
    const r = run(retail, absorb, tax);
    console.log(
      `   ${pad(usd(retail), 11)}   ${pad(usd(r.sellerProfit), 9)}   ` +
      `${pad(usd(r.customerPaysCents), 13)}   ${pad(usd(r.stripeFeeCents), 12)}   ` +
      `${pad(usd(r.platformNetCents), 7)}`,
    );
  }

  const low = run(1800, absorb, tax).platformNetCents;
  const high = run(10000, absorb, tax).platformNetCents;
  const direction = high === low ? "flat" : high > low ? "rises" : "FALLS";
  console.log(`   -> our margin ${direction} as sellers price higher ` +
    `(${usd(low)} at $18 -> ${usd(high)} at $100)\n`);
}

console.log("Your stated example, checked:");
const check = run(3200, true, TAX_CENTS);
console.log(`   seller cost ${usd(sellerCost)}, retail ${usd(3200)}`);
console.log(`   seller earns        ${usd(check.sellerProfit)}`);
console.log(`   our gross markup    ${usd(check.feeCents)}   (${usd(sellerCost)} - ${usd(BLANK_CENTS)} - ${usd(TAX_CENTS)} tax)`);
console.log(`   less Stripe         ${usd(-check.stripeFeeCents)}   (2.9% of ${usd(check.customerPaysCents)} + 30c)`);
console.log(`   we actually keep    ${usd(check.platformNetCents)}`);
console.log(`\n   Stripe alone on this order: ${usd(stripeFee(check.customerPaysCents))}`);
