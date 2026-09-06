import { UserError } from "@/lib/errors";

/**
 * What a seller wants to be called.
 *
 * Deliberately not "legal name". People go by shortenings, middle names, chosen
 * names and handles, and a platform that insists on the name attached to a
 * payment method gets that wrong for a lot of people. The only questions asked
 * here are whether it fits on screen and whether it is really text.
 *
 * Stored on the auth user rather than the store: the store is the brand, this
 * is the person, and one person could later own more than one store.
 */

/** Long enough for a full name, short enough to sit in a greeting. */
export const MAX_DISPLAY_NAME = 40;

/**
 * C0 and C1 controls, zero-width characters, and the bidirectional overrides
 * that can make text render as something other than what is stored. Built from
 * escapes rather than literals so the source file stays plain text.
 */
const CONTROL_AND_BIDI =
  "[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E]";

export function normalizeDisplayName(input: unknown): string | null {
  if (input === null || input === undefined) return null;

  const name = String(input)
    // Whitespace first, so a tab becomes a space rather than being stripped
    // as a control character in the next step and gluing two words together.
    .replace(/\s+/g, " ")
    .replace(new RegExp(CONTROL_AND_BIDI, "g"), "")
    .trim();

  if (!name) return null;

  if (name.length > MAX_DISPLAY_NAME) {
    throw new UserError(
      `That is ${name.length} characters. Keep it under ${MAX_DISPLAY_NAME}`,
    );
  }

  return name;
}
