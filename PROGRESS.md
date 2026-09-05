# Progress

Living status of the build. Update it when something lands — this file is the
only memory that survives between sessions.

**Last updated:** 2026-08-19 · 161 unit tests + 50 integration checks

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

## 2d. Apliiq adapter — PARTIAL (catalog verified, order path unproven)

`lib/fulfillment/apliiq.ts`, registered in the provider registry 2026-08-19.
Auth in `lib/fulfillment/apliiq-auth.ts`; 27 unit tests.

**Verified against the live API:**

| | |
|---|---|
| Blanks returned | 1,521 |
| Usable (colours + decoration + a mapped placement) | 913 |
| Decoration methods | dtg, dtf, screen_print, embroidery, applique, sublimation |
| Blanks with no mapped placement | 25 |
| Variants with a bad cost | 0 |

`listBlanks`, `getBlank` and `listVariants` all work end to end. Their whole
catalog is one ~15MB response — no pagination, no per-product endpoint — so it
is fetched once and cached per instance.

**Two things their catalog does not have, and Printful does:**

- **No print dimensions.** `Locations[].DesignBox` is empty across all 1,521
  products, so `PlacementSpec` is emitted as zeroes meaning *unknown*. This
  found a real bug: `validateAgainstPlacement` divided by that zero, got
  `Infinity`, and `Infinity < minDpi` is false — so **every design passed**. A
  missing spec had silently become an unlimited one. Fixed: unknown dimensions
  now refuse with `unknown_print_area`. **Solvable as of 2026-08-19**: print
  areas come from the mockup templates we create, not from their API. See the
  template answer below.
- **No colour hex.** `isDark` is inferred from the colour name, which is what
  the DTG-on-darks rule runs on. Weaker than Printful's hex, and worth knowing.

### Apliiq answered, 2026-08-19

Four questions, four answers, and one of them is worth a lot.

**Idempotency is real.** *"If the id + order_number is the same, no new order is
submit to the system."* `buildOrderPayload` sets `id`, `number` and
`order_number` to the same deterministic integer derived from our order id, so
a retry cannot duplicate a garment. A test pins that identity: change one field
without the others and the guarantee dies silently. They also asked for a
minimum 3-5 second gap between retries; our backoff starts at 10 minutes.

**No order status webhook exists at all.** Confirmed, not merely undocumented.
Status must be polled through `getOrder`. `parseWebhook` still throws, which is
now the stronger answer rather than the cautious one: anything arriving there
did not come from Apliiq.

**A shipping cost endpoint exists but is undocumented.** They said to check back
the week of 2026-08-24. That is `quoteShipping` and `estimateCost`, both of
which currently throw.

**Print dimensions are still missing.** They pointed at `GET /v1/product/{id}`,
which does populate `DesignBox` where the bulk endpoint leaves it empty. But
verified across eight products spread through the catalog: the boxes carry
`{BoxId, Name}` and **no width, height or DPI anywhere**. Most names are blank;
only occasionally is one meaningful ("Left Chest", "Right Chest", "Box 1").

So the per-product endpoint was not worth wiring in: it costs a request per
blank and adds no measurement. **Design validation for Apliiq blanks stays
blocked**, and this needs asking again more specifically.

### The constraint that actually matters, 2026-08-19

Following up on print dimensions produced something bigger than dimensions.
Apliiq support, verbatim:

> "there isn't any positioning available in API for you to supply the
> placement. One suggestion is use mockup template id field to supply a mockup
> template you create in your account (design like normal with a sample artwork
> - could be blank / white artwork) and re-use it as a mockup template"

**Their API cannot be told where to put a design.** Placement is not a missing
field, it is not part of their model. The flow is template-first: build a
mockup template by hand in the Apliiq account, then reference it by id.

This is why `uploadArtwork` and `createProduct` throw. Not "endpoint not
found" — `ArtworkUpload` carries a `placement`, and that contract cannot be
expressed against their API at all.

**ANSWERED 2026-08-19: templates are reusable, and Apliiq is viable.** Their
support, on whether one template can serve many different designs:

> "Yes, you can use the template design as mockup template id and provide a
> different artwork (preferable same dimension expected for most predictable
> outcome and artwork should be 300 DPI ideally)"

