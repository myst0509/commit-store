import sharp from "sharp";

/**
 * Mockup compositing.
 *
 * PROJECT.md: displacement map + mask + multiply, and explicitly no generative
 * AI. The reason is that a mockup is a product photograph, and a hallucinated
 * garment is a misrepresentation we are merchant of record for. Everything here
 * is a deterministic transform of a real photograph of a real blank.
 *
 * Four inputs, three of which are per-garment assets produced once:
 *
 *   garment      a photograph of the blank
 *   mask         white where the print goes, black elsewhere
 *   displacement a greyscale map of the fabric's folds
 *   artwork      the seller's design
 *
 * And the order matters:
 *
 *   1. Fit the artwork into the print area, preserving aspect.
 *   2. Displace it, so it follows the fabric instead of floating flat on top.
 *   3. Mask it, so it cannot spill past the printable area.
 *   4. Multiply it onto the garment, so the photograph's own shadows show
 *      through the ink rather than being painted over.
 *
 * Sharp has no displacement operator, so step 2 is done in raw pixel space.
 */

export interface PrintBox {
  /** Pixel offsets into the garment image. */
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface MockupInput {
  garment: Buffer;
  /** White = printable. Must match the garment's dimensions. */
  mask: Buffer;
  /** Greyscale fold map. Mid-grey is no displacement. Optional but flattening. */
  displacement?: Buffer;
  artwork: Buffer;
  printBox: PrintBox;
  /**
   * How far a fold pushes the ink, in pixels at full white/black. Real fabric
   * on a folded tee is a few pixels; more reads as a melting effect.
   */
  displacementStrength?: number;
  /**
   * Multiply lets the garment's shadows through, which is right on light
   * garments. On a black tee it makes the ink vanish — real DTG on darks is
   * printed over a white underbase, so `over` is the honest approximation.
   */
  blend?: "multiply" | "over";
}

/** Guard against a pathological upload turning into gigabytes of raw pixels. */
const MAX_PIXELS = 40_000_000;

export async function composeMockup(input: MockupInput): Promise<Buffer> {
  const garmentMeta = await sharp(input.garment).metadata();
  if (!garmentMeta.width || !garmentMeta.height) {
    throw new Error("Garment template is not a readable image");
  }
  if (garmentMeta.width * garmentMeta.height > MAX_PIXELS) {
    throw new Error("Garment template is too large to composite");
  }

  const box = input.printBox;
  if (
    box.left < 0 || box.top < 0 ||
    box.left + box.width > garmentMeta.width ||
    box.top + box.height > garmentMeta.height
  ) {
    throw new Error("Print box falls outside the garment template");
  }

  // 1. Fit, preserving aspect. `contain` with a transparent background rather
  //    than `cover`, because cropping a seller's design is never the right
  //    default — they chose the composition.
  // Typed as Uint8Array rather than Buffer: displace() allocates its own buffer,
  // and Buffer's generic backing-store parameter makes the two incompatible
  // otherwise. Sharp accepts either, and this avoids copying a large raw image
  // purely to satisfy the type.
  let art: Uint8Array = await sharp(input.artwork)
    .resize(box.width, box.height, {
      fit: "contain",
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .ensureAlpha()
    .raw()
    .toBuffer();

  // 2. Displace.
  if (input.displacement) {
    const map = await sharp(input.displacement)
      .resize(box.width, box.height, { fit: "fill" })
      .greyscale()
      .raw()
      .toBuffer();

    art = displace(art, map, box.width, box.height, input.displacementStrength ?? 6);
  }

  const artPng = await sharp(art, {
    raw: { width: box.width, height: box.height, channels: 4 },
  }).png().toBuffer();

  // 3. Mask. The mask covers the whole garment, so the print-area crop of it is
  //    what applies here. `dest-in` keeps the artwork only where the mask is
  //    opaque — this is what stops a design bleeding onto a sleeve or collar.
  const maskCrop = await sharp(input.mask)
    .resize(garmentMeta.width, garmentMeta.height, { fit: "fill" })
    .extract({ left: box.left, top: box.top, width: box.width, height: box.height })
    .greyscale()
    .toColourspace("b-w")
    .png()
    .toBuffer();

  const masked = await sharp(artPng)
    .composite([{ input: maskCrop, blend: "dest-in" }])
    .png()
    .toBuffer();

  // 4. Multiply onto the garment, positioned at the print box.
  return sharp(input.garment)
    .composite([{
      input: masked,
      left: box.left,
      top: box.top,
      blend: input.blend ?? "multiply",
    }])
    .png()
    .toBuffer();
}

/**
 * Per-pixel displacement.
 *
 * Each output pixel is sampled from a source position nudged by the map's
 * brightness: mid-grey means no movement, brighter pushes one way, darker the
 * other. That is what makes a print appear to sit *in* the fabric — a flat
 * overlay is the single clearest tell of a fake mockup.
 *
 * Nearest-neighbour sampling. Bilinear would be smoother, but at the few-pixel
 * offsets real fabric produces the difference is invisible and the cost is not.
 */
export function displace(
  rgba: Uint8Array,
  greyMap: Uint8Array,
  width: number,
  height: number,
  strength: number,
): Uint8Array {
  const out = Buffer.alloc(rgba.length);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const mapIndex = y * width + x;
      // -1..1, zero at mid-grey.
      const shift = ((greyMap[mapIndex] ?? 128) - 128) / 128;
      const offset = Math.round(shift * strength);

      // Clamped at the edges: wrapping would drag the opposite edge of the
      // design into frame, which looks like a printing fault.
      const sx = clamp(x + offset, 0, width - 1);
      const sy = clamp(y + offset, 0, height - 1);

      const src = (sy * width + sx) * 4;
      const dst = (y * width + x) * 4;

      out[dst] = rgba[src];
      out[dst + 1] = rgba[src + 1];
      out[dst + 2] = rgba[src + 2];
      out[dst + 3] = rgba[src + 3];
    }
  }

  return out;
}

/**
 * Print box in pixels, from a placement measured in inches.
 *
 * `catalog_placements` stores real print areas in inches. A garment template is
 * a photograph at some arbitrary resolution, so the two are related by where the
 * print area sits *in that photograph* — which is a per-template measurement,
 * not something derivable from the catalog.
 */
export function printBoxFromTemplate(template: {
  /** Where the print area sits in the template, as fractions of the image. */
  leftFraction: number;
  topFraction: number;
  widthFraction: number;
  heightFraction: number;
}, garment: { width: number; height: number }): PrintBox {
  return {
    left: Math.round(template.leftFraction * garment.width),
    top: Math.round(template.topFraction * garment.height),
    width: Math.round(template.widthFraction * garment.width),
    height: Math.round(template.heightFraction * garment.height),
  };
}

function clamp(n: number, min: number, max: number): number {
  return n < min ? min : n > max ? max : n;
}
