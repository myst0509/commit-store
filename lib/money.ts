/**
 * Money is integer cents everywhere. These helpers exist so that displaying a
 * price never becomes an excuse to divide by 100 into a float and lose a penny
 * somewhere downstream.
 *
 * Formatting is the ONLY place a monetary value should stop being an integer,
 * and even here the arithmetic is integral.
 */

export function formatUsd(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(Math.trunc(cents));
  const dollars = Math.floor(abs / 100).toLocaleString("en-US");
  return `${sign}$${dollars}.${String(abs % 100).padStart(2, "0")}`;
}

/** Lowest of a set, for "from $X" pricing. Returns null for an empty set. */
export function minCents(values: number[]): number | null {
  return values.length ? values.reduce((a, b) => (b < a ? b : a)) : null;
}
