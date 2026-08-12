# Progress

Living status of the build. Update it when something lands — this file is the
only memory that survives between sessions.

**Last updated:** 2026-08-11

Legend: `DONE` verified working · `PARTIAL` built, not fully proven · `TODO` not started · `BLOCKED` waiting on something

---

## Build order (from PROJECT.md)

| # | Step | Status |
|---|------|--------|
| 1 | Schema + RLS | **DONE** |
| 2 | Fulfillment interface + Printful adapter | **PARTIAL** — no live order yet |
| 2b | Catalog cached into Postgres | **DONE** |
| 2c | Next.js scaffold | **DONE** |
| 3 | Storefront rendering (subdomain routing, theme, PDP) | TODO — unblocked |
| 4 | Design upload + mockup compositing | TODO |
| 5 | Stripe Connect + checkout + order pipeline | TODO — gated on step 2 |
| 6 | Launch path | TODO |
| 7 | Drops and reservations | TODO |

PROJECT.md gates step 5 on step 2 being proven end to end with a real order.
That gate has **not** been cleared.

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

Approved dependency set is deliberately small — core only. **Sharp (step 4) and
Stripe (step 5) are not installed**; add them when their steps arrive rather than
up front.

| Command | |
|---|---|
| `npm run dev` | dev server |
| `npm run build` | production build |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run sync:catalog` | catalog sync — `-- --categories=6,7 --limit=5 --enable` |

Storefront theming is via CSS custom properties in `app/globals.css`, injected
per-store from `stores.theme`. One compiled stylesheet serves every seller; there
is no per-store Tailwind build.

`next.config.ts` allows remote images from `files.cdn.printful.com` and
`*.supabase.co` only.

## 3–7 — not started

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
  design; no shared-store fallback needed. (Confirmed 2026-08-11.)
- Token access level: **account-level**, verified empirically.

## Chores

- [ ] Rotate the Printful token (exposed in chat during development)
- [ ] `drop table notes;` — leftover from Supabase's starter, publicly readable
- [ ] Generate `PRINTFUL_WEBHOOK_SECRET`
- [ ] `git init` — nothing is under version control yet

## Still unanswered by the vendors

- **Printful:** do their terms permit acting as merchant of record for third-party
  sellers? Unasked, and it is load-bearing for the entire business model.
- **Apliiq:** API returns 500 on everything. Unusable until they respond.
- **Both:** whether any idempotency guarantee exists on order creation.
