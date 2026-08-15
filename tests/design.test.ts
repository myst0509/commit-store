import assert from "node:assert/strict";
import { describe, it } from "node:test";

import sharp from "sharp";

import {
  inspectArtwork, validateAgainstBlank, validateAgainstPlacement,
  type PlacementSpec,
} from "../lib/design/validate";

/** Real print areas, taken from Printful for a Bella + Canvas 3001. */
const FRONT: PlacementSpec = { code: "front", widthIn: 12, heightIn: 16, minDpi: 150 };
const SLEEVE: PlacementSpec = { code: "sleeve_left", widthIn: 4, heightIn: 3.5, minDpi: 150 };
const LABEL: PlacementSpec = { code: "neck_inner", widthIn: 3, heightIn: 3, minDpi: 150 };

async function png(width: number, height: number, opts: { alpha?: boolean } = {}) {
  return sharp({
    create: {
      width, height, channels: opts.alpha === false ? 3 : 4,
      background: { r: 20, g: 40, b: 90, alpha: opts.alpha === false ? 1 : 0.5 },
    },
  }).png().toBuffer();
}

describe("inspectArtwork", () => {
  it("reads real dimensions and format", async () => {
    const facts = await inspectArtwork(await png(1800, 2400));
    assert.equal(facts.widthPx, 1800);
    assert.equal(facts.heightPx, 2400);
    assert.equal(facts.format, "png");
    assert.equal(facts.hasAlpha, true);
  });

  it("detects a missing alpha channel", async () => {
    const facts = await inspectArtwork(await png(1800, 2400, { alpha: false }));
    assert.equal(facts.hasAlpha, false);
  });

  it("rejects things that are not images, rather than assuming defaults", async () => {
    await assert.rejects(() => inspectArtwork(Buffer.from("this is not a png")));
  });
});

describe("validateAgainstPlacement", () => {
  it("passes artwork that meets the print area at full size", async () => {
    // 12in x 150dpi = 1800px wide, 16in x 150dpi = 2400px tall. Exactly enough.
    const r = validateAgainstPlacement(await inspectArtwork(await png(1800, 2400)), FRONT);
    assert.equal(r.ok, true);
    assert.equal(r.effectiveDpi, 150);
    assert.ok(!r.findings.some((f) => f.severity === "error"));
  });

  it("fails artwork that would print blurry, and says what would fix it", async () => {
    const r = validateAgainstPlacement(await inspectArtwork(await png(900, 1200)), FRONT);
    assert.equal(r.ok, false);
    assert.equal(r.effectiveDpi, 75);

    const finding = r.findings.find((f) => f.code === "low_resolution")!;
    assert.ok(finding, "should explain the resolution problem");
    // The seller needs both escape routes: print smaller, or supply more pixels.
    assert.match(finding.message, /1800×2400px/);
    assert.match(finding.message, /6″ × 8″/);
  });

  it("reports the largest size artwork can actually print at", async () => {
    const r = validateAgainstPlacement(await inspectArtwork(await png(900, 1200)), FRONT);
    assert.deepEqual(r.maxPrintInches, { width: 6, height: 8 });
  });

  it("is bound by whichever axis runs out of pixels first", async () => {
    // Wide enough, nowhere near tall enough.
    const r = validateAgainstPlacement(await inspectArtwork(await png(3000, 600)), FRONT);
    assert.equal(r.effectiveDpi, 37); // 600px / 16in
    assert.equal(r.ok, false);
  });

  it("accepts small artwork for a small placement", async () => {
    // 450x450 fails the front print but is fine on a neck label.
    const facts = await inspectArtwork(await png(450, 450));
    assert.equal(validateAgainstPlacement(facts, FRONT).ok, false);
    assert.equal(validateAgainstPlacement(facts, LABEL).ok, true);
  });

  it("rejects artwork too small for anything, without pretending it is fixable", async () => {
    const r = validateAgainstPlacement(await inspectArtwork(await png(120, 120)), LABEL);
    assert.equal(r.ok, false);
    assert.ok(r.findings.some((f) => f.code === "far_too_small"));
    assert.ok(!r.findings.some((f) => f.code === "low_resolution"),
      "should not also suggest printing smaller");
  });

  it("warns about an opaque background without blocking it", async () => {
    const r = validateAgainstPlacement(
      await inspectArtwork(await png(1800, 2400, { alpha: false })), FRONT,
    );
    assert.equal(r.ok, true, "a rectangle print is a choice, not an error");
    assert.ok(r.findings.some((f) => f.code === "no_transparency" && f.severity === "warning"));
  });

  it("warns about JPEG", async () => {
    const jpeg = await sharp({
      create: { width: 1800, height: 2400, channels: 3, background: { r: 1, g: 2, b: 3 } },
    }).jpeg().toBuffer();

    const r = validateAgainstPlacement(await inspectArtwork(jpeg), FRONT);
    assert.ok(r.findings.some((f) => f.code === "lossy_format"));
  });
});

describe("validateAgainstBlank", () => {
  it("reports which placements the artwork can be used on", async () => {
    const facts = await inspectArtwork(await png(700, 700));
    const r = validateAgainstBlank(facts, [FRONT, SLEEVE, LABEL]);

    assert.equal(r.ok, true);
    assert.deepEqual(r.usablePlacements.sort(), ["neck_inner", "sleeve_left"]);
    assert.equal(r.byPlacement.front.ok, false);
  });

  it("fails only when nothing at all is printable", async () => {
    const facts = await inspectArtwork(await png(150, 150));
    const r = validateAgainstBlank(facts, [FRONT, SLEEVE, LABEL]);
    assert.equal(r.ok, false);
    assert.deepEqual(r.usablePlacements, []);
  });
});
