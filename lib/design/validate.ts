import sharp from "sharp";

import { UserError } from "@/lib/errors";

/**
 * Artwork validation against the vendor's real print areas.
 *
 * The failure this prevents: a seller uploads a small logo, it looks fine on
 * screen, and nobody discovers it prints blurry until a garment exists. By then
 * we are merchant of record for a bad product.
 *
 * Print areas and minimum DPI come from `catalog_placements`, which the catalog
 * sync fills from the vendor. Nothing here is guessed.
 */

export interface PlacementSpec {
  code: string;
  widthIn: number;
  heightIn: number;
  minDpi: number;
}

export interface ArtworkFacts {
  widthPx: number;
  heightPx: number;
  format: string;
  hasAlpha: boolean;
  /** Colour space as embedded. Print wants RGB; CMYK gets converted and shifts. */
  space: string;
  byteSize: number;
}

export type Severity = "error" | "warning";

export interface Finding {
  severity: Severity;
  code: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  facts: ArtworkFacts;
  /** Largest print this artwork supports at the placement's minimum DPI. */
  maxPrintInches: { width: number; height: number };
  /** DPI achieved if printed at the placement's full size. */
  effectiveDpi: number;
  findings: Finding[];
}

/** Hard ceiling on upload size. Vendors reject enormous files anyway. */
const MAX_BYTES = 50 * 1024 * 1024;

/** Below this, artwork is unusable at any size we print. */
const ABSOLUTE_MIN_PX = 400;

export async function inspectArtwork(input: Buffer): Promise<ArtworkFacts> {
  const meta = await sharp(input).metadata();

  if (!meta.width || !meta.height) {
    throw new UserError("That file is not an image we can read");
  }

  return {
    widthPx: meta.width,
    heightPx: meta.height,
    format: meta.format ?? "unknown",
    hasAlpha: Boolean(meta.hasAlpha),
    space: meta.space ?? "unknown",
    byteSize: input.byteLength,
  };
}

/**
 * Checks artwork against one placement.
 *
 * Errors block production. Warnings are shown to the seller but do not stop
 * them — an opaque background is a taste question on a white tee and a disaster
 * on a black one, and we cannot tell which they intend from the file alone.
 */
export function validateAgainstPlacement(
  facts: ArtworkFacts,
  placement: PlacementSpec,
): ValidationResult {
  const findings: Finding[] = [];

  // DPI achieved if the image is scaled to fill the print area. The binding
  // constraint is whichever axis runs out of pixels first.
  const dpiAcrossWidth = facts.widthPx / placement.widthIn;
  const dpiAcrossHeight = facts.heightPx / placement.heightIn;
  const effectiveDpi = Math.floor(Math.min(dpiAcrossWidth, dpiAcrossHeight));

  const maxPrintInches = {
    width: round2(facts.widthPx / placement.minDpi),
    height: round2(facts.heightPx / placement.minDpi),
  };

  if (facts.byteSize > MAX_BYTES) {
    findings.push({
      severity: "error", code: "too_large",
      message: `File is ${Math.round(facts.byteSize / 1024 / 1024)}MB; the limit is 50MB`,
    });
  }

  if (facts.widthPx < ABSOLUTE_MIN_PX || facts.heightPx < ABSOLUTE_MIN_PX) {
    findings.push({
      severity: "error", code: "far_too_small",
      message:
        `Artwork is ${facts.widthPx}×${facts.heightPx}px, which is too small to print at any size`,
    });
  } else if (effectiveDpi < placement.minDpi) {
    // The actionable version: what they can print, and what they would need.
    const needW = Math.ceil(placement.widthIn * placement.minDpi);
    const needH = Math.ceil(placement.heightIn * placement.minDpi);
    findings.push({
      severity: "error", code: "low_resolution",
      message:
        `At full size this prints at ${effectiveDpi} DPI; ${placement.minDpi} is needed. ` +
        `Either print it smaller — up to ${maxPrintInches.width}″ × ${maxPrintInches.height}″ — ` +
        `or supply at least ${needW}×${needH}px`,
    });
  }

  if (!facts.hasAlpha) {
    findings.push({
      severity: "warning", code: "no_transparency",
      message:
        "No transparent background, so this prints as a rectangle. " +
        "Fine on a matching garment colour, obvious on any other",
    });
  }

  if (facts.space === "cmyk") {
    findings.push({
      severity: "warning", code: "cmyk",
      message: "CMYK artwork shifts colour when converted for printing. RGB is safer",
    });
  }

  if (facts.format === "jpeg" || facts.format === "jpg") {
    findings.push({
      severity: "warning", code: "lossy_format",
      message: "JPEG cannot hold transparency and compresses edges. PNG prints cleaner",
    });
  }

  return {
    ok: !findings.some((f) => f.severity === "error"),
    facts,
    maxPrintInches,
    effectiveDpi,
    findings,
  };
}

/**
 * Validates against every placement a blank offers.
 *
 * A design usable on the chest but not across the back is not a failure — it is
 * a smaller set of choices, and the seller should be told which.
 */
export function validateAgainstBlank(
  facts: ArtworkFacts,
  placements: PlacementSpec[],
): {
  ok: boolean;
  usablePlacements: string[];
  byPlacement: Record<string, ValidationResult>;
} {
  const byPlacement: Record<string, ValidationResult> = {};
  const usable: string[] = [];

  for (const p of placements) {
    const result = validateAgainstPlacement(facts, p);
    byPlacement[p.code] = result;
    if (result.ok) usable.push(p.code);
  }

  return { ok: usable.length > 0, usablePlacements: usable, byPlacement };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
