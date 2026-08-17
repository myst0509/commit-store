# Progress

Living status of the build. Update it when something lands — this file is the
only memory that survives between sessions.

**Last updated:** 2026-08-11 · 25 commits · 96 unit tests + 50 integration checks

The money path is complete in code and verified against Stripe test mode:
reserve → threshold → capture → produce → deliver → ledger → payout, with
retries for the vendor gap and hold-releases for drops that fall short.
**No real garment has ever been made and no live charge has been taken.**

Legend: `DONE` verified working · `PARTIAL` built, not fully proven · `TODO` not started · `BLOCKED` waiting on something

---

## Build order (from PROJECT.md)

| # | Step | Status |
|---|------|--------|
| 1 | Schema + RLS | **DONE** |
| 2 | Fulfillment interface + Printful adapter | **PARTIAL** — no live order yet |
| 2b | Catalog cached into Postgres | **DONE** |
| 2c | Next.js scaffold | **DONE** |
| 3 | Storefront rendering (subdomain routing, theme, PDP) | **PARTIAL** — skeleton renders, no cart |
| 4 | Design upload + mockup compositing | **PARTIAL** — code done; blocked on garment template assets |
| 5 | Stripe Connect + checkout + order pipeline | **PARTIAL** — checkout + webhook done; no Connect/payouts |
| 6 | Launch path | **PARTIAL** — engine done, 8 of 21 steps defined |
| 7 | Drops and reservations | **PARTIAL** — resolution done and verified; no seller UI |

The original "no step 5 before a real order" gate was superseded 2026-08-11 — see
PROJECT.md. The gate is now: **no real customer payment until a garment has been
manufactured.** Test-mode charges and dry runs are fine; live checkout is not.

---

## 1. Schema + RLS — DONE

Applied to Supabase project `aktehepmvbaxuidpdzjh` on 2026-08-11.

- 22 tables, 13 enums, 29 RLS policies — `supabase/migrations/0001_init.sql`
- 8 launch steps seeded (of a 21-day sequence that is still undefined)
- `artwork` storage bucket created, public

Verified, not assumed:

- Two real sellers with real orders: each sees only their own, anonymous sees none
- Sellers cannot insert orders, and cannot credit their own `ledger_entries`
  (both rejected `42501`) — that second one matters, it is where margin lives
- All test data removed afterward; database is empty

Design decisions worth remembering:

- **Seller margin is a signed ledger, not a balance column.** Chargebacks must be
  clawable against future payouts; a mutable balance cannot be audited.
- **Reservations are orders**, with `drop_id` set and payment authorized-not-captured.
  One source of truth for money.
- **Money tables are read-only to sellers.** All writes are service-role.

## 2. Fulfillment interface + Printful adapter — PARTIAL

`lib/fulfillment/` — all 13 interface methods implemented, strict typecheck clean.

Verified against the live API:

- Catalog read path end to end (Bella + Canvas 3001: 84 colors, 590 variants,
  $11.69–$19.69 base cost, six correct print areas)
- Token is **account-level** — a store-scoped call without `X-PF-Store-Id`
  returns `400 This endpoint requires store_id!`
- Rate limit 120/min, `x-ratelimit-*` headers honored
- 35 unit tests on money conversion, dark-color detection, status mapping

**Not verified: no order has ever been placed.** `submitOrder`, `getOrder`,
`cancelOrder`, `estimateCost`, `quoteShipping`, `uploadArtwork`, `createProduct`
and `parseWebhook` are written but have never run against Printful. This is the
step 5 gate. Deferred by decision, not oversight.

Things the docs got wrong, found by calling the API (do not "fix" these back):

- v1 has **no idempotency header**. Idempotency is built on `external_id` plus a
  pre-flight lookup, and a duplicate-rejection catch on the way out.
- v1 webhooks are **unsigned**. Signing is v2-only. So the payload is treated as a
  hint about *which* order changed and the state is re-fetched via `getOrder`.
- Technique keys are UPPERCASE (`DTG`, `DTFILM`, `EMBROIDERY`, `CUT-SEW`).
- Placement keys are **technique-scoped** (`front_dtfabric`, `chest_left_dtf`).
  Matching bare keys silently returns zero print areas on all-over and DTF blanks.
