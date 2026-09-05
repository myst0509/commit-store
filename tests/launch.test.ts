import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { toSlug, toSubdomain } from "../lib/launch/actions";
import { currentStep, progressSummary, resolveSteps, STEPS } from "../lib/launch/steps";

const done = (completedAt = "2026-08-11T00:00:00Z") =>
  ({ status: "completed" as const, completedAt });

describe("launch step unlocking", () => {
  it("starts with only the first step available", () => {
    const states = resolveSteps({});
    assert.equal(states[0].status, "available");
    assert.ok(states.slice(1).every((s) => s.status === "locked"));
    assert.equal(currentStep(states)?.key, "name");
  });

  it("unlocks the next step once its prerequisite is done", () => {
    const states = resolveSteps({ name: done() });
    assert.equal(states.find((s) => s.key === "name")!.status, "completed");
    assert.equal(states.find((s) => s.key === "design")!.status, "available");
    assert.equal(states.find((s) => s.key === "blank")!.status, "locked");
  });

  it("tells a locked step what it is waiting on", () => {
    const blank = resolveSteps({})!.find((s) => s.key === "blank")!;
    assert.deepEqual(blank.blockedBy, ["design"]);
  });

  it("does not unlock a step just because a later one was completed", () => {
    // Out-of-order completion must not cascade backwards into a false unlock.
    const states = resolveSteps({ launch: done() });
    assert.equal(states.find((s) => s.key === "design")!.status, "locked");
  });

  it("treats a skipped step as satisfying its dependents", () => {
    // A seller who already has a design should not be forced to re-upload one.
    const states = resolveSteps({
      name: done(),
      design: { status: "skipped", completedAt: null },
    });
    assert.equal(states.find((s) => s.key === "blank")!.status, "available");
  });

  it("walks the whole sequence in order", () => {
    const completed: Record<string, { status: "completed"; completedAt: string }> = {};
    for (const step of STEPS) {
      const states = resolveSteps(completed);
      assert.equal(currentStep(states)?.key, step.key, `expected ${step.key} to be current`);
      completed[step.key] = done();
    }
    assert.equal(currentStep(resolveSteps(completed)), null);
    assert.equal(progressSummary(resolveSteps(completed)).percent, 100);
  });

  it("every step performs an action — none is advice text", () => {
    // PROJECT.md is explicit that this is the differentiator. A step with no
    // action would be a tip dressed as a button.
    for (const s of STEPS) {
      assert.ok(s.actionKey && s.actionKey.length > 0, `${s.key} has no action`);
      assert.ok(s.outcome && s.outcome.length > 0, `${s.key} has no stated outcome`);
    }
  });

  it("has no unreachable steps", () => {
    const keys = new Set(STEPS.map((s) => s.key));
    for (const s of STEPS) {
      for (const r of s.requires) {
        assert.ok(keys.has(r), `${s.key} requires unknown step ${r}`);
      }
    }
  });
});

describe("subdomain and slug generation", () => {
  it("turns a brand name into a usable web address", () => {
    assert.equal(toSubdomain("Union Made"), "union-made");
    assert.equal(toSubdomain("  Spaced  Out  "), "spaced-out");
    assert.equal(toSubdomain("Café Noir"), "cafe-noir");
    assert.equal(toSubdomain("A&W Clothing!!"), "a-w-clothing");
  });

  it("refuses names too short to be an address", () => {
    assert.throws(() => toSubdomain("ab"));
    assert.throws(() => toSubdomain("!!"));
  });

  it("respects the DNS label limit", () => {
    assert.ok(toSubdomain("x".repeat(200)).length <= 63);
  });

  it("makes product slugs, falling back rather than producing an empty one", () => {
    assert.equal(toSlug("First Tee"), "first-tee");
    assert.equal(toSlug("!!!"), "product");
  });
});

describe("skipping a step", () => {
  // Two steps can be passed over. order_sample is not built, because a sample
  // is a real vendor order and PROJECT.md gates subsidised samples behind caps
  // that do not exist. connect_bank is optional on purpose: a store can open
  // without a bank attached and the earnings simply wait, which is better than
  // blocking a launch on Stripe finishing its checks.
  it("marks sample and bank optional, and nothing else", () => {
    const optional = STEPS.filter((s) => s.optional).map((s) => s.key).sort();
    assert.deepEqual(optional, ["bank", "sample"]);
  });

  it("treats a skipped step as done for whatever depends on it", () => {
    const states = resolveSteps({
      name: done(), design: done(), blank: done(), price: done(),
      style: done(), story: done(), socials: done(),
      sample: { status: "skipped", completedAt: "2026-08-19T00:00:00Z" },
    });
    assert.equal(states.find((s) => s.key === "drop_date")!.status, "available");
  });

  it("counts a skip toward progress, or the path could never read as finished", () => {
    const all = Object.fromEntries(
      STEPS.map((s) => [s.key, s.optional
        ? { status: "skipped" as const, completedAt: "2026-08-19T00:00:00Z" }
        : done()]),
    );
    assert.equal(progressSummary(resolveSteps(all)).percent, 100);
  });
});

describe("the guide is actually completable", () => {
  // The reshape into phases moved every dependency. This is the check that
  // matters: before it, drop_date required sample, sample could not be done or
  // skipped, and the back half of the path was unreachable by anyone.
  it("never depends on a step that comes later", () => {
    const position = new Map(STEPS.map((s, i) => [s.key, i]));
    for (const step of STEPS) {
      for (const required of step.requires) {
        assert.ok(position.has(required), `${step.key} requires unknown step ${required}`);
        assert.ok(
          position.get(required)! < position.get(step.key)!,
          `${step.key} requires ${required}, which comes after it`,
        );
      }
    }
  });

  it("can be walked from empty to finished, doing each available step in turn", () => {
    const state: Record<string, { status: "completed" | "skipped"; completedAt: string }> = {};

    for (let guard = 0; guard < STEPS.length + 1; guard++) {
      const states = resolveSteps(state);
      if (progressSummary(states).percent === 100) break;

      const next = states.find((s) => s.status === "available");
      assert.ok(next, "stuck: no step is available and the path is not finished");
      state[next.key] = { status: "completed", completedAt: "2026-08-19T00:00:00Z" };
    }

    assert.equal(progressSummary(resolveSteps(state)).percent, 100);
  });

  it("can be finished while skipping everything skippable", () => {
    const state: Record<string, { status: "completed" | "skipped"; completedAt: string }> = {};

    for (let guard = 0; guard < STEPS.length + 1; guard++) {
      const states = resolveSteps(state);
      if (progressSummary(states).percent === 100) break;

      const next = states.find((s) => s.status === "available");
      assert.ok(next, "stuck: a skippable step left the path unreachable");
      state[next.key] = {
        status: next.optional ? "skipped" : "completed",
        completedAt: "2026-08-19T00:00:00Z",
      };
    }

    assert.equal(progressSummary(resolveSteps(state)).percent, 100);
  });

  it("puts every step in a phase, and every phase in order", () => {
    const order = ["make", "build", "sell"];
    let seen = -1;
    for (const step of STEPS) {
      const i = order.indexOf(step.phase);
      assert.ok(i >= 0, `${step.key} has no phase`);
      assert.ok(i >= seen, `${step.key} is in phase ${step.phase}, out of order`);
      seen = i;
    }
  });
});