and on the approach of a small fixed set of templates:

> "that is the correct approach with mockup template. Setting up a set of
> templates with various size and placement would allow you to learn the most
> accurate cost from our tool."

So the shape is: build a template library once, by hand, covering the garments
and positions we offer. Each order references a template id and supplies the
seller's artwork. No human in the loop per design. Self-serve works.

**This also solves the print dimensions problem, from the other end.** We could
not get print areas out of their API — but we do not need to, because *we*
create the templates. The placeholder artwork we design each template with
defines its print area, so we know the width, height and DPI because we chose
them. The numbers become our configuration rather than their data.

That turns `PlacementSpec` for Apliiq from zeroes-meaning-unknown into real
values, and unblocks design validation for their blanks.

**Their stated artwork expectations:** same pixel dimensions as the template's
placeholder for the most predictable result, and 300 DPI. Note that is double
the 150 DPI `REFERENCE_FRONT` uses for the pre-blank check in the launch path.

### What Apliiq needs next, in order

1. **Create the templates by hand** in the Apliiq account: a placeholder design
   per garment and position we intend to offer, at a deliberate pixel size.
   Nothing can be built until these exist, and their ids and dimensions are
   what the registry below records.
2. **Ask for the exact payload.** Still unknown: which field carries the mockup
   template id, and how the artwork is supplied alongside it. "Mockup template
   id field" is all we have. Without it `uploadArtwork` and `createProduct`
   stay throwing.
3. **Build a template registry** — `(blankExternalId, placement) -> {templateId,
   widthIn, heightIn, minDpi}` — and emit `PlacementSpec` from it.

Steps 1 and 2 are prerequisites, and 2 is worth asking now since it is another
round trip with them.

Also from the same reply:

- **No other endpoint carries print dimensions.** Adding them to `DesignBox` is
  "a possible request". They are checking whether a reference table of print
  area sizes exists.
- **`DesignBox` naming confirmed.** An empty `Name` means the garment has a
  single default print area. Numbered boxes ("Box 1".."Box 4") appear where
  there are several, for example the front of shorts or pants.

**Seven methods throw rather than guess.** `uploadArtwork`, `createProduct`,
`deleteProduct`, `quoteShipping`, `estimateCost`, `cancelOrder` and
`parseWebhook` have no published endpoint. Each throws a `FulfillmentError`
naming what to ask Apliiq for. Guessing a path buys a silent 404 at the moment
an order needs making.

**`submitOrder` is written from their published schema and has NEVER RUN.**
Same status as Printful's. Two impedance mismatches handled in code:

- Their order `id` is an integer; ours is a uuid. Mapped through a
  deterministic FNV-1a hash so a retry is the same number, which Apliiq
  confirmed is what makes it idempotent. See the answers above.
- Their shipping code is `upgraded` where ours is `expedited`.

**CAUTION: `routeForProduct` prefers Apliiq for private label**, and its
`quoteShipping`/`estimateCost` throw. Nothing reaches them today because no
product sets `privateLabel` — do not enable private-label products until those
endpoints exist.

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
| **Enabled blanks** | **12** — the `--starter` set, applied 2026-08-16 |

Top brands: Bella + Canvas (24), Stanley/Stella (18), AS Colour (13), Gildan (11),
Cotton Heritage (10), Comfort Colors (10). 28 blanks are Printful's own unbranded
goods.

The script is idempotent. Variants are upserted rather than replaced, because
`product_variants` references them `ON DELETE RESTRICT` — deleting one a seller had
already built on should fail, and does. Colors and placements are replaced wholesale.

To make blanks sellable, re-run with `--enable` or flip `is_enabled` per blank. Do
that deliberately: it is the difference between a curated catalog and 167 options
in front of someone starting their first clothing label.

**The starter catalog was applied 2026-08-16** — 12 blanks enabled, verified
with `npm run curate -- --list`:

