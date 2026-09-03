# Frontend handoff (Lovable)

All UI is built in Lovable as a separate app. This backend exposes an HTTP API
for it to call. Lovable cannot import from `lib/` — it is a different codebase on
a different domain — so everything it needs goes through `/api`.

**API base (this repo, on Vercel):** `https://commit-store-xuav.vercel.app`
**Frontend (Lovable):** `https://commit-store.lovable.app`

The two are different hosts, which is why CORS and `APP_ORIGIN` both exist.

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

### List endpoints, and the one that is still missing

`/api/drops` and `/api/products` return collections. **There is still no
`GET /api/orders`** — Lovable will assume there is and get a 404. The orders
list comes from `/api/dashboard` → `sales.recent[]`, most recent 25, no
pagination. Orders have a detail route per id but no index.

Prompt 1 below predates `GET /api/products` and tells the Products screen to
read `dashboard.products[]`. Prompt 7 corrects that.

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

### 4. Payouts

Unblocked 2026-08-16: Connect is enabled on the Stripe account and `APP_ORIGIN`
is set and deployed.

**Build this screen at the route `/settings/payouts`.** That is not arbitrary —
it is where Stripe sends the seller back, and matching it means the request
never has to name a URL. See the note after the prompt.

```
Add a Payouts screen at the route /settings/payouts. It answers one question:
"where is my money, and what do I have to do to get it."

It reads from two endpoints.

GET /api/dashboard — the money itself
  earnings: { payableCents, pendingCents, lifetimeCents, payoutsHeld }
  payouts:  [ { id, amountCents, status, scheduledFor, paidAt } ]

GET /api/connect/onboard — the bank connection
  { connected, ready, detailsSubmitted, outstanding: [...], disabledReason }

FOUR STATES, and the screen looks different in each. Drive them off
connected/ready, never off your own guess.

1. connected false — no bank yet.
   The main action. "Add your bank details so we can pay you."
   POST /api/connect/onboard with an EMPTY body {} -> { url }
   Send the browser to that url. It is Stripe's own hosted page.

2. connected true, ready false — started but not finished.
   This is the state sellers get stuck in, so make it the clearest one.
   Show `outstanding` as a list of what Stripe still needs. Those are Stripe's
   own requirement codes like "individual.verification.document" — print them
   as given, plainly labelled "Stripe still needs:". Do NOT invent friendly
   translations; guessing wrong sends someone hunting for the wrong document.
   Offer a button to continue, which POSTs again for a FRESH url.
   If disabledReason is set, show it too.

3. connected true, ready true — done.
   A quiet confirmation, not a celebration. Then get out of the way and show
   the money.

4. earnings.payoutsHeld true — payouts are on hold for this store.
   Show this ABOVE everything else, and say the money is held, not lost. This
   is a real state and defaults to on. Never let a seller conclude their
   earnings vanished.

THE MONEY

payableCents — clear, waiting for the next payout run.
pendingCents — earned, but still inside the 14-day window after delivery.
lifetimeCents — everything they have ever earned.

Say "clears 14 days after delivery", never "net 14".

Two rules sellers WILL ask about, so state them on the screen rather than in a
tooltip:
- Payouts run once a day, at 09:00 UTC.
- Anything under $10.00 rolls forward to the next run instead of being paid.
  Phrase it as a floor, not a failure: "balances under $10 roll over".

PAYOUT HISTORY
List `payouts` with amount, status and date — paidAt when present, otherwise
scheduledFor. Empty state: say when the first one will happen, not "no data".

RETURNING FROM STRIPE
Stripe sends the seller back to this same route with a query parameter.
  ?done=1    -> they finished the flow (or think they did)
  ?refresh=1 -> the link expired or was rejected

On ?done=1 you MUST re-fetch GET /api/connect/onboard before showing anything.
Coming back does NOT mean it worked — people abandon halfway and still land
here. Trust `ready` from the server, never the presence of the parameter.

On ?refresh=1, immediately POST for a new url and send them back. The old link
is dead; Stripe's are single-use.

DO NOT
- Never build a form for bank details, account numbers, routing numbers, or
  ID documents. Stripe collects all of it on their own page. That is the whole
  reason this flow exists.
- Do not compute, sum or convert any amount. Render what the server sends.
- Do not treat "connected" as "ready". They are different fields for a reason.
```

