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

**Shipping (settled 2026-08-11).** The end customer pays shipping as a separate line on top of the
seller's retail price, quoted live from the vendor and passed through at cost. We do not profit
from it and do not subsidise it. Sellers are told this up front — it is their customer's cost, not
theirs. Seller margin is therefore `retail − vendor base − our fee`, untouched by what shipping
happens to cost on any given order.

**Our fee is not our revenue.** Two costs come out of our side before anything is left:

- **Stripe** takes 2.9% + 30¢ of the *whole* charge, shipping included.
- **Vendor sales tax**, unless we hold a resale certificate with the vendor — worth doing early,
  it is pure recovered margin.

**Service fee — settled 2026-08-11, and actually switched on 2026-08-19.** The customer covers
card processing through a **service fee** line at checkout, so our platform fee is close to what
we keep. `PASS_CARD_FEES_TO_CUSTOMER` is `true`.

It was `false` until 19 August, so this document and the code disagreed for a week. The deciding
argument was not the per-order difference but its shape. Our fee is flat and Stripe's is a
percentage of the whole charge, so absorbing it makes our margin decay as sellers succeed:

| Seller prices at | Absorbing | Service fee |
|---|---|---|
| $18 | $3.62 | $4.58 |
| $32 | $3.21 | $4.58 |
| $60 | $2.40 | $4.59 |
| $100 | **$1.24** | $4.58 |

A seller moving $100 hoodies keeps $83.31 and leaves us $1.24. Earning least from the sellers
doing best is the wrong shape for a business whose entire revenue is per order.

Three things about the number:

- Stripe charges its percentage on the service fee itself, so covering a $1.37 cost requires
  charging $1.42. `grossUpForStripe` solves for it; do not just add the fee.
- **It covers Stripe only, not vendor tax.** Checkout passes `vendorTaxCents: 0` because the
  vendor's sales tax is not known when the customer pays. Printful bills it afterwards, roughly
  42c an order, against our fee. So a $5.00 platform fee nets about $4.58.
- A resale certificate with Printful removes that 42c, and because it is not in the customer's
  fee it becomes recovered margin rather than a smaller fee.

The cost of this choice is a third line at checkout for a brand nobody has heard of, which is a
real thing to lose. If it hurts conversion, reversing it is one line.

It must be a **uniform fee on every order regardless of payment method**, not a card surcharge:
several US states restrict surcharging and the card networks prohibit it on debit. Worth legal
review before launch — we are merchant of record, so it is our exposure.

**That constraint decides the wording, so the wording lives in code.** `SERVICE_FEE_LABEL` and
`SERVICE_FEE_EXPLANATION` in `lib/pricing.ts` are returned by `/api/checkout` alongside the
amount, so no storefront can invent its own phrasing. The line reads:

> **Processing** — $1.41
> Covers the cost of taking payment securely. Same on every order.

Nothing in either string may mention cards, credit, debit or the payment method; a test enforces
that. "Card fee" and "Payment fee" are ruled out legally. "Service fee" and "Convenience fee" are
ruled out because they are what ticket sites call the charge everyone resents, and this customer
is already buying from a brand they have never heard of.

All of this lives in `lib/pricing.ts`, the only place the arithmetic exists.
`PASS_CARD_FEES_TO_CUSTOMER` flips the whole model in one line, and
`npm run pricing:model` prints both side by side at the current fee.

Implications you must respect:
- Sellers never hold vendor API credentials. We do.
- Every order flows through our Stripe account, not theirs.
- Payouts are delayed and recoverable — a chargeback must be reversible against a future payout.
- All money is stored as **integer cents**. Never floats.

## Fulfillment vendors

Primary: **Printful**. Working API, good reliability.
Secondary: **Apliiq**. Better private-label finishing (neck tags, woven labels, embroidery) which
is core to our positioning.

RESOLVED Aug 2026 — **their API works.** It was written off as "500 on everything, a server-side
fault". That was wrong. Apliiq authenticates with an **HMAC signature**, not a bearer token, and
returns a 500 rather than a 401 for an unsigned request — so "not authenticated" and "vendor is
down" are indistinguishable from outside. No credentials were ever configured here and no code
ever called them, so every 500 came from an unsigned request.

Verified 2026-08-19 with a signed request: `GET /v1/Order` and `GET /v1/Product` both return
**200** with real catalog data. Signer in `lib/fulfillment/apliiq-auth.ts`, probe via
`npm run apliiq:probe`. The adapter itself is still unwritten — only auth is proven.

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
