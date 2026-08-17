# Frontend handoff (Lovable)

All UI is built in Lovable as a separate app. This backend exposes an HTTP API
for it to call. Lovable cannot import from `lib/` — it is a different codebase on
a different domain — so everything it needs goes through `/api`.

**API base:** `https://commit-store-xuav.vercel.app`

CORS is handled in `proxy.ts`. If a call is blocked, add the exact origin from
the browser console to `CORS_ALLOWED_ORIGINS` in Vercel and redeploy.

---

## The prompt

Paste this whole thing as the first message.

```
Build a seller dashboard for "Commit", a platform where people start independent
clothing brands. Sellers design products, we handle manufacturing and payments.

STACK
- React + Tailwind + shadcn/ui
- Supabase ONLY for authentication. Do NOT create any database tables, and do
  NOT query Supabase tables directly. All data comes from the REST API below.

SUPABASE (auth only)
  URL:  https://aktehepmvbaxuidpdzjh.supabase.co
  Key:  sb_publishable_558KPS3oSPx8TqocywYekQ_Pl2_0FVs

API
  Base URL: https://commit-store-xuav.vercel.app
  Every request sends the Supabase session access token:
    Authorization: Bearer <session.access_token>
  A 401 means sign in again. Errors return { "error": "message for the user" } —
  show that message directly, it is already written for a human.

MONEY
  Every amount is an integer of cents. 3200 means $32.00. Divide by 100 for
  display ONLY. Never do pricing arithmetic — the server sends every number you
  need to show.

BUILD THESE THREE SCREENS

1. AUTH — email/password sign up and sign in via Supabase. After sign in, go to
   the launch path.

2. LAUNCH PATH (the main screen, make it the best one)
   GET /api/launch returns:
   {
     "store": { "name": "...", "subdomain": "..." },
     "progress": { "done": 2, "total": 8, "percent": 25 },
     "current": { "key": "design", "title": "Upload your first design",
                  "outcome": "Checks your artwork is high enough resolution" },
     "steps": [ { "key": "name", "day": 1, "title": "Name your brand",
                  "outcome": "Creates your storefront at yourname.ourdomain.com",
                  "status": "completed" | "available" | "locked" | "skipped",
                  "blockedBy": ["design"], "completedAt": "..." } ]
   }

   Render the 8 steps as a vertical sequence with a progress indicator.
   - completed: checked, muted, show completedAt
   - available: the ONLY one with an active button. Button label = title.
     Show `outcome` underneath as the description.
   - locked: dimmed, not clickable, show what it is waiting for from blockedBy

   Pressing a step's button calls:
     POST /api/launch  { "step": "<key>", "input": { ... } }
   Show a form for the input each step needs:
     name       -> { name: string }              (brand name)
     design     -> handled on the Designs screen, link there instead
     blank      -> { blankId: string }           (pick from GET /api/catalog)
     price      -> { blankId, designId, name: string, retailPriceCents: number }
     drop_date  -> { productId, closesAt: ISO date, thresholdUnits: number }
     waitlist   -> {}
     launch     -> {}
   On success the response has { result, progress, next } — refresh the list.
   On 400 show the error message; the server enforces the order, so trust it.

3. DASHBOARD HOME
   GET /api/dashboard returns:
   {
     "store": { "name", "subdomain", "status", "url", "firstSaleAt" },
     "earnings": { "payableCents", "pendingCents", "lifetimeCents",
                   "payoutsHeld": true },
     "bank": { "connected": false, "ready": false },
     "sales": { "orderCount", "grossCents",
                "recent": [ { "id", "number", "status", "totalCents",
                              "placedAt", "deliveredAt" } ] },
     "payouts": [ { "id", "amountCents", "status", "scheduledFor", "paidAt" } ],
     "products": [ { "id", "name", "slug", "status", "variantCount",
                     "priceCents", "unitCostCents" } ]
   }

   Show: earnings (payable vs pending — explain pending is held 14 days after
   delivery), recent orders, products, and a prompt to connect a bank account
   if bank.connected is false.

DESIGN DIRECTION
The user is starting their first clothing brand. They are not technical and have
no audience. Calm, confident, uncluttered. One clear action per screen. Never
show jargon — say "earnings", not "ledger"; "waiting to clear", not "net 14".
Empty states should tell them what to do next, not just say "no data".

DO NOT
- Do not create Supabase tables or use the Supabase database client.
- Do not calculate prices, totals, fees or margins anywhere in the frontend.
- Do not build a storefront or checkout — those are handled elsewhere.
```

