import assert from "node:assert/strict";
import { describe, it } from "node:test";

import sharp from "sharp";

import { composeMockup, displace, printBoxFromTemplate } from "../lib/mockup/composite";

/**
 * Synthetic assets throughout — a real garment template is a photograph, and
 * this repo has none. Generated inputs still exercise every transform, and
 * pixels are asserted at known coordinates rather than eyeballed.
 */

const GARMENT = { width: 400, height: 500 };
const BOX = { left: 100, top: 120, width: 200, height: 260 };

/** A light garment with a vertical shading gradient, standing in for folds. */
async function garment() {
  const w = GARMENT.width, h = GARMENT.height;
  const px = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const shade = 200 + Math.round(40 * Math.sin((y / h) * Math.PI * 3));
      const i = (y * w + x) * 3;
      px[i] = px[i + 1] = px[i + 2] = shade;
    }
  }
  return sharp(px, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
}

/** White inside the print box, black everywhere else. */
async function mask() {
  const base = sharp({
    create: { width: GARMENT.width, height: GARMENT.height, channels: 3, background: { r: 0, g: 0, b: 0 } },
  });
  const white = await sharp({
    create: { width: BOX.width, height: BOX.height, channels: 3, background: { r: 255, g: 255, b: 255 } },
  }).png().toBuffer();

  return base.composite([{ input: white, left: BOX.left, top: BOX.top }]).png().toBuffer();
}

async function displacementMap() {
  const w = BOX.width, h = BOX.height;
  const px = Buffer.alloc(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      px[y * w + x] = 128 + Math.round(100 * Math.sin(x / 12));
    }
  }
  return sharp(px, { raw: { width: w, height: h, channels: 1 } }).png().toBuffer();
}

/** Solid red artwork — easy to find in the output. */
async function artwork(w = 600, h = 600) {
  return sharp({
    create: { width: w, height: h, channels: 4, background: { r: 220, g: 30, b: 30, alpha: 1 } },
  }).png().toBuffer();
}

async function pixelAt(png: Buffer, x: number, y: number) {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const i = (y * info.width + x) * 4;
  return { r: data[i], g: data[i + 1], b: data[i + 2], a: data[i + 3] };
}

describe("composeMockup", () => {
  it("returns an image the size of the garment, not the artwork", async () => {
    const out = await composeMockup({
      garment: await garment(), mask: await mask(), artwork: await artwork(), printBox: BOX,
    });
    const meta = await sharp(out).metadata();
    assert.equal(meta.width, GARMENT.width);
    assert.equal(meta.height, GARMENT.height);
  });

  it("puts ink inside the print area", async () => {
    const out = await composeMockup({
      garment: await garment(), mask: await mask(), artwork: await artwork(), printBox: BOX,
    });
    const centre = await pixelAt(out, BOX.left + BOX.width / 2, BOX.top + BOX.height / 2);
    assert.ok(centre.r > centre.g + 40, `expected red ink, got ${JSON.stringify(centre)}`);
  });

  it("leaves nothing outside the print area", async () => {
    const out = await composeMockup({
      garment: await garment(), mask: await mask(), artwork: await artwork(), printBox: BOX,
    });
    // A design bleeding onto a collar or sleeve is the failure this prevents.
    for (const [x, y] of [[10, 10], [390, 10], [10, 490], [390, 490], [50, 250]]) {
      const p = await pixelAt(out, x, y);
      assert.ok(Math.abs(p.r - p.g) < 12 && Math.abs(p.g - p.b) < 12,
        `ink escaped the mask at ${x},${y}: ${JSON.stringify(p)}`);
    }
  });

  it("lets the garment's shadows show through the ink", async () => {
    // This is what multiply buys: the print is darker where the fabric is.
    const out = await composeMockup({
      garment: await garment(), mask: await mask(), artwork: await artwork(), printBox: BOX,
    });
    const x = BOX.left + 100;
    const samples = await Promise.all(
      [BOX.top + 20, BOX.top + 90, BOX.top + 160, BOX.top + 230].map((y) => pixelAt(out, x, y)),
    );
    const reds = samples.map((s) => s.r);
    assert.ok(Math.max(...reds) - Math.min(...reds) > 8,
      `ink should vary with the fabric's shading, got ${reds.join(",")}`);
  });

  it("over-blend keeps ink bright, for dark garments", async () => {
    const opts = { garment: await garment(), mask: await mask(), artwork: await artwork(), printBox: BOX };
    const multiplied = await composeMockup({ ...opts, blend: "multiply" });
    const overlaid = await composeMockup({ ...opts, blend: "over" });

    const m = await pixelAt(multiplied, BOX.left + 100, BOX.top + 100);
    const o = await pixelAt(overlaid, BOX.left + 100, BOX.top + 100);
    assert.ok(o.r >= m.r, "over should be at least as bright as multiply");
  });

  it("preserves artwork aspect instead of cropping the seller's design", async () => {
    const wide = await composeMockup({
      garment: await garment(), mask: await mask(),
      artwork: await artwork(1200, 300), printBox: BOX,
    });
    // A 4:1 design in a taller box leaves garment visible above and below.
    const above = await pixelAt(wide, BOX.left + 100, BOX.top + 8);
    assert.ok(Math.abs(above.r - above.g) < 12,
      "a wide design should be letterboxed, not stretched to fill");
  });

  it("refuses a print box that falls off the garment", async () => {
    const opts = { garment: await garment(), mask: await mask(), artwork: await artwork() };
    await assert.rejects(
      () => composeMockup({ ...opts, printBox: { left: 350, top: 400, width: 200, height: 260 } }),
      /outside the garment/,
    );
  });

  it("rejects a garment template that is not an image", async () => {
    const rest = { mask: await mask(), artwork: await artwork(), printBox: BOX };
    await assert.rejects(
      () => composeMockup({ ...rest, garment: Buffer.from("not an image") }),
    );
  });
});