| | |
|---|---|
| Gildan | 5000 ($9.25), 64000 ($9.44) |
| Printstar | 00085-CVT ($9.75) |
| Next Level | 6210 ($11.25) |
| Bella + Canvas | 3001 ($11.69), 3413 ($17.95) |
| Stanley/Stella | STTU169 ($13.95), SATU001 ($15.60) |
| Comfort Colors | 1717 ($15.29), 9360 ($18.07) |
| Cotton Heritage | MC1790 ($16.29) |
| AS Colour | 5001 ($18.95) |

Eight brands, $9.25–$18.95, all DTG-printable. Reversible with
`npm run curate -- --disable --all --apply`, then re-enable what you want.

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
| `npm run apliiq:probe` | one signed Apliiq request; prints a redacted sample |

Storefront theming is via CSS custom properties in `app/globals.css`, injected
per-store from `stores.theme`. One compiled stylesheet serves every seller; there
is no per-store Tailwind build.

`next.config.ts` allows remote images from `files.cdn.printful.com` and
`*.supabase.co` only.

## 3a. Public site and store directory — TODO (belongs in THIS repo)

Direction given 2026-08-19: a public homepage greeting visitors, listing new
and popular stores, plus intro pages explaining the platform before anyone
signs up. Sign in and sign up sit top right and hand off to the dashboard.

**Decided 2026-08-19: built in Lovable for now** (prompt 9), with the tradeoff
understood. Porting it to server-rendered here is a pre-launch task. There is
no domain and no customers yet, so nothing is lost today; what would be lost is
crawlability, and that only matters once the site is findable.

The reasoning for why it eventually belongs here still stands. LOVABLE.md keeps storefronts here
because PROJECT.md needs crawlable HTML for sellers who start with no audience.
The marketing homepage is the most SEO-critical page on the platform and a
store directory is exactly the kind of page search should index, so both belong
in this repo, server-rendered, next to `/s/[host]`.

The split, so it stays clear:

| Surface | Where | Why |
|---|---|---|
| Marketing home, intro pages, store directory | this repo | public, SEO |
| Seller storefronts `/s/[host]` | this repo | public, SEO |
| Everything behind sign-in | Lovable | authenticated, no SEO need |

**`GET /api/stores` is built** (2026-08-19) and serves whichever surface needs
it. Read through the ANON client so RLS decides visibility — `public reads
active stores` and `public reads published products` already say the right
thing. A store appears only if it is active AND has a published product, since
sending a visitor to an empty storefront is worse than a shorter list.

Verified against the live database as an anonymous visitor: 1 store visible
(Demo Brand), and the draft store correctly invisible.

**`topEarners` ranks on real seller earnings and publishes no amounts.**
Decided 2026-08-19: show who is earning most, never how much.

Summed from `ledger_entries` where `kind = 'seller_margin'`, signed so a
clawback pulls a store down rather than up. Only `rank` crosses the boundary —
no totals, no counts, no currency — so a viewer cannot tell whether first place
earned ten dollars or ten thousand, nor the gap between any two.

**This is a deliberate service-role exception**, the only one in a public
route. `ledger_entries` is invisible to anonymous readers by design and must
stay so; ranking on it needs a cross-tenant aggregate, which is exactly what
RLS exists to prevent. It is computed inside `rankByEarnings` and the money
never leaves that function. `newest` still goes through RLS as normal.

**The leaderboard stays empty below five qualifying stores.** A ranking hides
the amounts but not the order, and a top five drawn from six stores tells
everyone who is last. With two stores it is simply publishing which seller is
doing better. Stores that have earned nothing are left out entirely rather than
ranked last.

**Open: sellers have not agreed to being ranked publicly.** If that becomes a
concern the fix is an opt-out flag on the store, not a change to the ranking.

**Live and verified 2026-08-19**, all through the VPN:

| | |
|---|---|
| `/`, `/how-it-works`, `/stores` | 200 |
| `/api/stores` unauthenticated | 200, no token needed |
| CORS from the published origin | `Access-Control-Allow-Origin` present |
| `newest` | 1 store (Demo Brand), real cover image from the Printful CDN |
| `topEarners` | `[]`, correct below five qualifying stores |

**The `url` field is currently unusable and structurally so.** `rootDomain()`
reads `NEXT_PUBLIC_ROOT_DOMAIN`, which is set to the Vercel host, so store
links come back as `https://demo.commit-store-xuav.vercel.app`. Vercel cannot
wildcard `*.vercel.app` at all — `isStorefrontHost` already refuses those hosts
for exactly this reason — so that address can never resolve, not merely does
not yet. Store cards must stay unlinked until a real domain exists.

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