- `/mockup-generator/printfiles` is **store-scoped** despite serving global data.
- Variant `color` is **nullable** on all-over garments, despite the docs typing it
  as a string. Normalized to the label `"Default"` — see `UNNAMED_COLOR`.

## 2b. Catalog cache — DONE

`scripts/sync-catalog.ts`, run 2026-08-11 over categories 6, 7, 8, 9 (men's and
women's shirts and hoodies).

| | |
|---|---|
| Blanks | 167 |
| Variants | 7,859 |
| Colors | 1,275 |
| Print areas | 714 |
| Incomplete blanks | 0 |
| Blanks with no print areas | 0 |
| Variants with invalid cost | 0 |
| **Enabled blanks** | **0 — nothing is seller-visible yet** |

Top brands: Bella + Canvas (24), Stanley/Stella (18), AS Colour (13), Gildan (11),
Cotton Heritage (10), Comfort Colors (10). 28 blanks are Printful's own unbranded
goods.

The script is idempotent. Variants are upserted rather than replaced, because
`product_variants` references them `ON DELETE RESTRICT` — deleting one a seller had
already built on should fail, and does. Colors and placements are replaced wholesale.

To make blanks sellable, re-run with `--enable` or flip `is_enabled` per blank. Do
that deliberately: it is the difference between a curated catalog and 167 options
in front of someone starting their first clothing label.

## 2c. Next.js scaffold — DONE

Next 16.3 / React 19.2 / Tailwind 4, App Router, TypeScript strict.
`npm run build` and `npm run typecheck` both pass.

Dependencies: core, plus Sharp (step 4) and Stripe (step 5), each added when its
step arrived rather than up front.


| Command | |
|---|---|
| `npm run dev` | dev server — storefront at `demo.localhost:3000` |
| `npm run build` | production build |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | unit tests (`node:test` via tsx — no test framework dependency) |
| `npm run verify:rls` | proves tenancy + money boundaries against the real database |
| `npm run curate` | bulk enable/disable catalog blanks |
| `npm run sync:catalog` | catalog sync — `-- --categories=6,7 --limit=5` |
| `npm run seed:demo` | rebuild the demo store |
| `npm run order:dry-run` | price a real order through Printful, nothing created |
| `npm run pricing:model` | compare pricing models across seller prices |
| `npm run checkout:test` | full checkout with a Stripe test card |
| `npm run webhook:test` | 15 checks against the running webhook route |
| `npm run retry:test` | recovery of orders paid but never submitted |
| `npm run payout:test` | Connect onboarding and the payout run |
| `npm run drop:test` | reservations, capture at threshold, release when short |
| `npm run launch:walkthrough` | drives all 8 launch steps end to end |

Storefront theming is via CSS custom properties in `app/globals.css`, injected
per-store from `stores.theme`. One compiled stylesheet serves every seller; there
is no per-store Tailwind build.

`next.config.ts` allows remote images from `files.cdn.printful.com` and
`*.supabase.co` only.

## 3. Storefront rendering — PARTIAL

Server-rendered. `npm run build` reports `/s/[host]` and `/s/[host]/p/[slug]` as
`ƒ (Dynamic) server-rendered on demand`, which is the requirement — PROJECT.md
needs crawlable HTML for sellers who have no audience.

| File | |
|---|---|
| `proxy.ts` | Host → `/s/[host]` rewrite. **Next 16 renamed Middleware to Proxy**; `middleware.ts` is the old convention |
| `lib/store/resolve.ts` | Host parsing and store lookup, request-deduped |
| `lib/store/products.ts` | Storefront reads, publishable key only |
| `lib/supabase/client.ts` | `publicClient()` (RLS) vs `serviceClient()` (bypasses RLS) |
| `app/s/[host]/` | Layout with theme injection, product grid, PDP |
| `scripts/seed-demo.ts` | One demo store on a real blank — `npm run seed:demo` |

Verified against a running server:

| Host | Result |
|---|---|
| `demo.localhost` | 200, renders store, product, `$32.00` |
| `demo.localhost/p/first-tee` | 200, real `<title>`, og:title/description/image, colors, sizes |
| `nosuchstore.localhost` | 404 |
| `localhost` | marketing page, not rewritten |
| `app.localhost` | reserved, not rewritten |
| store set to `draft` / `suspended` | 404 — visibility comes from RLS, not app code |

**Proxy does no database work.** Pure string parsing only; the Next 16 docs are
explicit that this layer is not for data fetching. Store resolution happens in the
server component where it can be cached and a miss can render a real 404.

**Theme is CSS custom properties** injected from `stores.theme`, filtered against
a character allowlist — that column is seller-controlled jsonb, and spreading it
into a style attribute unfiltered is CSS injection.

Not built: cart, checkout, custom-domain verification, image optimisation beyond
`next/image` defaults, size ordering (sizes currently sort alphabetically, so XS
lands after L).

**Open: cache invalidation on store activation.** Store status changes need to
invalidate the resolver cache, or a seller who launches keeps seeing their own
404 for a while. Seen in dev as a stale 404 after flipping status back to active.

## Tooling — DONE

Built so that the checks and bulk operations survive the session they were written
in. All zero-dependency: tests use built-in `node:test`, scripts share `_env.ts`.

**`npm test`** — 28 tests over money conversion, status mapping, dark-colour
detection and size ordering. These pin corrections that were made against the live
API and contradict Printful's documentation; without tests they are one
"helpful fix" away from being reverted.

**`npm run verify:rls`** — seeds two sellers with real orders, signs in as each,
and checks isolation, money-write refusal, and the cost-basis grants. Removes
everything it creates. Current result: **15 pass, 0 fail** (verified after 0002
was applied on 2026-08-11). Re-run it after any migration touching policies or
grants.

**`npm run curate`** — bulk enable/disable of catalog blanks by brand, model, id,
decoration, cost ceiling or colour count. Dry-run by default; nothing writes
without `--apply`. `--starter` selects a defensible first catalog (DTG-printable,
8+ colours, under $22, max 2 per brand, capped at 12). Previewed and deliberately
**not applied** — which blanks to sell is a product decision.

**Size ordering fixed.** `lib/size.ts` gives sizes a canonical order, so pickers no
longer show XS after L. Handles the XXL/2XL duplication, numeric sizes, and keeps
unrecognized labels visible rather than dropping them.

**`PRINTFUL_WEBHOOK_SECRET` generated** — 32 random bytes, in `.env.local`.

## 5a. Order pipeline — PARTIAL (vendor leg done, payment leg not started)

`lib/orders/pipeline.ts` — order → vendor submission, service-role only.
`npm run order:dry-run` prices a real order through Printful's live estimator
without creating anything or moving money.

The original gate ("do not start 5 until a real order is placed") was
**superseded 2026-08-11 by decision** and re-drawn in PROJECT.md. Writing the
pipeline moves no money; accepting a real customer payment does. The gate now
reads: *do not accept a real customer payment until one real vendor order has
been placed and manufactured.*

Built: idempotent submission keyed on `orders.idempotency_key`, fulfillment
records with attempt counts and classified errors, retry scheduling, and
`recordSellerMargin` writing a net-14 ledger entry on delivery (idempotent on
order+kind, so running twice cannot pay twice).

Not built: Stripe, capture, refunds, the retry worker itself.

### Two findings from the first dry run

**Printful caps order `external_id` at 32 characters.** Undocumented; found by
binary-searching the length. `idempotency_key` defaulted to
`gen_random_uuid()::text`, which is 36 because of hyphens, so *every* order
submission would have failed — and Printful reports it as "Invalid External ID
specified", which sends you looking at the format rather than the length. Fixed
in `0004`, plus a guard in the adapter that fails with an accurate message.

**The current economics lose money on every order.** Real numbers from the dry
run, on a Bella + Canvas 3001 priced at $32:

| | |
|---|---|
| Customer pays | $32.00 |
| Printful charges us | −$16.86 (blank $11.69 + shipping $4.75 + tax) |
| Seller earns | −$15.31 (retail − base − fee) |
| **We keep** | **−$0.17** |

Nothing covers shipping. Seller margin is computed as `retail − base_cost − fee`,
which ignores the ~$4.75 we pay to ship. The $32 price and $5 fee are demo
values, but the structure is wrong at any price: shipping is a real cost with no
line item. **Sidelined — needs a business decision.** See "Open decisions".

## 5. Payments — PARTIAL

Checkout and the webhook are built and verified against Stripe test mode.
**Not built: Connect Express onboarding, transfers, payouts, refunds-on-demand,
the retry worker.**

| | |
|---|---|
| `lib/stripe/client.ts` | Pinned API version; server-only |
| `lib/orders/checkout.ts` | Cart → priced order → PaymentIntent |
| `lib/orders/payment.ts` | Handlers for succeeded / failed / dispute / refund |
| `app/api/webhooks/stripe/route.ts` | Verify → record → act |
| `npm run checkout:test` | Real test-card checkout, end to end |
| `npm run webhook:test` | 15 checks; signs payloads with the real secret |

Verified on real runs: customer pays $36.75, seller earns $14.00, we keep $4.94
(before vendor tax); the stored total matches the quote; `transfer_data` is
absent; a duplicate event does not produce a second fulfilment; a charge for the
wrong amount refuses to fulfil.

**`FULFILLMENT_LIVE` defaults to false.** Printful has no sandbox — a submitted
order is a real garment really charged to us. Without this guard, testing the
payment path end to end would place a real order. Flip it deliberately, once.

**Deferred by decision, do not re-raise as reminders:** the Printful resale
certificate (worth 42c/order) and the merchant-of-record question. Both known,
both the user's to action on their own timeline.

## 5b. Payouts — PARTIAL

`lib/payouts/` — Connect Express onboarding and the payout run.
`npm run payout:test` (11 checks).

**The ordering is the safety argument.** Record the payout → CLAIM the ledger
entries by stamping `payout_id` → only then create the Transfer. A crash mid-run
leaves money unsent, which is recoverable; transfer-first-record-after leaves
money sent and unrecorded, which pays twice on the next run and cannot be undone.
Claiming filters on `payout_id is null`, so a concurrent run cannot pay for
entries it does not own.

**A failed transfer releases the claim.** Verified. Without it a transient Stripe
error would strand a seller's earnings permanently with nothing marked wrong.

Guards verified: payouts held on a disputed store; incomplete onboarding;
balances under the $10 minimum rolling forward; negative balances after clawback.

Express accounts, not Standard — Stripe hosts identity and bank collection so we
never touch either. `transfers` capability only; every charge belongs to the
platform account.

**Not verified: onboarding and a successful transfer.** Connect is not enabled on
the Stripe account (`dashboard.stripe.com/connect`). The test reports this as a
skip rather than a pass it did not earn.

Noted for later: Stripe's SDK now recommends Accounts v2 for new Connect
integrations. v1 is what is built and works; migrate deliberately.

## 5c. Retry worker — DONE

`lib/orders/retry.ts` + `/api/cron/retry-fulfillments`, every 10 minutes.
`npm run retry:test` (10 checks).

Sweeps two failure shapes. The obvious one is a vendor call that failed and left
a retry time. The dangerous one is a **paid order with no fulfillment row at
all** — the webhook died between recording payment and attempting submission, so
nothing anywhere is marked broken.

Backoff 10m → 30m → 2h → 6h → 24h, front-loaded because most failures are
transient and a customer is waiting. `auth` and `validation` escalate at once;
they fail identically forever.

The decision is a **pure function** (`decideRetry`) with its own unit tests,
because `FULFILLMENT_LIVE` is false in every environment safe to test in — an
end-to-end sweep short-circuits to "blocked" before backoff is ever reached.

## 7. Drops and reservations — PARTIAL

`lib/drops/resolve.ts` + `/api/cron/resolve-drops`, hourly.
`npm run drop:test` (14 checks, real Stripe test mode).

**"Auto-refund below threshold" is two different operations.** A reservation that
never met threshold was AUTHORISED, not charged — cancelling releases the hold,
so nothing appears on the customer's statement. A refund means they were charged,
saw it, and wait days for it back. For someone buying from an unknown brand that
is the difference between "nothing happened" and "that was sketchy". The code
cancels; it only refunds an order somehow already captured.

Captures as soon as the threshold is met rather than waiting for `closes_at` —
Stripe authorisations lapse after about a week.

A declined card at capture cancels that one order rather than aborting the drop.
A vendor submission failure likewise does not abort the loop; the retry sweep
owns it.

Not built: any seller or storefront UI for drops.

## 4. Design upload and mockups — PARTIAL

`lib/design/validate.ts` — artwork checked against the print areas and minimum
DPI the catalog sync pulled from the vendor. Errors block, warnings do not; low
resolution is reported with both escape routes (print smaller, up to a stated
size, or supply this many pixels). The design step reads the real bytes rather
than trusting client-reported dimensions.

`lib/mockup/composite.ts` — displacement map, mask, multiply, per PROJECT.md.
Sharp has no displacement operator, so that step works in raw pixel space.
Edges clamp rather than wrap. `over` blend is available for dark garments, where
real DTG prints over a white underbase and multiply would erase the ink.
13 tests, including that ink cannot escape the mask onto a collar or sleeve.
`npm run mockup:sample` renders flat versus displaced side by side.

**BLOCKED ON ASSETS, not on code.** A real template needs three files per blank:
a photograph of the garment, a mask that is white where the print goes, and a
greyscale map of the folds. That is photography and retouching.

Interim alternative: Printful generates mockups itself — `capabilities()`
reports `vendorMockups: true` — which needs no assets but is async and rate
limited, so it suits catalogue imagery rather than a live design tool.

---

## Environment

| Thing | State |
|---|---|
| Supabase project | `aktehepmvbaxuidpdzjh`, migration applied |
| Supabase keys | in `.env.local` (gitignored) |
| Printful token | in `.env.local`, account-level, **compromised — rotate before launch** |
| Printful stores | 1, `id=18599319`, type `native` |
| `PRINTFUL_WEBHOOK_SECRET` | **empty** — generate before configuring webhooks |
| Next.js app | does not exist |
| Git repo | not initialized |

---

## Open decisions

- **Who pays for shipping.** The largest open question, and it invalidates the
  current unit economics until answered. Printful charges ~$4.75 shipping per
  US order on top of the blank. Nothing in the model covers it. Options:
  charge the customer shipping on top of retail; fold an allowance into the
  platform fee (raising it from ~$5 to ~$10, which changes the pitch); compute
  seller margin as `retail − vendor_total − fee` so the seller absorbs it; or
  offer free shipping above a threshold. Each changes what a seller is told
  their margin is, so it should be settled before the launch path's pricing step
  is built.

- **`scripts/sync-catalog.ts` still uses plain `fetch` against PostgREST.**
  `@supabase/supabase-js` is now installed, so the script can be migrated. Only
  the `db` helper is affected. Low priority — it works.
- **All-over printing has no `DecorationMethod`.** `DIRECT-TO-FABRIC` ("All-over
  cotton", 21 blanks) is dropped, so those blanks are hidden. Bringing them back
  means adding `all_over` to `DecorationMethod` in `types.ts` **and** to the
  `decoration_method` enum in the migration. Both additive.
- **Print areas are per-placement, not per-technique.** `PlacementSpec` records one
  print area per placement; the default technique wins. A seller choosing a
  non-default technique may see slightly wrong dimensions.
- **The 21-day launch sequence is undefined.** Only the 8 steps PROJECT.md names
  are seeded, with placeholder day numbers.

## Resolved

- Multiple Printful stores under one account: **works**. Store-per-seller is the
  design; no shared-store fallback needed. Confirmed by Printful support
  2026-08-11: the Free plan allows *unlimited stores* and up to 10 "Quick Stores";
  Growth allows unlimited of both.

  > CAVEAT, unconfirmed: we use "Manual orders / API platform" stores, which
  > should fall under *unlimited stores* rather than the Quick Store cap. If API
  > platform stores do count as Quick Stores, the Free plan caps us at 10 sellers
  > and the plan has to change before the pilot grows. Ask Printful to confirm
  > which bucket an API platform store falls into.
  >
  > Also note the one existing store (`18599319`) is type `native`, not an API
  > platform store. Seller stores must be created as the latter.
- Token access level: **account-level**, verified empirically.

## Deployment — LIVE (partially configured)

**https://commit-store-xuav.vercel.app** — Vercel project `commit-store-xuav`,
deploying from GitHub `myst0509/commit-store` (private), branch `main`.

Verified working: the marketing page renders, and `/api/dashboard` returns
`{"error":"Sign in to continue"}` — the API is live and refusing unauthenticated
requests.

Still outstanding:

- [ ] **Stripe webhook.** Not created. Add an endpoint at
      `https://commit-store-xuav.vercel.app/api/webhooks/stripe` in the
      **LifeBoat sandbox**, subscribe to the five events in DEPLOY.md, then set
      `STRIPE_WEBHOOK_SECRET` in Vercel to the `whsec_` it generates and
      redeploy. It is currently a placeholder, so every webhook is rejected.
- [ ] **`NEXT_PUBLIC_ROOT_DOMAIN`** — confirm it is set to the Vercel host.
- [ ] **External scheduler.** `vercel.json` runs `/api/cron/tick` once daily,
      which is all the Hobby plan allows. The retry sweep needs to run every ten
      minutes to be worth having. Point cron-job.org at the same URL with
      `Authorization: Bearer <CRON_SECRET>`.
- [ ] **Delete the duplicate `commit-store` Vercel project.** Two projects on
      one repo both rebuild on every push and both need env vars kept in sync.
- [ ] **Storefronts need a real domain.** `*.vercel.app` cannot be wildcarded,
      so seller subdomains have nowhere to live yet.

**Campus network note:** UC Riverside's network resets connections to
`*.vercel.app`, so the deployment is unreachable from campus. It works from
other networks. Local development on `localhost:3000` is unaffected.

## Chores

- [x] **`0002_hide_cost_basis.sql` applied** 2026-08-11. Vendor cost is no longer
      readable by anon; the base/fee split is no longer readable by sellers;
      `seller_cost_cents` is. Storefront reads verified still working afterward.
      Note: `select('*')` on `catalog_variants` / `product_variants` now fails
      for anon and authenticated by design — name the columns.
- [x] **`0004_vendor_safe_idempotency_key.sql` applied** 2026-08-11 and verified:
      the column default now produces a 32-character key, and a 36-character
      value is rejected by the constraint.
- [ ] Rotate the Printful token (exposed in chat during development)
- [x] `drop table notes;` — done, Supabase starter leftover removed
- [x] Generate `PRINTFUL_WEBHOOK_SECRET` — done, 32 random bytes in `.env.local`
- [x] `git init` — initial commit `cd9647a`. No remote configured yet.

## Waiting on the user — do NOT raise these as reminders

Acknowledged and deliberately deferred. Record status if asked; do not prompt.

- **Printful resale certificate.** Worth ~42c per order. Takes time to file.
- **Merchant-of-record question with Printful.** The largest unhedged
  assumption in the project, and the user is aware of it.
- **Enable Connect** at `dashboard.stripe.com/connect` — blocks payout testing.
- **The first real Printful order** — blocks live charges.

## Sidelined — needs a decision or a second pair of eyes

Raised deliberately rather than guessed at:

- **Curating the starter catalog.** `npm run curate -- --enable --starter --apply`
  is ready and previewed (Comfort Colors 1717, Gildan 5000/64000, Bella + Canvas
  3413, Stanley/Stella STTU169, Next Level 6210 and similar). Which blanks a brand
  is built on is merchandising, not engineering.
- **Cart and checkout.** Gated on a real vendor order per PROJECT.md. Building a
  buy button before a garment has ever been manufactured is the exact failure the
  build order exists to prevent.
- **Cache invalidation on store activation.** A seller who flips their store live
  may keep seeing their own 404. The fix depends on a caching strategy that has
  not been chosen, and choosing wrong means stale storefronts platform-wide.
- **Custom domain verification.** Needs a DNS ownership-proof design.
- **The remaining 13 launch-path days.** Product direction, not code.
- **All-over printing.** Still hidden. Un-hiding it means adding `all_over` to
  `DecorationMethod` *and* the `decoration_method` enum — an interface change plus
  a migration, on a surface with real money attached.
- **`scripts/sync-catalog.ts` still uses raw `fetch`.** Now that
  `@supabase/supabase-js` is installed it could use the client, but the script
  works and rewriting a proven catalog writer for tidiness is a poor trade.

## Still unanswered by the vendors

- **Printful:** do their terms permit acting as merchant of record for third-party
  sellers? Unasked, and it is load-bearing for the entire business model.
- **Apliiq:** API returns 500 on everything. Unusable until they respond.
- **Both:** whether any idempotency guarantee exists on order creation.