---

## Follow-up prompts, one screen at a time

Built and live: **auth**, **launch path**, **designs**, **dashboard home**.

Remaining, in this order. The order is not arbitrary — the launch path's `price`
step creates a product with nowhere to view it, and its `drop_date` step needs a
`productId` it cannot currently pick. Payouts is last because it is the only
screen that cannot be verified today: Connect is not enabled on the Stripe
account.

### There are no list endpoints

Only `/api/drops` returns a collection. There is no `GET /api/products` and no
`GET /api/orders` — Lovable will assume both exist and get a 404. Lists come
from `/api/dashboard`:

- products list → `dashboard.products[]`
- orders list → `dashboard.sales.recent[]` (most recent 25, no pagination)

Detail routes are per-id only.

### 1. Products — NEXT

```
Add a Products screen.

The product LIST comes from GET /api/dashboard -> products[]. There is no
GET /api/products endpoint; do not call one.
  { id, name, slug, status, variantCount, priceCents, unitCostCents }
priceCents and unitCostCents are the LOWEST across enabled variants, and are
null when no variant is enabled. status is "draft" | "published" | "archived".

Clicking one opens the detail: GET /api/products/{id}
  { id, name, slug, description, status, decoration,
    blank: "Bella + Canvas 3001", imageUrl,
    variants: [ { id, color, size, inStock, priceCents,
                  unitCostCents, marginCents, enabled } ],
    artwork:  [ { placement, decoration, url } ] }

Show the artwork, the blank it prints on, and the variants grouped by colour
with sizes across. unitCostCents is what the garment costs the seller and
marginCents is what they keep per unit — label them "your cost" and "you keep".
Do not sum, average or recompute any of these; render them as sent.

Editing is PATCH /api/products/{id} with any of
  { name?, description?, status?, retailPriceCents? }
It returns the same shape as GET, so use the response to refresh in place.

retailPriceCents applies to EVERY variant at once — one price per product, not
per size. Say so next to the field. If the price is below cost the server
returns 400 with a message that names the real cost, e.g. "At $9.00 you would
lose money — this garment costs you $16.86". Show that message verbatim.

Publishing is the status field: draft -> published makes it live on the
storefront. Make that a deliberate, clearly-labelled action, not a toggle that
fires on a stray click.

Empty state: no products yet -> point them back to the launch path, since that
is what creates the first one.
```

### 2. Drops

```
Add a Drops screen.

GET /api/drops
  { drops: [ { id, product: { id, name, slug }, status,
               thresholdUnits, reservedUnits, unitsRemaining,
               percentToThreshold, opensAt, closesAt, resolvedAt } ] }

A drop is how a product launches: customers reserve, nobody is charged, and
production only starts once thresholdUnits is reached. Below the threshold the
holds are released and no charge ever appears. Say that in plain words on the
screen — it is the thing sellers most need to understand and the reason they
front no inventory cost.

Show each drop as a progress bar of percentToThreshold with
"reservedUnits of thresholdUnits reserved" and unitsRemaining to go, plus the
closing date. Never write "net", "capture", "authorisation" or "threshold" as
jargon — "X more to go" and "closes in 6 days".

POST /api/drops { productId, closesAt (ISO), thresholdUnits }
Pick productId from GET /api/dashboard -> products[]. thresholdUnits defaults
to 25 if omitted. closesAt must be in the future.

There can only be one open drop per product: posting again for a product that
already has one UPDATES it and returns { id, updated: true, thresholdUnits }
instead of { id, created: true, ... } with a 201. Reflect which happened.

Validation errors come back as 400 with a written message ("Pick a closing
date", "The closing date must be in the future"). Show them as sent.
```

