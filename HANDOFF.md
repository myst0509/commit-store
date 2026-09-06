# Start here

Read this first in a new session, then `PROJECT.md` for the business model and
`PROGRESS.md` for detail. This file is the short version: what exists, what is
next, and what will bite you.

**Commit** is a free platform for starting a clothing brand. Sellers design
products; we handle manufacturing, payments and payouts, and take a flat fee per
unit. We are merchant of record, which is the constraint that shapes everything
else.

---

## Where it stands, 2026-08-19

**The product works end to end in test mode.** A seller can sign up, follow a
twelve-step guide, and open a live storefront. No real garment has ever been
manufactured and no live charge has been taken. That gate is deliberate.

| | |
|---|---|
| Frontend | `https://commit-store.lovable.app` — built in Lovable, all screens live |
| API and storefronts | `https://commit-store-xuav.vercel.app` |
| A real storefront | `/s/demo` or `/s/xos` on the API host |
| Database | Supabase `aktehepmvbaxuidpdzjh`, migrations `0001`–`0007` applied |
| Tests | `npm test` — 192 unit, plus integration scripts |

**Two stores exist.** `XOS` is the owner's, built by walking the real guide.
`Demo Brand` comes from `npm run seed:demo`.

### Built and verified

Schema and RLS · Printful catalogue (173 blanks, 12 enabled) · Apliiq catalogue
· design validation · checkout and Stripe webhook in test mode · Connect
onboarding · the payout run · drop resolution · the twelve-step guide · every
seller screen · a public marketing site and store directory.

### Built but never run against reality

`submitOrder` for both vendors. No order has been placed with Printful or
Apliiq. `FULFILLMENT_LIVE` is `false`, which is what stops a test becoming a
real garment.

---

## What to do next

**1. Buy a domain.** It is the cheapest unblock and it resolves four things at
once: seller subdomains, the dead `store.url`, the campus firewall that blocks
`*.vercel.app`, and the reputation clock on a new domain. Everything below is
easier afterwards.

**2. Decide the pricing model.** `PROJECT.md` records the service fee as settled
on 2026-08-11; `PASS_CARD_FEES_TO_CUSTOMER` in `lib/pricing.ts` is `false`. The
two disagree. It is worth $1.37 an order, and the service-fee model holds margin
flat at $5.89 whether a seller prices at $18 or $100, where the current one
decays to $2.55. One line to change, but it is a business decision.

**3. Mockups.** Products show the blank's stock photo, so two sellers using the
same garment have identical-looking stores. This is the biggest remaining visual
gap. `lib/mockup/composite.ts` is written and blocked on garment template
assets — a photo, a mask and a displacement map per blank. Apliiq's mockup
templates would also solve it.

**4. Before any real money:** create the Stripe webhook endpoint
(`STRIPE_WEBHOOK_SECRET` is still a placeholder, so webhooks are rejected in
production), move off Vercel Hobby, which forbids commercial use, and re-enable
"Confirm email" in Supabase.

---

## Waiting on someone else

- **Apliiq:** the mockup template payload — which field carries the template id
  and how artwork is supplied. Their shipping endpoint was due the week of
  2026-08-24. Everything else about that vendor is answered.
- **Printful:** whether their terms permit acting as merchant of record for
  third-party sellers. Never asked, and load-bearing for the whole model.
- **An accountant:** whether Printful shipping on our behalf creates nexus in
  their fulfilment states. Same conversation as merchant of record.

---

## Things that will bite you

- **`*.vercel.app` is blocked on the UCR campus network.** It times out rather
  than failing, so the frontend hangs with no error and looks broken. Use a VPN
  or cellular. This cost a whole debugging session once.
- **Lovable changes are not live until you press Publish.** The editor preview
  and the published build are different things, and this has caused false
  "it didn't work" reports twice.
- **A silent truncation at a round number is a default limit.** PostgREST caps
  responses at 1000 rows; an unpaged variant fetch quietly priced only half the
  catalogue.
- **Test data is real data.** `verify:rls`, `drop:test` and `payout:test` create
  and remove rows in the live database.
- **Never grant SELECT on `catalog_variants` or `product_variants`** to anon or
  authenticated. Those column grants hide vendor cost and the base/fee split. A
  permissions error there is the system working.

---

## Where to look

| | |
|---|---|
| `PROJECT.md` | business model, money flow, architectural constraints |
| `PROGRESS.md` | full state, every decision and why, what is verified vs written |
| `LOVABLE.md` | frontend handoff: prompts to paste, API reference, rules not to undo |
| `DEPLOY.md` | deployment sequence and environment variables |
| `lib/fulfillment/types.ts` | the vendor interface. No vendor detail lives outside this folder |
| `lib/pricing.ts` | all money arithmetic, in one file |

`npm run` scripts are how things get verified rather than assumed: `test`,
`verify:rls`, `checkout:test`, `webhook:test`, `drop:test`, `payout:test`,
`retry:test`, `order:dry-run`, `apliiq:probe`, `curate`, `sync:catalog`,
`pricing:model`.