describe("displacement", () => {
  it("changes the image, so the print follows the fabric", async () => {
    const flat = await composeMockup({
      garment: await garment(), mask: await mask(), artwork: await artwork(), printBox: BOX,
    });
    const draped = await composeMockup({
      garment: await garment(), mask: await mask(), artwork: await artwork(),
      printBox: BOX, displacement: await displacementMap(), displacementStrength: 10,
    });
    assert.notEqual(flat.toString("base64"), draped.toString("base64"),
      "a flat overlay is the clearest tell of a fake mockup");
  });

  it("leaves pixels untouched where the map is neutral grey", () => {
    const w = 4, h = 4;
    const rgba = Buffer.alloc(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      rgba[i * 4] = i * 10; rgba[i * 4 + 3] = 255;
    }
    const neutral = Buffer.alloc(w * h, 128);
    const out = displace(rgba, neutral, w, h, 8);
    assert.deepEqual(out, rgba);
  });

  it("clamps at the edges rather than wrapping", () => {
    // Wrapping would drag the far edge of a design into frame, which reads as a
    // printing fault rather than fabric.
    const w = 4, h = 1;
    const rgba = Buffer.alloc(w * h * 4);
    for (let x = 0; x < w; x++) { rgba[x * 4] = (x + 1) * 50; rgba[x * 4 + 3] = 255; }
    const pushLeft = Buffer.alloc(w * h, 0); // full black = maximum negative shift
    const out = displace(rgba, pushLeft, w, h, 10);
    assert.equal(out[0], rgba[0], "leftmost pixel should clamp to itself");
  });

  it("keeps the buffer the same length", () => {
    const w = 8, h = 8;
    const rgba = Buffer.alloc(w * h * 4, 200);
    const map = Buffer.alloc(w * h, 60);
    assert.equal(displace(rgba, map, w, h, 5).length, rgba.length);
  });
});

describe("printBoxFromTemplate", () => {
  it("converts fractional placement into pixels", () => {
    const box = printBoxFromTemplate(
      { leftFraction: 0.25, topFraction: 0.24, widthFraction: 0.5, heightFraction: 0.52 },
      GARMENT,
    );
    assert.deepEqual(box, BOX);
  });
});