**Seller-facing errors use `UserError` (`lib/errors.ts`).** Throw it when the
message is written for the person who caused it; `errorResponse` returns it
verbatim as a 400. Throw a plain `Error` for anything that is ours — a bug, a
missing env var, a vendor fault — and it becomes a generic 500.

This replaced a keyword regex that guessed from the message text, which failed
open: naming a brand "XO" answered "Something went wrong" because the list held
"too small" and not "too short". Fourteen good messages were swallowed the same
way. **Do not reintroduce message-sniffing** — `tests/errors.test.ts` fails if
someone does.

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
`npm run payout:test` (14 checks, all passing against test-mode Connect).

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

**Connect enabled 2026-08-16.** `npm run payout:test` no longer skips: all 14
checks run and pass against test mode. Account creation is now verified for
real — an Express account is created, a second call reuses it rather than
duplicating, and payouts are correctly not enabled before onboarding (8
requirements outstanding).

**Still not verified: a successful transfer.** The only transfer the suite
attempts is the one it makes fail on purpose, to prove a failed transfer
releases its claim rather than stranding the money. That failure now arrives
as a real Stripe error — *"your destination account needs to have at least one
of the following capabilities enabled"* — because the test account is created
but never onboarded. Correct behaviour, and it exercises the recovery path, but
money has still never successfully moved to a seller.

A test payout was completed **by hand in the Stripe dashboard** on 2026-08-16
and worked. That confirms Connect and the `transfers` capability are correctly
set up on the account — but it goes around `runPayouts()`, so the
claim-before-transfer ordering, the `payout_id` stamping and the $10 floor are
still only proven against failures.

**`npm run payout:test` cannot close this gap on its own.** It creates a fresh
Express account (`payout-test.ts:55`) and deletes it again in the finally block
(`payout-test.ts:165`), and a brand-new account never has `transfers` active —
so its transfer is always going to fail. That is deliberate; the suite tests
the recovery path.

The procedure that would close it, using the flag already in the script:

1. `npm run payout:test -- --keep` — skips cleanup, so the connected account
   survives with its id still on the store.
2. Take that account through Stripe's hosted onboarding with test values.
3. `npm run payout:test -- --keep` again — `ensureConnectAccount` reuses the
   stored id (`connect.ts:42`) rather than creating a new one, so the transfer
   runs against an onboarded destination.

Until step 3 passes, no money has ever moved to a seller through our own code.

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

## Hosting — Hobby is not a legal option for this project

Checked against Vercel's own docs 2026-08-19.

> "the Hobby plan restricts users to non-commercial, personal use only"
> — vercel.com/docs/plans/hobby

Commit takes customer payments and pays sellers. That is commercial by any
reading, so **the free plan has to be left before launch**, independent of any
technical limit. Not urgent while nothing is live; not skippable either.

Corrections to things previously assumed:

- **Custom domains DO work on Hobby** — 50 per project. Pro is unlimited.
- **Wildcard domains have no documented plan gate**, but require Vercel's
  nameservers rather than a CNAME.
- Function duration is **not** a constraint: Hobby allows 300s.
- The comment in `app/api/cron/tick/route.ts` says Hobby allows two cron jobs
  once daily. The limits page now shows 100 per project with a footnote. Worth
  re-checking before relying on either number; the external-scheduler plan in
  DEPLOY.md sidesteps it regardless.

**Switching host does not fix the firewall problem** — a custom domain does,
on any host. Keep the two decisions separate.

The argument for staying on Vercel and paying for Pro is narrow but strong:
automatic TLS for unlimited per-seller custom domains. That is the hard part of
multi-tenant hosting, and self-hosting it means Caddy on-demand TLS plus Let's
Encrypt rate limits. Railway, Render or Fly running `next start` are otherwise
genuine alternatives — nothing in the code is Vercel-specific except the crons
in `vercel.json`, and Sharp needs a real Node runtime, which rules out
Workers-style platforms.

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
- [x] **Deleted the duplicate `commit-store` Vercel project** 2026-08-16. Both
      projects inherited `vercel.json`, so both scheduled `/api/cron/tick` at
      09:00 UTC — which is `PAYOUT_HOUR_UTC`. Two payout runs a day against one
      database. `commit-store-xuav` is the only project now.
