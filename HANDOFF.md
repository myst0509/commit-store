# How to use this package

Claude Code cannot see the conversation these files came from. It reads your repo. So put
these files in the repo and they become its context.

## Placement

```
your-project/
  PROJECT.md                          <- read this first, every session
  lib/fulfillment/types.ts            <- the interface. Do not bypass it.
  lib/fulfillment/index.ts            <- registry + routing
  lib/fulfillment/printful.ts         <- adapter skeleton, needs implementing
  supabase/migrations/0001_init.sql   <- run against Supabase before anything else
```

Also create a `CLAUDE.md` at the repo root containing:

```
Read PROJECT.md before any task. It defines the business model and the
architectural constraints, which are not obvious from the code.

Hard rules:
- All money is integer cents. Never floats, never numeric.
- No vendor SDK, endpoint, or field name outside lib/fulfillment/.
- Every user-facing query goes through RLS. Service role is server-only.
- Vendor submissions are idempotent on orders.idempotency_key.
- Ask before adding a dependency.
```

Claude Code reads `CLAUDE.md` automatically at the start of every session, which is what
makes the rules stick across conversations.

## Order of work

1. **Run the migration.** Supabase dashboard → SQL Editor → paste `0001_init.sql` → run.
   Verify in the Table Editor that RLS shows as enabled on every table.

2. **Implement the Printful adapter.** Every method currently throws. Work through them in
   this order: `listBlanks` → `listVariants` → `uploadArtwork` → `createProduct` →
   `submitOrder` → `getOrder` → `parseWebhook`.

   Anything marked UNVERIFIED in the comments must be checked against
   developers.printful.com before you trust it. Response shapes drift.

3. **Prove it end to end** with a script that creates a product and places one real order
   against a Printful sandbox or a low-value live order. Nothing else starts until an
   actual garment gets made.

## Good first prompt for Claude Code

> Read PROJECT.md and lib/fulfillment/types.ts. Then implement listBlanks and listVariants
> in lib/fulfillment/printful.ts against Printful's v1 API, and write a script that caches
> the results into catalog_blanks and catalog_variants. Check the live API docs for the
> response shapes — the comments mark which ones are unverified. Explain what you're doing
> as you go; I'm new to web development.

That last sentence matters. Ask it to explain rather than just produce, or you'll end up
with a codebase you can't debug.

## Open questions to resolve with the vendors

- **Printful:** is there a cap on stores per account? This determines whether store-per-seller
  works or whether you need a single shared store with reconciliation by external_id.
- **Printful:** confirm their terms permit acting as merchant of record for third-party sellers.
- **Apliiq:** the "500-on-everything fault" was our own unsigned requests — they use HMAC
  auth and return 500 instead of 401. Needs an APP_ID and shared secret from their dashboard.
- **Both:** rate limits, and whether an idempotency header is honoured on order creation.