**Why the route matters.** `POST /api/connect/onboard` accepts `returnUrl` and
`refreshUrl`, but only honours them if they start with `APP_ORIGIN` — otherwise
it silently falls back to `${APP_ORIGIN}/settings/payouts?done=1` and
`?refresh=1` ([route.ts:47](app/api/connect/onboard/route.ts:47)). Silently, with
no error. So the safe move is the one in the prompt: build at
`/settings/payouts`, post an empty body, and let the defaults be right. Passing
a URL only adds a way to be wrong.

If the screen ever does need to live elsewhere, the URL must start with exactly
the `APP_ORIGIN` value — a `https://*.lovable.app` wildcard matches nothing
here, unlike `CORS_ALLOWED_ORIGINS`.

### 5. Store settings

Added 2026-08-19. This is the first screen for which no API existed before: a
store could only ever be named once, by the launch path, and `stores.theme` was
read by the storefront and written by nothing at all.

```
Add a Store settings screen at /settings.

GET /api/store
  { name, subdomain, status, url, customDomain,
    theme: { bg?, fg?, accent?, muted?, radius? },
    hasSold: boolean }

PATCH /api/store with any of { name, subdomain, theme }
It returns the same shape as GET, so use the response to refresh in place.

THREE SECTIONS.

1. BRAND NAME
   Free text, up to 60 characters. This is what customers see. It does NOT
   have to match the web address, and short names like "XO" are fine here.

2. WEB ADDRESS
   The subdomain their storefront lives at. Show the full url from the
   response so it is obvious what it becomes.

   Lowercase letters, numbers and hyphens only, 3 to 63 characters, and it
   cannot start or end with a hyphen. Do not enforce this yourself beyond
   basic hints — send it and show the server's message, which names the exact
   rule that was broken.

   If hasSold is true, warn before saving: customers already have the old
   address and any link they have will stop working. Make them confirm.

3. APPEARANCE
   Five optional values, all CSS colours except the last:
     bg      page background
     fg      text colour
     accent  buttons and links
     muted   secondary text
     radius  corner rounding, e.g. "12px" or "0.75rem"

   Use real colour pickers, not free-text hex fields, and show a small live
   preview of a storefront card using the chosen values so the seller can see
   what they are choosing.

   Send the WHOLE theme object every time. PATCH replaces it rather than
   merging, which is what makes "remove this colour" expressible. Send an
   empty string for a value the seller cleared.

RULES
- Every field is optional. Send only what changed; sending nothing returns
  400 "Nothing to change".
- Errors come back as { error } with a message written for a person. Show it
  as sent. A taken web address, a reserved one like "app", and an unusable
  colour all have their own wording.
- Do not validate colours in the frontend beyond what the picker gives you.
  The server accepts exactly what the storefront can render, and the two use
  one shared rule.

EMPTY / FIRST RUN
A store created at signup is named "My brand" with a generated web address
like store-e78523d2. Treat that as unset: prompt them to choose both, since
those placeholders are what a customer would otherwise see.
```

### 6. App shell and navigation — the last structural piece

The screens were built one at a time, so each works but nothing ties them
together. This prompt is deliberately STRUCTURAL only: no colours, no type, no
visual direction. That comes separately, and a restyle here would only be
thrown away.