- [ ] **Storefronts need a real domain.** `*.vercel.app` cannot be wildcarded,
      so seller subdomains have nowhere to live yet.

**Campus network note:** UC Riverside's network resets connections to
`*.vercel.app`, so the deployment is unreachable from campus. It works from
other networks. Local development on `localhost:3000` is unaffected.

## Frontend (Lovable) — PARTIAL

Built in a separate Lovable app against `/api`. Calm paper-and-green design,
unauthenticated visits redirect to sign-in, server error messages shown as-is.

| Screen | Status |
|---|---|
| Auth | **DONE** |
| Launch path | **DONE** |
| Designs | **DONE** |
| Dashboard home | **DONE** |
| Products | **DONE** |
| Drops | **DONE** |
| Order detail | **DONE** |
| Payouts | **DONE** |
| Store settings | **TODO** — prompt 5 did not land; `/settings` 404s |
| App shell / navigation | **DONE** — prompt 6 applied 2026-08-19 |
| Guide as home, store after launch | **DONE** — behaviour unverified, needs a signed-in look |
| Public homepage and directory | **DONE** — `/`, `/how-it-works`, `/stores` live |
| One home (drop duplicate `/launch`) | **TODO** — prompt 10 |
| Visual direction: vibrant, dark, forward | **TODO** — prompt 11 |
| New product + catalog browse | **DONE** — `/products/new` live |

All eight built as of 2026-08-16. Routes, verified live:

| Route | |
|---|---|
| `/auth` | sign in — there is no `/login` or `/signup` |
| `/launch` `/dashboard` `/designs` `/products` `/drops` | list screens |
| `/products/:id` `/orders/:id` | detail; no bare `/orders` index |
| `/settings/payouts` | **must stay at this path** — it is where Stripe returns |
| `/settings` | **404 — prompt 5 never landed.** The shell's nav links here,
  so it is a dead link in the built app. Re-run prompt 5. |
| `/products/new` | new product flow, live |

**`GET`/`POST /api/products` added 2026-08-19.** Before this the launch path's
price step was the only thing that could create a product, and it presents as a
completed rung of a sequence afterwards — so a seller could build exactly one
product and had no route to a second. The creation logic moved to
`lib/products/create.ts` and both callers share it, so the price floor and the
variant fan-out cannot drift between a seller's first product and their fifth.

Note the upsert keys on `(store_id, slug)`, so reusing a name edits the
existing product rather than making another. `POST` refuses a duplicate name
with a message saying so, rather than letting a seller wonder where their
product went.

**`/api/store` added 2026-08-19.** `GET` and `PATCH` for brand name, web
address and theme. Until it existed a store could only ever be named once, by
the launch path's first step, and `stores.theme` was read by the storefront and
written by nothing at all — so a seller had no way to change anything about
their own store.

The theme filter is now exported from `lib/store/resolve.ts` and imported by
`lib/store/settings.ts` rather than copied. When the write rule and the render
rule are two copies of one expression they drift, and the symptom is a seller
saving a colour, being told it worked, and seeing nothing on their storefront
with no error anywhere. `PATCH` replaces the theme rather than merging, which is
what makes "remove this colour" expressible.

API verified from the published origin the same day: all eight endpoints answer
`401 {"error":"Sign in to continue"}` unauthenticated, the CORS preflight
returns the right allow headers, an unlisted origin gets none, and **CORS
headers are present on error responses too** — without that, a 400 or 404 would
surface in the browser as a CORS failure instead of the message it carries.

Order matters: the launch path's `price` step creates a product with nowhere to
view it, and its `drop_date` step needs a `productId` it cannot currently pick.

### Signup created no store — found and fixed 2026-08-16

