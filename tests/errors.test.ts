import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { errorResponse } from "../lib/auth/session";
import { UserError } from "../lib/errors";
import { toSubdomain } from "../lib/launch/actions";

/**
 * These pin a bug that reached a real seller: naming a brand "XO" answered
 * "Something went wrong".
 *
 * errorResponse used to decide whether a message was safe to show by testing
 * it against a keyword list. The list held "too small" but not "too short", so
 * "Brand name is too short for a web address" was replaced with the generic
 * 500 text. Fourteen messages were being swallowed the same way.
 *
 * If someone reintroduces message-sniffing, these fail.
 */

const body = async (res: Response) => (await res.json()) as { error: string };

describe("errorResponse", () => {
  it("shows a UserError to the caller, as a 400", async () => {
    const res = errorResponse(new UserError("Pick a closing date"));
    assert.equal(res.status, 400);
    assert.equal((await body(res)).error, "Pick a closing date");
  });

  it("hides anything else behind a 500", async () => {
    const res = errorResponse(new Error("relation \"stores\" does not exist"));
    assert.equal(res.status, 500);
    assert.equal((await body(res)).error, "Something went wrong");
  });

  it("does not leak a message just because it reads like prose", async () => {
    // Would have passed the old keyword list on "must".
    const res = errorResponse(new Error("connection must be re-established to 10.0.0.4"));
    assert.equal(res.status, 500);
    assert.equal((await body(res)).error, "Something went wrong");
  });

  it("passes a thrown non-Error through as a 500 rather than crashing", async () => {
    const res = errorResponse("something odd");
    assert.equal(res.status, 500);
    assert.equal((await body(res)).error, "Something went wrong");
  });
});

describe("short brand names", () => {
  it("rejects a name too short to be a web address, and says so", () => {
    // The reported case.
    assert.throws(() => toSubdomain("XO"), (e: unknown) => {
      assert.ok(e instanceof UserError, "must be a UserError or the seller sees 'Something went wrong'");
      assert.match((e as Error).message, /too short/i);
      return true;
    });
  });

  it("rejects a name that is long enough only because of punctuation", () => {
    // "A&B" collapses to "a-b"... which is 3 characters and legal. "A&" is not.
    assert.throws(() => toSubdomain("A&"), (e: unknown) => e instanceof UserError);
  });

  it("accepts the shortest legal name", () => {
    assert.equal(toSubdomain("XOX"), "xox");
  });

  it("still builds a subdomain from a normal name", () => {
    assert.equal(toSubdomain("Studio Mono"), "studio-mono");
  });
});
