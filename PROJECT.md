# Project context

Read this before writing code. It is the only context you have — assume no prior conversation.

## What this is

A free storefront platform for people starting independent clothing brands. No subscription, no
percentage cut. Revenue comes entirely from a markup on print-on-demand production cost.

Target user: someone with no audience, no money, and no web experience starting their first
clothing label. **Not** an established creator selling merch — that's Fourthwall's market and we
are deliberately not competing for it.

## How the money works

We are **merchant of record**. This is the single most important architectural constraint.

1. Customer pays *our* Stripe account on the seller's storefront.
2. We pay the fulfillment vendor from our account, using our credentials.
3. We hold the difference, then pay the seller their margin on a delay (net 14 after delivery).

Seller-visible "product cost" = vendor base cost + our platform fee. The seller never sees the
split. Our fee is a flat per-unit amount (~$4–6), not a percentage.

Implications you must respect:
- Sellers never hold vendor API credentials. We do.
- Every order flows through our Stripe account, not theirs.
- Payouts are delayed and recoverable — a chargeback must be reversible against a future payout.
- All money is stored as **integer cents**. Never floats.

## Fulfillment vendors

Primary: **Printful**. Working API, good reliability.
Secondary: **Apliiq**. Better private-label finishing (neck tags, woven labels, embroidery) which
is core to our positioning, but their API currently returns 500 on every request including
unauthenticated ones — a server-side fault on their end, unresolved as of Aug 2026.

**Everything vendor-specific goes behind the `FulfillmentProvider` interface in
`lib/fulfillment/types.ts`. No vendor SDK, endpoint, or field name may appear anywhere else in the
codebase.** This is non-negotiable — swapping or adding a vendor must never touch application code.

Printful account structure: one Printful account (ours), with a separate Printful "Manual orders /
API platform" store per seller. Authenticate with an **Account-level** private token, not a Store-level
one, and not a Public App. A Public App would mean sellers connect their own Printful accounts,
which breaks merchant-of-record entirely.

RESOLVED (Aug 2026): multiple stores under one Printful account works. Store-per-seller is the
design; the single-shared-store fallback is not needed and should not be built.

RESOLVED (Aug 2026): the token in use is **Account-level**, verified against the live API — a
store-scoped call without `X-PF-Store-Id` returns `400 "This endpoint requires store_id!"`, which
is the account-level signature. It reaches every store on the account. A Store-level token would
be scoped to one store and is NOT sufficient.

## Stack

- Next.js (App Router), TypeScript, Tailwind
- Supabase (Postgres + Auth + Storage)
- Stripe Connect Express, **separate charges and transfers** (not destination charges — we must
  hold funds until fulfillment clears)
- Vercel hosting, wildcard subdomain `*.ourdomain.com` + custom domains
- Sharp for mockup compositing (displacement map + mask + multiply). No generative AI.

## Multi-tenancy

Two surfaces:
- **Storefront** — `store.ourdomain.com` or a custom domain. Server-rendered, public, SEO matters.
  Resolves subdomain → `store_id` in middleware.
- **Dashboard** — `app.ourdomain.com`. Authenticated seller UI. No SEO requirement.

Postgres RLS keyed on `store_id` is the isolation boundary. Order processing and vendor calls run
with the service role and bypass RLS; every user-facing query must go through RLS.

## The launch path

New sellers follow a 21-day guided sequence (name → design → blank → price → sample → drop date →
waitlist → launch). Each step is a **button that performs an action**, never advice text. State lives
in `launch_steps` and `store_progress`. This is the product's main differentiator — treat it as core,
not as onboarding polish.

Related: drops are **reservation-based**. A seller sets a threshold (default 25 units). Orders
collect as reservations; production only triggers when the threshold is met. Below threshold,
reservations auto-refund. Sellers never front inventory cost.

## Cost discipline

Revenue is per *order*; most signups never sell. Anything with real marginal cost must sit behind
an order-correlated event.

- Free and ungated: storefront, design tool, mockups, waitlist page, launch path.
- Gated on first real sale: subsidized samples, video generation (not yet built), bulk email import.
- Every subsidized feature needs a per-account cap, a global monthly budget, and a kill switch.

## Known risks to design against

- **Card testing / laundering.** Free storefronts + card processing is a known fraud vector, and
  chargebacks hit *our* Stripe account. Above ~1% dispute rate Stripe restricts us; above 1.5% they
  can terminate. Hold payouts, cap first-month volume per new store, flag AOV far off catalog.
- **IP infringement.** Sellers will upload protected marks. We are merchant of record, so takedowns
  come to us. Designs need a review queue before production.
- **Email deliverability.** Thousands of new senders on shared infrastructure. Double opt-in only,
  no CSV import before first sale, auto-suspend on complaint threshold.
- **Order created, vendor call failed.** The worst failure: money taken, nothing manufactured.
  Every vendor submission needs an idempotency key, a retry queue, and an alert.

## Build order

1. Schema + RLS (`supabase/migrations/0001_init.sql`)
2. Fulfillment interface + Printful adapter, verified against their sandbox
3. Storefront rendering (subdomain routing, theme tokens, PDP)
4. Design upload + mockup compositing
5. Stripe Connect + checkout + the order pipeline
6. Launch path
7. Drops and reservations

~~Do not start 5 until 2 is proven end to end with a real test order.~~

SUPERSEDED 2026-08-11, by decision: build steps 4–7 out fully before ordering a
sample. The original gate conflated two things. Writing the order pipeline moves
no money; **accepting a real customer payment** does. So the gate moves rather
than disappears:

> **Do not accept a real customer payment until one real vendor order has been
> placed and manufactured.** Code, dry runs, and test orders against our own
> Stripe test keys are all fine before that. Live checkout is not.

The failure this guards against is money taken for a garment that never gets
made. That risk begins at the first live charge, not at the first line of code.