`create_store` (`lib/launch/actions.ts:81`) says *"the store row itself is
created before this by signup; this names it"* and only runs an `UPDATE`. There
was no signup trigger — nothing ever inserted the row. So a new user owned no
store, and `requireSeller` (`lib/auth/session.ts:71`) 404s without one. That
includes `/api/launch`, whose first step is the thing that was supposed to
create the store. Circular, and it blocked every seller who ever signed up.

Fixed by `0005_store_on_signup.sql`, applied 2026-08-16.

### The campus network, not the code — 2026-08-16

Separately and at the same time, every screen appeared to hang on an infinite
spinner. **That was the UCR network, and it cost a debugging session.** Measured
from the published frontend in a real browser:

| Host | Result |
|---|---|
| `commit-store-xuav.vercel.app` | **no response, aborted at 6s** |
| `aktehepmvbaxuidpdzjh.supabase.co` | 401 in 163ms |
| `commit-store.lovable.app` | 200 in 278ms |

The API host **hangs rather than failing**, so the frontend never gets an error
to display — it just waits. Verified fixed by loading the same app on cellular:
everything works.

Two things wrongly suspected during that session, recorded so they are not
chased again:

- **The frontend does NOT mishandle non-401 errors.** That was inferred from
  spinners which were actually unanswered requests. No evidence either way.
- **Designs was NOT wired directly to Supabase.** It only looked special
  because its upload goes browser → Supabase Storage by design
  (`app/api/designs/route.ts:11`), and Supabase was reachable while the API was
  not.

### Why it is blocked, and what fixes it — measured 2026-08-19

The block is on `*.vercel.app` specifically, at the **IP level**. Not DNS, and
not your app.

| Test | Result |
|---|---|
| `commit-store-xuav.vercel.app` (216.198.79.x) | **times out at TCP connect** |
| `nextjs.org` — Vercel-hosted, custom domain | **200** |
| `vercel.com` — custom domain | **200** |
| DNS for the blocked host | resolves correctly, no sinkhole |

DNS is fine and TLS is never reached: `curl` dies at `Trying …:443` before the
handshake, so packets to that range are being dropped silently. Dropped rather
than refused is exactly why the browser hangs forever instead of erroring.

**Two Vercel-hosted sites on custom domains pass the same firewall.** So the
filter is aimed at the free shared `*.vercel.app` hosting domain — a common
phishing and malware vector, which content filters categorise wholesale — and
not at Vercel or at us.

**A custom domain therefore fixes this outright**, for us and for any customer
on a similar network. This is no longer only about seller subdomains; it is
about whether the product is reachable at all from university and corporate
networks. Register early: some enterprise filters treat newly registered
domains as suspect for a period, so the reputation clock is worth starting
before launch rather than at it.

**Do not debug the frontend from campus without a VPN.** A VPN was set up on
2026-08-16 and resolves it completely — the API answers in under a second
through it, for the browser and for command-line tooling alike. Without one,
confirm against cellular before concluding anything is broken.

This still raises the priority of a real domain: `*.vercel.app` is unreachable
on this network, and a domain is needed for seller subdomains anyway.

Two things the frontend has to know and cannot infer:

- **There are no list endpoints** except `/api/drops`. Products and orders lists
  come out of `/api/dashboard`; only detail routes are per-id.
- **`APP_ORIGIN` is set in Vercel and deployed** (2026-08-16, commit `7f94b4e`).
  `POST /api/connect/onboard` only accepts a `returnUrl` starting with that
  value and otherwise falls back to `http://app.localhost:3000`, stranding a
  seller returning from Stripe. Renamed from `NEXT_PUBLIC_APP_URL` — it is read
  server-side only, so the prefix would have inlined it into the client bundle
  and pinned it at build time. The value is
  **`https://commit-store.lovable.app`**, confirmed 2026-08-16 — note
  `lovable`, not `loveable`.

## Chores

- [x] **`0002_hide_cost_basis.sql` applied** 2026-08-11. Vendor cost is no longer
      readable by anon; the base/fee split is no longer readable by sellers;
      `seller_cost_cents` is. Storefront reads verified still working afterward.
      Note: `select('*')` on `catalog_variants` / `product_variants` now fails
      for anon and authenticated by design — name the columns.
