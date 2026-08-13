/**
 * Apparel sizes do not sort alphabetically, and sorting them that way puts XS
 * after L on every size picker. There is no canonical order in the vendor data
 * either — Printful returns whatever the manufacturer uses — so the order has to
 * live here.
 */

const ORDER = [
  "XXXS", "3XS",
  "XXS", "2XS",
  "XS",
  "S",
  "M",
  "L",
  "XL",
  "XXL", "2XL",
  "XXXL", "3XL",
  "4XL",
  "5XL",
  "6XL",
  "7XL",
];

const RANK = new Map(
  // "XXL" and "2XL" are the same size written two ways; they share a rank so a
  // catalog mixing both conventions still sorts sensibly.
  ORDER.map((s, i) => [s, Math.floor(i)] as const),
);

// Normalize the pairs above onto shared ranks.
const ALIASES: Record<string, string> = {
  "3XS": "XXXS", "2XS": "XXS", "2XL": "XXL", "3XL": "XXXL",
};

/**
 * Sort key for a size label. Lettered sizes come first in wearing order, then
 * numeric sizes ascending, then anything unrecognized alphabetically at the end
 * so it is visible rather than silently dropped.
 */
export function sizeRank(size: string): [number, number, string] {
  const s = size.trim().toUpperCase().replace(/\s+/g, "");

  if (s === "ONESIZE" || s === "OS" || s === "ONE SIZE") return [0, 0, s];

  const canonical = ALIASES[s] ?? s;
  const lettered = RANK.get(canonical);
  if (lettered !== undefined) return [1, lettered, s];

  // Numeric sizes: waist measurements, shoe sizes, "32/34".
  const numeric = /^(\d+(?:\.\d+)?)/.exec(s);
  if (numeric) return [2, Number(numeric[1]), s];

  return [3, 0, s];
}

export function compareSizes(a: string, b: string): number {
  const [ga, ra, sa] = sizeRank(a);
  const [gb, rb, sb] = sizeRank(b);
  return ga - gb || ra - rb || sa.localeCompare(sb);
}

/** Sorts in place-safe fashion, returning a new array. */
export function sortSizes(sizes: string[]): string[] {
  return [...sizes].sort(compareSizes);
}
