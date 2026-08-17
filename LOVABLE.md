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

**Products** — `GET /api/products/{id}`, `PATCH /api/products/{id}` with
`{ name?, description?, status?, retailPriceCents? }`. Repricing below cost
returns 400 with the real cost named; show that message.

**Designs** — `POST /api/designs/upload-url` with `{ filename }` returns
`{ uploadUrl, token, storagePath }`. Upload the file to `uploadUrl` directly,
then `POST /api/designs` with `{ storagePath, filename, blankId? }`. The
response has `usableOn` (which placements, and the largest print size on each)
and `warnings`. `GET /api/designs` lists them with a `review` status.

**Orders** — `GET /api/orders/{id}` returns items, customer, totals including
`yourEarningsCents`, tracking, and `earnings.availableAt`.

**Drops** — `GET /api/drops` returns `reservedUnits`, `thresholdUnits`,
`percentToThreshold`. `POST /api/drops` with
`{ productId, closesAt, thresholdUnits }`.

**Payouts** — `GET /api/connect/onboard` for status and outstanding
requirements; `POST` returns `{ url }` to redirect to Stripe's hosted onboarding.

---

## Two things Lovable will get wrong

It defaults to **querying Supabase tables directly**. Do not let it. Vendor cost
and the base/fee split are hidden by column grants (migration 0002), so a direct
query hits permission errors rather than returning data — and the fix it will
reach for is `GRANT SELECT`, which republishes the cost basis.

It defaults to **computing totals and margins in React**. Every number it needs
is already in the response. Prices computed client-side are a fraud vector, and
we are merchant of record, so the chargeback is ours.

---

## What stays out of Lovable

Storefronts (`/s/[host]`) are server-rendered in this repo and should stay that
way. PROJECT.md requires crawlable HTML because sellers start with no audience,
and a client-rendered storefront hands that away. `/api/storefront` exists for
cart and live drop counters — not for rendering product pages.