- [x] **`0004_vendor_safe_idempotency_key.sql` applied** 2026-08-11 and verified:
      the column default now produces a 32-character key, and a 36-character
      value is rejected by the constraint.
- [x] **`0005_store_on_signup.sql` applied** 2026-08-16. New signups now get a
      draft store, which nothing previously created.
- [ ] **Re-enable "Confirm email" in Supabase Auth before real sellers exist.**
      Turned off 2026-08-16 for development: Supabase's built-in auth mail is
      free but heavily rate-limited and not intended for production, so
      repeated sign-in testing silently stops receiving mail and reads as a
      broken login. With confirmation off, anyone can register an address they
      do not control — fine for our own test accounts, not fine live. The
      proper fix is custom SMTP (Resend/Postmark/SendGrid), which is needed
      for production anyway.
- [x] **Apliiq credentials rotated** 2026-08-19 — the originals were pasted into
      a chat during development. New pair verified working (`GET /v1/Product` 200).
- [ ] Rotate the Printful token (exposed in chat during development)
- [x] `drop table notes;` — done, Supabase starter leftover removed
- [x] Generate `PRINTFUL_WEBHOOK_SECRET` — done, 32 random bytes in `.env.local`
- [x] `git init` — initial commit `cd9647a`. No remote configured yet.

## Waiting on the user — do NOT raise these as reminders

Acknowledged and deliberately deferred. Record status if asked; do not prompt.

**Decided 2026-08-16: finish the frontend first.** Everything to do with live
keys, webhooks and real money is parked until the end of the project, on the
reasoning that keys and endpoints will change anyway by the time they matter.
Until then the work is building the four remaining screens correctly. Do not
re-raise the items below, or the Stripe webhook endpoint, as things to do now —
they are known, and their turn comes last.

- **Stripe webhook endpoint** not created; `STRIPE_WEBHOOK_SECRET` is still a
  placeholder, so webhooks are rejected in production. Parked by decision.
- **A successful transfer through `runPayouts()`** — the `--keep` procedure
  above. Parked; Connect itself is confirmed working.
- **The first real Printful order**, and live checkout. Parked, and gated.

- **Printful resale certificate.** Worth ~42c per order. Takes time to file.
- **Merchant-of-record question with Printful.** The largest unhedged
  assumption in the project, and the user is aware of it.
- ~~**Enable Connect** at `dashboard.stripe.com/connect`~~ — done 2026-08-16.
- **The first real Printful order** — blocks live charges.

## Sidelined — needs a decision or a second pair of eyes

Raised deliberately rather than guessed at:

- ~~**Curating the starter catalog.**~~ Applied 2026-08-16 — 12 blanks enabled.
  See the catalog section above for the list.
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

**Asked of Apliiq and awaiting reply (sent 2026-08-19):** whether one account may
submit orders for many independent sellers with us as merchant of record; current
rate limits on Order and Artwork, which their docs list as TBD; and whether a
partner or volume programme exists. The first of those is the same load-bearing
question still unasked of Printful.

- **Printful:** do their terms permit acting as merchant of record for third-party
  sellers? Unasked, and it is load-bearing for the entire business model.
- **Apliiq:** ~~API returns 500 on everything.~~ **Retracted and resolved 2026-08-19 — their
  API works.** Auth is an HMAC signature, and they return 500 rather than 401 for an unsigned
  request, so the "outage" was our own unauthenticated calls. Signed requests verified live:

  | Path | |
  |---|---|
  | `GET /v1/Order` | **200** |
  | `GET /v1/Product` | **200**, real catalog data |
  | `GET /api/Order` | 200 — appears to alias `/v1` |
  | `GET /v1/Fulfillment`, `/v1/Warehouse` | 404 — not those paths |

  Their docs are ambiguous about whether the signature is base64 or a hex digest (the
  algorithm says base64, the C# helper is named `...HexDigest`). **base64 is correct** —
  it returns 200. Paths are PascalCase and singular; `/orders` 404s.

  Adapter still unwritten. Only authentication is proven.
- ~~**Both:** whether any idempotency guarantee exists on order creation.~~
  **Apliiq answered 2026-08-19: yes**, on `id` + `order_number`. Printful still
  unanswered; there it is built on `external_id` plus a pre-flight lookup.
