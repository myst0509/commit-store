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
| Tests | `npm test` — 197 unit, plus integration scripts |

**Two stores exist.** `XOS` is the owner's, built by walking the real guide.
`Demo Brand` comes from `npm run seed:demo`.

### Built and verified

Schema and RLS · Printful catalogue (173 blanks, 12 enabled) · Apliiq catalogue
· design validation · checkout and Stripe webhook in test mode · Connect
onboarding · the payout run · drop resolution · the twelve-step guide · every
seller screen · a public marketing site and store directory · storefronts
rendering the seller's colours, bio and links.

**Pricing is settled.** The customer covers card processing through a line
called **Processing**, explained as "Covers the cost of taking payment
securely. Same on every order." We keep about $4.58 an order at any seller
price. The wording is legally constrained and lives in `lib/pricing.ts` with a
test enforcing it — see PROJECT.md before changing a word of it.

### Built but never run against reality

`submitOrder` for both vendors. No order has been placed with Printful or
Apliiq. `FULFILLMENT_LIVE` is `false`, which is what stops a test becoming a
real garment.

---

## What to do next

Roughly in order. The first two are cheap and unblock the rest.

**1. Buy a domain.** Still the single highest-value hour. It resolves four
things at once: seller subdomains, the dead `store.url`, the campus firewall
that blocks `*.vercel.app`, and the reputation clock that makes a brand-new
domain look suspect to enterprise filters. Then set `NEXT_PUBLIC_ROOT_DOMAIN`,
`APP_ORIGIN` and `CORS_ALLOWED_ORIGINS` in Vercel.

**2. Paste prompt 25 into Lovable.** Written and not yet applied. A seller can
finish the whole guide and still has no button to look at their own storefront.
`previewUrl` works today at `/s/<subdomain>` without any domain, so this is a
frontend-only change. It is at the top of `LOVABLE.md`.

**3. Mockups — the biggest remaining product gap.** Every product shows the
blank's stock photo, so two sellers using the same garment have identical
storefronts. `lib/mockup/composite.ts` is written and tested; it is blocked on
assets, being a photograph, a mask and a displacement map per blank. Apliiq's
mockup templates would also solve it, and would need their template payload
first. This is the difference between a storefront that looks like a brand and
one that looks like a catalogue.

**4. Then, and only then, real money.** In this order:
   - Create the Stripe webhook endpoint and set `STRIPE_WEBHOOK_SECRET`. It is
     a placeholder today, so every webhook is rejected in production.
   - Move off Vercel Hobby, which forbids commercial use.
   - Re-enable "Confirm email" in Supabase Auth.
   - Place **one real Printful order** with `FULFILLMENT_LIVE=true`. That is the
     gate PROJECT.md sets on live checkout, and nothing about taking real
     customer payments should happen before a garment has actually been made.

**Smaller things worth doing whenever:**

- The catalogue cache goes stale. Printful added six blanks and raised base
  costs between two syncs a week apart. `npm run sync:catalog` takes nine
  minutes.
- Two tank tops are typed `T-SHIRT` by Printful. Fine for grouping, wrong as a
  description if you ever surface `garmentType`.
- The store directory ranks by earnings but hides amounts, and stays empty
  below five qualifying stores. Sellers have not agreed to being ranked; if
  that becomes a concern the fix is an opt-out column, not a change to the
  ranking.

## Waiting on someone else

- **Apliiq:** the mockup template payload — which field carries the template id
  and how artwork is supplied. Their shipping endpoint was due the week of
  2026-08-24. Everything else about that vendor is answered.
- **Printful:** whether their terms permit acting as merchant of record for
  third-party sellers. Never asked, and load-bearing for the whole model.
- **An accountant:** whether Printful shipping on our behalf creates nexus in
  their fulfilment states, and a look at the Processing fee. Same conversation
  as merchant of record. Sales tax itself is not the cost it looked like:
  Stripe Tax has no monthly minimum and per-state thresholds are $100k or 200
  transactions, which is far above current volume. See PROGRESS.md.

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
- **A constant baked into a script stops it modelling.** `pricing-model.ts`
  pinned the seller's cost at the blank plus the old fee, so lowering the fee
  changed nothing in its output and it reported dead economics for a day.
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