### 3. Order detail

```
Make the recent orders on the dashboard clickable through to a detail screen.

GET /api/orders/{id}
  { id, number, status, paymentStatus, isReservation,
    customer: { name, email, address },
    items: [ { name, color, size, quantity, unitPriceCents } ],
    totals: { goodsCents, shippingCents, customerPaidCents,
              yourEarningsCents },
    earnings: { credited: bool, availableAt: ISO | null },
    shipment: { status, carrier, trackingNumber, trackingUrl,
                estimatedDelivery, submittedAt } | null,
    timeline: { placedAt, paidAt, deliveredAt, cancelledAt } }

The customer address is there so the seller can answer "where is my order"
questions — show it, but not as the loudest thing on the page.

shipment is null until we submit the order for manufacturing; show "not made
yet" rather than an empty tracking box. When trackingUrl exists, link it.

earnings.credited false means this sale has not been added to their earnings
yet. availableAt is when it becomes payable — 14 days after delivery. Phrase it
as "clears on <date>", never "net 14".

isReservation true means this is a drop reservation: the customer has NOT been
charged, only authorised. Label it clearly and do not describe it as a sale.

Render totals exactly as sent. Do not derive yourEarningsCents from the items.
```

### 4. Payouts — do not build yet

Blocked twice over, both outside Lovable:

- Connect is not enabled on the Stripe account, so `GET /api/connect/onboard`
  cannot return a real status.
- `POST /api/connect/onboard` only accepts a `returnUrl` that starts with
  `APP_ORIGIN`, which currently defaults to `http://app.localhost:3000`. Set it
  in Vercel to the Lovable app origin first, or a seller finishing Stripe
  onboarding gets redirected to localhost and is stranded.

  Use the **published** Lovable origin, not the in-editor preview one, and note
  that unlike `CORS_ALLOWED_ORIGINS` this is a plain `startsWith` — a
  `https://*.lovable.app` wildcard matches nothing here.

When both are cleared: `GET /api/connect/onboard` returns
`{ connected, ready, detailsSubmitted, outstanding[], disabledReason }`;
`POST` returns `{ url }` to redirect to Stripe's hosted flow. `outstanding` is
Stripe's own requirement codes — show them so a stalled seller can see what is
missing.

**Designs** (built) — `POST /api/designs/upload-url` with `{ filename }` returns
`{ uploadUrl, token, storagePath }`. Upload the file to `uploadUrl` directly,
then `POST /api/designs` with `{ storagePath, filename, blankId? }`. The
response has `usableOn` (which placements, and the largest print size on each)
and `warnings`. `GET /api/designs` lists them with a `review` status.

---

## Two things Lovable will get wrong

It defaults to **querying Supabase tables directly**. Do not let it. Vendor cost
and the base/fee split are hidden by column grants (migration 0002), so a direct
query hits permission errors rather than returning data — and the fix it will
reach for is `GRANT SELECT`, which republishes the cost basis.

`store.url` from `/api/dashboard` is
`https://<subdomain>.ourdomain.com` — a placeholder. No real domain is
configured, and `*.vercel.app` cannot be wildcarded, so seller storefronts have
nowhere to live yet. Do not make "view your store" a prominent link until a
domain exists; it goes nowhere.

It defaults to **computing totals and margins in React**. Every number it needs
is already in the response. Prices computed client-side are a fraud vector, and
we are merchant of record, so the chargeback is ours.

---

## What stays out of Lovable

Storefronts (`/s/[host]`) are server-rendered in this repo and should stay that
way. PROJECT.md requires crawlable HTML because sellers start with no audience,
and a client-rendered storefront hands that away. `/api/storefront` exists for
cart and live drop counters — not for rendering product pages.