```
Tie the existing screens together into one app. Do NOT restyle anything or
change any visual design. This is about navigation, routing and states only.

1. PERSISTENT SHELL
   Every signed-in screen shares one layout with persistent navigation.
   Sidebar on desktop, collapsible or bottom nav on mobile. Destinations:

     Launch      /launch            the guided sequence
     Home        /dashboard         earnings, recent orders, products
     Designs     /designs
     Products    /products
     Drops       /drops
     Payouts     /settings/payouts
     Settings    /settings

   Highlight the current one. Keep the order above: the launch path is the
   product's spine, not a settings page, so it goes first.

   Orders have no list screen of their own. They are reached from the recent
   orders on /dashboard. Do not add an Orders nav item or a /orders route.

2. SIGN OUT
   Put it in the shell, not buried on a screen. Supabase signOut, then send
   them to /auth.

3. AUTH BEHAVIOUR
   Unauthenticated visits already redirect to /auth. Add the other half: if
   ANY api call returns 401 mid-session, the token has expired. Sign out and
   send them to /auth with a short message saying the session ended. Do not
   leave them on a screen that silently fails to load.

4. ONE SHARED FETCH HELPER
   Right now each screen talks to the API its own way. Replace that with a
   single helper every screen uses. It must:
     - attach Authorization: Bearer <session.access_token>
     - on 401, trigger the sign-out behaviour above
     - on any other non-2xx, read { error } from the body and throw that
       message
     - on a network failure, throw a plain "Could not reach the server"

   This matters more than it looks. Every error the API returns is already
   written for a human, and the only reason a seller ever sees a generic
   failure is the frontend dropping the message.

5. CONSISTENT LOADING AND ERROR STATES
   Every screen that loads data has exactly three states, and never gets
   stuck between them:
     loading  -> a skeleton
     error    -> the message from the helper, plus a Retry button
     loaded   -> content, or an empty state

   A request that fails MUST leave the error state, never an endless spinner.
   Make sure every fetch has a catch that clears loading.

6. EMPTY STATES
   The account is new, so most screens are legitimately empty. Each empty
   state says what to do next and links there, rather than saying "no data":
     Products  -> no products yet, the launch path creates the first one
     Drops     -> no drops yet, a drop needs a product first
     Designs   -> upload your first design
     Dashboard -> no sales yet
     Payouts   -> connect a bank account to get paid

7. A NOT FOUND ROUTE
   Any unknown path shows a simple not-found page with a link back to
   /dashboard, rather than a blank screen.

DO NOT
- Do not change colours, fonts, spacing or any visual styling.
- Do not add screens that are not listed above.
- Do not add an Orders index or a /orders route.
```

### 7. New product, and browsing the catalog

Added 2026-08-19 alongside `POST /api/products`. Until then the launch path's
price step was the only thing that could make a product, and it shows as a
completed rung of a sequence afterwards, so a seller could build exactly one
product and had no route to a second.

**This also adds `GET /api/products`**, so the Products screen from prompt 1
should stop reading `dashboard.products[]` and use it. The note further up
about there being no list endpoint is now out of date for products.

```
Two changes.

1. THE PRODUCTS LIST HAS ITS OWN ENDPOINT NOW

   GET /api/products
     { products: [ { id, name, slug, status, createdAt,
                     variantCount, priceCents, unitCostCents } ] }

   Newest first. Switch the Products screen to this instead of reading
   dashboard.products[]. Everything else about that screen stays as it is.

2. A NEW PRODUCT FLOW, reachable from a button on the Products screen

   Three steps, one screen. Do not make it a wizard with separate pages.

   Step one, pick a garment:
     GET /api/catalog
       { blanks: [ { id, brand, model, decoration, imageUrl,
                     fromUnitCostCents } ] }

     Show them as a grid with the image, brand and model, and "from $X" using
     fromUnitCostCents. That number already includes our fee, so it is what
     the seller pays. Do not add anything to it.

     Selecting one loads the detail:
     GET /api/catalog?blank=<id>
       { id, brand, model, description, decoration, imageUrl,
         colors:     [ { name, hex, isDark } ],
         printAreas: [ { placement, widthIn, heightIn, minDpi } ],
         variants:   [ { id, color, size, inStock, unitCostCents } ] }

     Show the colours and sizes it comes in. This is browsing, not selecting
     variants: the product is created across every in-stock variant.

   Step two, pick a design (optional):
     GET /api/designs lists what they have uploaded. Let them choose one or
     skip. Skipping makes a product with no artwork attached yet.

   Step three, name and price it:
     POST /api/products
       { blankId, name, retailPriceCents, designId? }
     returns 201 with
       { productId, slug, variantCount, unitCostCents, marginCents }

     Show unitCostCents and marginCents live as they type the price, but ONLY
     after the server has told you them. Do not calculate margin in the
     frontend. Until they submit, show the cost from the catalog response.

     One price applies to every variant, same as the edit screen.

     On success go to /products/{productId}.

   ERRORS, all returned as { error } with wording meant for a person:
     - a name they already used: "You already have a product called X"
     - a price below cost: names the real cost in dollars
     - a blank with nothing in stock
   Show them as sent. Do not pre-validate the price yourself; the floor
   depends on the cheapest variant and only the server knows it.

EMPTY STATE
No designs uploaded yet is fine and common. Say so and link to Designs,
but still let them create a product without one.
```

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
