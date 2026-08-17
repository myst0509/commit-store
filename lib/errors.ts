/**
 * An error whose message was written to be read by the person who caused it.
 *
 * `errorResponse` passes these through verbatim as a 400. Everything else
 * becomes a generic 500, because a stack trace or a database error is our
 * problem and not something to put in front of a seller.
 *
 * This used to be inferred by matching the message against a list of keywords,
 * which failed open in the worst direction: "Brand name is too short for a web
 * address" reached the seller as "Something went wrong", because the list
 * happened to contain "too small" and not "too short". Fourteen perfectly good
 * messages were being swallowed that way. Whether a message is safe to show is
 * a property of the throw site, not of the words it happens to contain.
 */
export class UserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserError";
  }
}
