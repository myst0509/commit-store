/**
 * Renders a sample mockup so the compositing can be looked at rather than
 * inferred from tests.
 *
 *   npx tsx scripts/mockup-sample.ts [outputPath]
 *
 * Uses synthetic assets. Real garment templates are a photography task, not a
 * code one — see the note at the end of the output.
 */

import fs from "node:fs";
import path from "node:path";

import sharp from "sharp";

import { composeMockup, printBoxFromTemplate } from "../lib/mockup/composite";

const W = 520, H = 640;

/** A pale garment with folds running through it. */
async function garment() {
  const px = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const folds =
        26 * Math.sin((x / W) * Math.PI * 5) +
        18 * Math.sin((y / H) * Math.PI * 3.5) +
        10 * Math.sin(((x + y) / W) * Math.PI * 7);
      // Darker towards the edges, the way a photographed garment falls away.
      const vignette = -30 * Math.pow((x / W - 0.5) * 2, 2);
      const v = Math.max(0, Math.min(255, Math.round(214 + folds + vignette)));
      const i = (y * W + x) * 3;
      px[i] = px[i + 1] = px[i + 2] = v;
    }
  }
  return sharp(px, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
}

/** The same fold structure, as a displacement map for the print area. */
async function displacementMap(w: number, h: number) {
  const px = Buffer.alloc(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = 128 +
        60 * Math.sin((x / w) * Math.PI * 5) +
        40 * Math.sin((y / h) * Math.PI * 3.5);
      px[y * w + x] = Math.max(0, Math.min(255, Math.round(v)));
    }
  }
  return sharp(px, { raw: { width: w, height: h, channels: 1 } }).png().toBuffer();
}

async function mask(box: { left: number; top: number; width: number; height: number }) {
  const white = await sharp({
    create: { width: box.width, height: box.height, channels: 3, background: { r: 255, g: 255, b: 255 } },
  }).png().toBuffer();

  return sharp({ create: { width: W, height: H, channels: 3, background: { r: 0, g: 0, b: 0 } } })
    .composite([{ input: white, left: box.left, top: box.top }])
    .png().toBuffer();
}

/** A design with hard edges, so displacement is obvious. */
async function artwork() {
  const size = 900;
  const svg = `<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
    <rect width="${size}" height="${size}" fill="none"/>
    <circle cx="${size / 2}" cy="${size / 2}" r="${size * 0.38}" fill="none" stroke="#1b2b4a" stroke-width="26"/>
    ${[0, 1, 2, 3, 4].map((i) =>
      `<rect x="${size * 0.18}" y="${size * (0.30 + i * 0.095)}" width="${size * 0.64}" height="18" fill="#1b2b4a"/>`).join("")}
    <text x="50%" y="${size * 0.82}" text-anchor="middle" font-family="monospace"
          font-size="${size * 0.09}" fill="#1b2b4a" letter-spacing="6">COMMIT</text>
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function main() {
  const out = process.argv[2] ?? path.join(process.cwd(), "mockup-sample.png");

  const box = printBoxFromTemplate(
    { leftFraction: 0.27, topFraction: 0.22, widthFraction: 0.46, heightFraction: 0.44 },
    { width: W, height: H },
  );

  const [g, m, art, disp] = await Promise.all([
    garment(), mask(box), artwork(), displacementMap(box.width, box.height),
  ]);

  const flat = await composeMockup({ garment: g, mask: m, artwork: art, printBox: box });
  const draped = await composeMockup({
    garment: g, mask: m, artwork: art, printBox: box,
    displacement: disp, displacementStrength: 9,
  });

  // Side by side, so the difference is visible rather than described.
  const label = (text: string) => Buffer.from(
    `<svg width="${W}" height="34" xmlns="http://www.w3.org/2000/svg">
       <rect width="${W}" height="34" fill="#12151c"/>
       <text x="14" y="23" font-family="monospace" font-size="15" fill="#e8eaf0">${text}</text>
     </svg>`);

  await sharp({
    create: { width: W * 2 + 12, height: H + 34, channels: 3, background: { r: 18, g: 21, b: 28 } },
  })
    .composite([
      { input: await sharp(label("1. no displacement — ink floats")).png().toBuffer(), left: 0, top: 0 },
      { input: flat, left: 0, top: 34 },
      { input: await sharp(label("2. displaced — ink follows the fabric")).png().toBuffer(), left: W + 12, top: 0 },
      { input: draped, left: W + 12, top: 34 },
    ])
    .png()
    .toFile(out);

  console.log(`wrote ${out}`);
  console.log(`garment ${W}×${H}, print box ${box.width}×${box.height} at ${box.left},${box.top}`);
  console.log(`sample size: ${(fs.statSync(out).size / 1024).toFixed(0)} KB`);
  console.log("\nSynthetic garment. A real template needs three assets per blank:");
  console.log("  - a photograph of the blank");
  console.log("  - a mask, white where the print goes");
  console.log("  - a greyscale displacement map of the folds");
  console.log("That is a photography and retouching task, not a coding one.");
}

main().catch((e) => { console.error(e); process.exit(1); });
