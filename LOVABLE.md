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

### 9. The public homepage

Built in Lovable by decision 2026-08-19, with the tradeoff understood: this is
the most SEO-critical page on the platform and a client-rendered version cannot
be crawled well. Acceptable for now because there is no domain and no
customers. Porting it to server-rendered in the Next.js repo is a pre-launch
task, not a never task.

```
Add a PUBLIC marketing site in front of the app. Everything below is visible
to people who are not signed in.

FIRST, FIX THE REDIRECT
Right now any unauthenticated visit bounces to sign in. That must stop for
public routes. Signed-out visitors see the public pages normally; only the
dashboard routes require a session.

The public pages do NOT use the dashboard shell. No sidebar, no seller nav.
They get their own simple header: the Commit wordmark on the left, and
"Sign in" plus "Get started" on the right, both going to /auth.

ROUTES
  /              home
  /how-it-works  the explainer
  /stores        the full directory

HOME

A greeting and a short line saying what this is, then the directory.

Data comes from GET /api/stores. This endpoint is PUBLIC — send no
Authorization header, and do not require a session to call it.

  {
    newest:     [ { name, subdomain, url, productCount, coverImageUrl, openedAt } ],
    topEarners: [ { name, subdomain, url, productCount, coverImageUrl, rank } ]
  }

Two sections:

  "New stores"      -> from newest
  "Highest earners" -> from topEarners, a horizontally scrolling row of cards

topEarners is ordered by how much each seller has earned, best first, and
carries NO amounts on purpose. Show the store and its rank. Never show,
imply, estimate or invent a figure, and do not write anything like "top
earning store making $X".

BOTH SECTIONS CAN BE EMPTY, AND USUALLY WILL BE AT FIRST
  - topEarners comes back empty until at least five stores qualify. When it
    is empty, hide the whole section. Do not show an empty shelf or a
    placeholder.
  - newest currently has ONE store in it. The layout has to look deliberate
    with one, three or thirty cards. Do not build a grid that only works
    full.

STORE LINKS DO NOT WORK YET
The `url` field points at a subdomain on a domain that is not configured. For
now render cards as non-clickable, or link to a store page inside this app if
you build one. Do not send visitors to a dead link.

/how-it-works

The explainer for someone deciding whether to sign up. ONLY make the claims
listed here. Do not invent features, numbers, timelines or testimonials.

  - Starting a clothing brand normally means buying stock up front. This does
    not.
  - It is free. No subscription and no cut of sales.
  - You design it, we handle printing, shipping and payments.
  - Nothing is made until people order. You never buy inventory.
  - A guided setup walks you through it step by step, from naming your brand
    to opening your store.

Do NOT say: how many days setup takes, how much anyone earns, how many
sellers or stores exist, anything about samples or marketing tools, or any
claim about speed of delivery.

/stores

The full directory. Same data, more of it: GET /api/stores?limit=24. Same
rules about empty states and dead links.

TONE
The reader is someone who has thought about starting a clothing brand and
assumed it was out of reach. Plain and direct. No hype, no growth-hacking
voice, no exclamation marks. Do not use the word "empower".

DO NOT
- Do not send an Authorization header to /api/stores.
- Do not show or imply any seller's earnings.
- Do not put the dashboard nav on public pages.
- Do not change the signed-in screens.
```

### 10. One home, and a Launch tab that arrives later

`/launch` and `/dashboard` render the same thing while the launch path is
unfinished, so the nav has two entries for one page. The fix is not to delete
the route but to show it in the nav only once it stops being a duplicate.

```
There should only ever be one home in the navigation.

/dashboard is the home. /launch stays a real route and always renders the
guide. What changes is when it appears in the nav.

Drive it off GET /api/launch -> progress:

  done < total   the guide IS the dashboard, so a Launch nav item would point
                 at the page they are already on. Hide it. Nav shows Home,
                 Designs, Products, Drops, Payouts, Settings.

  done === total  the dashboard has become the store, so the guide now lives
                 somewhere of its own. Show Launch in the nav, pointing at
                 /launch and the completed guide.

So the tab arrives rather than disappearing. A seller finishes the last step,
their home turns into their store, and the guide moves into the nav where
they can go back to it whenever they want.

Do not hide /launch itself at any point. A seller who bookmarks it, or is
sent a link, should always land on the guide. Only its presence in the
navigation is conditional.
```

### 11. Visual direction

The look, given 2026-08-19: vibrant and forward-looking, not calm and papery.
Sellers should feel like they are building something new.

This supersedes the "calm, confident, uncluttered" line in the original prompt
on tone of *appearance*. It does not supersede the rules about plain language,
one clear action per screen, or honest empty states.

```
Restyle the app. This is appearance only: do not change routes, data, logic
or what any screen does.

THE FEELING
Someone using this is making something that did not exist before. It should
feel energetic and modern, like a tool for building, not like a bank or a
stationery shop. Confident, high contrast, unafraid of colour.

Avoid the default AI-startup look: no purple-to-blue gradients, no glassy
frosted cards everywhere, no floating blobs.

PALETTE, as a starting point rather than a rule
  ink        #0A0A0F   near-black canvas
  surface    #14141C   raised cards and panels
  line       #26263400 hairlines, low contrast
  text       #F5F5F7   primary
  muted      #9A9AAB   secondary text
  accent     #00E5A0   electric green, the one loud colour
  warn       #FF6B4A   coral, used sparingly for attention

Dark canvas, one vivid accent used decisively. The accent carries actions,
progress and success. Do not spread it evenly over everything, it stops
meaning anything.

Check contrast. Mid-tone accent as small text on dark usually fails; use it
for fills, borders and large type, and keep body copy in text/muted.

TYPE
A geometric sans for display and a neutral sans for body. Space Grotesk and
Inter from Google Fonts work well together.

Be bold with scale. Headings should be large and tight. Body stays calm and
readable at 15 to 16px. The contrast between the two is most of the feeling.

MOTION
Quick and purposeful, 150 to 250ms. Things that change state should visibly
change: a completed step, a rising progress bar, a saved value. Nothing that
loops, nothing decorative, nothing that delays an action.

WHERE TO BE LOUD, AND WHERE NOT
Loud: the public site, the guide, empty states, the moment a store goes live.
These are the moments worth celebrating.

Quiet: anything with money on it. Earnings, payouts, order totals, the price
editor. These stay plain, high contrast and unornamented. People are trusting
you with their income, and a screen about money should look like it is being
careful. Vibrancy here reads as a toy.

DO NOT
- Do not change routes, data fetching, or any screen's behaviour.
- Do not restyle seller storefronts. Those are themed by each seller through
  /settings and are not part of this.
- Do not add a light/dark toggle unless asked.
```

### 12. Visual direction, take two: Linear

**Replaces the palette in prompt 11.** The green wash it produced was wrong.
Reference is linear.app.

Note this shifts the brief: Linear is not vibrant, it is restrained. Colour
becomes rare and deliberate rather than energetic everywhere. Prompt 11's
"loud on the guide, quiet on money" still holds, but "loud" now means one
confident accent and generous space, not saturation.

```
Restyle the app to feel like linear.app. Appearance only: do not change
routes, data, logic or behaviour.

FIRST, REMOVE WHAT IS THERE
Take out the green accent and the green wash or underlay behind sections
entirely. Nothing should keep that colour.

WHAT ACTUALLY MAKES LINEAR LOOK LIKE LINEAR
It is not "a dark theme with purple". Four things do the work:

1. The interface is nearly monochrome. Greys carry almost everything, and
   colour appears rarely enough that it means something when it does.
2. Surfaces barely separate from the background. A card is a few percent
   lighter, with a hairline border, not a distinct panel.
3. Type is the design. Tight tracking on headings, modest sizes, careful
   hierarchy, plenty of space around it.
4. Colour appears as atmosphere, not as fill. A soft wide glow behind a hero.
   Never a coloured card, never a coloured section background.

PALETTE
  bg          #08090A   page
  surface     #0F1011   cards, panels
  surface-2   #16181A   hover, raised
  border      rgba(255,255,255,0.07)   hairlines, never a solid grey line
  text        #F7F8F8   primary
  muted       #8A8F98   secondary
  faint       #62666D   timestamps, captions
  accent      #5E6AD2   indigo, the only colour
  positive    #4CB782   success only
  danger      #EB5757   errors only

Use accent for primary buttons, focus rings, links, active nav and progress.
Nothing else should be coloured. If a screen has more than a few accent
elements on it, that is too many.

TYPE
Inter throughout, from Google Fonts.
  display   28-40px, weight 600, letter-spacing -0.02em
  heading   16-20px, weight 600, letter-spacing -0.01em
  body      14px, weight 400, line-height 1.6
  small     13px for secondary, 12px for captions

Smaller than feels natural, with more space around it. Density with air, not
big type shouting.

SHAPE AND DEPTH
  radius    6px for buttons and inputs, 8px for cards. No pill shapes.
  shadows   almost none. Separate things with borders and background, not
            drop shadows.
  glow      one soft radial accent glow behind the public hero, very low
            opacity, blurred wide. Nowhere else.

MOTION
100-200ms, ease-out. Hovers change background a few percent. Nothing bounces,
nothing slides far, nothing loops.

THE HEADER
A blurred translucent bar over the content, with a hairline bottom border.
This is the one frosted surface in the app.

DO NOT
- Do not colour section backgrounds or cards.
- Do not use gradients on buttons or text.
- Do not add a second accent colour.
- Do not increase border contrast to make edges "clearer". Hairlines are the
  point.
- Do not change routes, data or behaviour.
- Do not restyle seller storefronts; those are themed by sellers in /settings.
```

### 13. Steps happen on the home page, not on another page

Bug from prompt 10: pressing "Start this step" navigates to `/launch`, which
renders a second copy of the guide. The home page should BE the guide, and a
step should be performed without leaving it.

```
Fix the guide so steps are done in place.

1. NO STEP EVER NAVIGATES TO /launch
   Pressing a step's button must not change the page. Open its form right
   there on the home page: expand the card in place, or a modal for the ones
   that need room, like the garment picker. Pick one pattern and use it
   everywhere.

   On success, POST /api/launch returns { result, progress, next }. Refetch
   GET /api/launch and update the board in place. The card becomes completed,
   the next one unlocks, the progress moves. No navigation, no reload.

   On error, show the message from { error } next to the form and leave what
   they typed alone. Do not close the form and lose their input.

2. /launch STOPS BEING REACHABLE WHILE THE GUIDE IS THE HOME
   While progress.done < progress.total, /launch redirects to /dashboard.
   There must be exactly one page showing the guide at any time.

   Once progress.done === progress.total, /launch renders the completed guide
   and appears in the nav, as prompt 10 describes. That does not change.

3. ONE STEP IS ALLOWED TO NAVIGATE
   "Upload your first design" goes to /designs, because uploading is its own
   screen with its own flow. That is fine. After a successful upload, bring
   them back to the home page with that step showing complete, rather than
   leaving them on /designs wondering what happened.

   Every other step stays on the home page.

FORMS EACH STEP NEEDS, all posted to POST /api/launch as
{ step: "<key>", input: { ... } }

  name       { name }                        text field
  design     handled on /designs
  blank      { blankId }                     picker from GET /api/catalog
  price      { blankId, designId, name, retailPriceCents }
  drop_date  { productId, closesAt, thresholdUnits }
  waitlist   {}                              no input, just confirm
  launch     {}                              no input, just confirm

The last two take no input, so they should be a single confirm rather than a
form with nothing in it.
```

### 14. Uploading a design is a file upload, not a link

"Upload the file before recording it" means the design step was called without
an uploaded file. The UI is asking for a URL; it needs a file picker.

Backend fixed 2026-08-19: the step no longer wants `publicUrl` — which nothing
ever produced, so this could not have worked — and now reads the bytes out of
storage instead. It needs `storagePath` and nothing else.

```
Fix the design upload. It must take a FILE, not a link. Remove any field that
asks for an image URL.

THREE STEPS, in order. The middle one goes straight to Supabase, not to our
API.

1. Ask for an upload link
     POST /api/designs/upload-url   { filename: "logo.png" }
     -> { uploadUrl, token, storagePath }

   Only png, jpg, jpeg, webp and svg are accepted. Anything else comes back
   400 with a message naming the extension.

2. Send the file to that link
   Upload the raw file to `uploadUrl`. This is a Supabase signed upload URL,
   so it goes directly from the browser to storage and never through our API.
   Do NOT send an Authorization header to it.

3. Record it
   From the Designs screen:
     POST /api/designs   { storagePath, filename, blankId? }
   From the launch guide:
     POST /api/launch    { step: "design", input: { storagePath, filename } }

   Send back the storagePath from step 1, exactly as given. Nothing else
   identifies the file.

WHAT COMES BACK
The server downloads the file, measures the real pixels, and checks it will
print. The response carries the measured dimensions, the largest size it can
print at, and any warnings. Show those; they are the point of the step.

Artwork that is too small to print at any size is rejected with a message
saying so. Show it and let them pick a different file.

DO NOT
- Do not offer a URL field anywhere in this flow.
- Do not send widthPx or heightPx. The server measures the file itself and
  ignores anything the client claims.
- Do not send an auth header to the Supabase upload URL.
- Do not skip step 1 and invent a storagePath. Paths are issued by the server
  and one belonging to another seller is rejected.
```

### 15. Garments as a real page, and six fixes from using it

Feedback from walking the guide, 2026-08-19. Two backend changes landed with
this: steps can now be skipped, and `GET /api/launch` tells you which ones.

```
Six fixes. The first is the big one.

1. GARMENTS ARE A PAGE, NOT A DROPDOWN OF IDS

   Right now "Set your price" shows a select full of uuids like
   fd2685d6-3ad4-4bdf-a770-0000375a22e3. Nobody can choose a t-shirt from
   that.

   Build /garments, a real browsing page.

   GET /api/catalog
     { blanks: [ { id, brand, model, decoration, imageUrl,
                   fromUnitCostCents } ] }

   A grid of cards: the stock photo from imageUrl, the brand and model as the
   title, and "from $X" using fromUnitCostCents. That number already includes
   our fee, so it is what the seller pays. Do not add anything to it.

   Clicking one opens its detail:
   GET /api/catalog?blank=<id>
     { id, brand, model, description, decoration, imageUrl,
       colors:     [ { name, hex, isDark } ],
       printAreas: [ { placement, widthIn, heightIn, minDpi } ],
       variants:   [ { id, color, size, inStock, unitCostCents } ] }

   Show the colours, the sizes, what it costs, and what it can be printed
   with. This is the page where someone decides what to make.

2. PRICING HAPPENS ON THE GARMENT, NOT IN A MODAL OF UUIDS

   From a garment's detail page, "Use this garment" opens the create flow with
   that garment already chosen. The seller then picks a design and sets a
   price with the garment visible in front of them.

   POST /api/products { blankId, name, retailPriceCents, designId? }

   The launch guide's price step links here rather than rendering its own
   form. A step may hand off to a page when the work needs room; it just has
   to come back to the home page afterwards, the same way the design step
   does.

3. PRICE IS DOLLARS, NOT CENTS

   Never show a field labelled "Price (in cents)".

   The input shows a "$" that is part of the field and cannot be deleted. They
   type digits, and it formats as they go: 1250 becomes $12.50. Two decimal
   places always.

   Multiply by 100 and send whole cents as retailPriceCents. That conversion
   is fine — the rule against pricing arithmetic is about fees, margins and
   totals, which the server owns. Converting a typed amount into the unit the
   API takes is not that.

4. NAVIGATION IS A SIDE PANEL

   Replace the bottom panel with a collapsible left sidebar, open by default,
   with a toggle. Everything should be reachable from it rather than buried:
   Home, Garments, Designs, Products, Drops, Payouts, Settings, and Launch
   once it appears. On narrow screens it collapses to icons or slides over.

5. THE DESIGN RESULT NEEDS TO BE READ, NOT FLASHED

   After an upload succeeds the app shows the measurements and immediately
   jumps to the next step, so nobody can read it.

   Stay put. Show what came back — the measured pixels, the largest size it
   prints at, any warnings — and let them press Continue. Moving on is their
   decision, not a timer's.

6. "NOT NOW" NOW WORKS, BECAUSE IT HAS SOMETHING TO CALL

   Ordering a sample is not built, and until now nothing could get past it,
   which made the rest of the path unreachable.

   GET /api/launch now returns `optional: true` on steps that can be skipped.
   Only "Order your sample" is.

   Show "Not now" ONLY where optional is true. It calls:
     POST /api/launch { step: "sample", skip: true }

   The step comes back as "skipped", which counts as done, and the next one
   unlocks. Render skipped differently from completed: it was passed over,
   not achieved.

   Do not show "Not now" on any other step. The server refuses it and will
   say so.
```

### 16. Dropdowns are unreadable

The dark palette landed on pages but not on menus. Selects and dropdowns are
rendering text and background at the same colour, so the options are invisible.

```
Fix the dropdowns. Text and background must never be the same colour.

WHY IT HAPPENS
Two different causes, and both need doing:

1. Floating layers do not inherit the page. Popovers, select menus, dropdown
   menus, comboboxes, dialogs and tooltips render in a portal at the top of
   the document, so a dark background set on a page container never reaches
   them. They fall back to their default light styling, or to no background
   at all over dark text.

   Set the surface colours on the components themselves, not on a wrapper.
   If you are using shadcn/ui, that means SelectContent, DropdownMenuContent,
   PopoverContent, DialogContent and CommandDialog each need an explicit
   background, text colour and border.

2. A native <select> is styled by the operating system. Setting a colour on
   the <select> does not reach its <option> elements, which on some platforms
   keep a white background. Either set background and colour on BOTH the
   select and its options, or replace native selects with the component
   version.

APPLY THE TOKENS EVERYWHERE
  menu background   surface   #0F1011
  hovered item      surface-2 #16181A
  text              text      #F7F8F8
  secondary text    muted     #8A8F98
  border            rgba(255,255,255,0.07)
  selected item     accent    #5E6AD2

CHECK THESE SPECIFICALLY, they are the ones that are broken now
  the garment select on the price step
  the design select
  any product picker on the drops screen
  date pickers
  the account menu in the sidebar

Then go through every menu in the app and confirm you can read it. A menu
whose text matches its background is not a styling preference, it is an
unusable control.

WHILE YOU ARE THERE
Check contrast on disabled and placeholder text too. Muted grey on a dark
surface is the other place this goes wrong, and it usually goes unnoticed
because the text is still faintly visible.
```

### 17. The guide covers building the store, not just dropping

Reshaped 2026-08-19. It was a single run at launching a drop, which left a
seller with a live store that was a bare product grid. Twelve steps now, in
three phases. **Apply prompt 16 first** — several of these are dropdowns.

Backend is done and deployed. `GET /api/launch` gains `phases` and a `phase`
on every step.

```
Rework the guide for a longer, grouped sequence.

GET /api/launch now returns:
  progress: { done, total, percent }        total is 12 now, not 8
  phases:   [ { key, title, blurb } ]       make, build, sell
  steps:    [ { key, day, phase, title, outcome, status, blockedBy,
                completedAt, optional } ]

GROUP THE BOARD BY PHASE, in the order phases arrives:

  Make something     name, design, blank, price
  Build your store   style, story, socials, sample
  Start selling      bank, drop_date, waitlist, launch

Show each phase with its title and blurb, and its own progress. Finishing a
phase should feel like finishing something. Do not flatten all twelve into one
list.

THE FOUR NEW STEPS

  style    POST /api/launch { step: "style", input: { theme: {...} } }
           theme takes bg, fg, accent, muted, radius. Colour pickers, not hex
           fields. Show a small live preview of a storefront card. At least
           one value is required.

  story    POST /api/launch { step: "story", input: { bio } }
           A short introduction shown on their storefront. Under 500
           characters; the server says how long theirs is if it is over.
           Show a live character count.

  socials  POST /api/launch { step: "socials", input: { social: {...} } }
           Keys: instagram, tiktok, youtube, x, website.
           Send HANDLES, not URLs. The server strips a leading @ and pulls the
           handle out of a pasted profile link, so all three work. website is
           the exception and takes a full https:// address.
           At least one is required, or they can skip the step.

  bank     POST /api/launch { step: "bank", input: {} }
           This CONFIRMS rather than performs. Connecting happens on Stripe.
           Send them to /settings/payouts to connect, then this button checks
           whether Stripe says payouts are enabled. If not, the error names
           what Stripe is still waiting for. Optional, because a store can open
           without one and the earnings just wait.

TWO STEPS ARE OPTIONAL: sample and bank
Both come back with optional: true. Show "Not now" on those and only those,
calling POST /api/launch { step, skip: true }. Skipped renders differently
from completed — passed over, not achieved.

STYLE, STORY AND SOCIALS ARE ALSO IN SETTINGS
PATCH /api/store takes theme, bio and social with the same rules. A seller who
did them in the guide must be able to change them later in /settings, and the
values must match in both places. Do not build two different editors; build one
and use it in both.
```

### 18. The full UI refinement pass

A rewrite of a ChatGPT-authored brief, 2026-08-19. Its design direction was
sound and is kept almost intact. What it got wrong was the data: it described
several screens for things this API does not return, and it quietly reversed
two fixes already made. Corrections are noted after the prompt.

```
Refine the UI of the existing Commit application.

This is a UI and UX pass. Do NOT rebuild the product, remove functionality,
change business logic, alter which API endpoints are called, or change the
guide's steps or copy.

THE FEELING
Someone using this is building a clothing company, not filling in a setup
checklist. Minimal, premium, technical, calm, fast, precise. Slightly
editorial. Linear as inspiration for hierarchy, spacing, typography, density
and interaction, not for branding, logo or layouts.

Avoid: generic SaaS template, Shopify clone, crypto dashboard, a screen full
of cards, a traditional e-commerce admin panel.

COLOUR
Dark first, and already partly in place. Keep it and refine.
  app background   #08090A
  surfaces         #0D0E10, #111214
  borders          very subtle, hairline, low-alpha white
  text             near white
  muted            grey
  faint            darker grey
  accent           the existing indigo, used sparingly

Accent belongs on primary buttons, active nav, progress, links and focus
states. Nothing else. Do not flood the interface with it.

TYPOGRAPHY
A clean modern sans in the spirit of Inter. Confident page titles, noticeably
smaller and muted supporting text. Few weights. Establish hierarchy with
spacing and type rather than by putting a border around everything.

FEWER CARDS
This is the biggest visual change. The interface currently leans on large
bordered rectangles. Replace most of them with spacing, subtle separators and
compact rows. Use a card only where it groups things meaningfully.

Dense enough for a power user, simple enough for a beginner.

NAVIGATION
A persistent, quiet left sidebar on desktop. Narrow, small line icons, very
subtle active state. It should not compete with the workspace.

  Commit
  ----------
  Home
  Garments
  Designs
  Products
  Drops
  Payouts
  ----------
  Settings

IMPORTANT: there is no permanent "Guide" item. While the launch path is
unfinished the guide IS Home, so a Guide entry would point at the page the
seller is already on. A "Launch" item appears in the nav only once
progress.done equals progress.total, when Home becomes the store. That
behaviour already exists, so keep it.

On tablet the sidebar narrows; on mobile it collapses to the existing
slide-out behaviour, visually refined. Do not just shrink the desktop layout.

HEADER
A consistent header: Commit on the left, contextual location in the middle,
and search, help and the user menu on the right. Subtle breadcrumbs, not large
decorative headings.

COMMAND MENU
Add a global command menu on Cmd+K and Ctrl+K: jump to any section, plus
Create product, Upload design, Create drop.

THE GUIDE
Twelve steps in three phases, exactly as they are. Do not change the steps,
their order, or their wording.

  MAKE SOMETHING    name, design, garment, price
  BUILD YOUR STORE  style, story, links, sample
  START SELLING     bank, drop date, waitlist, launch

Present it as a project roadmap rather than a column of big cards.

  Getting your brand open
  Three phases, twelve steps. Finish what is open and the next part unlocks.

  4 / 12                                              33%
  [========================                        ]

Keep the progress bar thin.

Each phase reads as a section, numbered, with its blurb and its own count:

  01  MAKE SOMETHING
      A design on a real garment, priced so you earn on every sale.
      4 / 4
  -----------------------------------------

Steps are compact rows, not full-width cards:

  01   Name your brand                                    >
       Creates your storefront

  [lock]  Upload your first design
       Checks your artwork is high enough resolution to print
       LOCKED - Complete "Name your brand" first

Locked steps stay readable. Muted, not invisible. The seller should see what
it is, why it matters and what is blocking it.

Status marks small and quiet: an open circle for available, a half circle for
in progress, a check for complete, a padlock for locked. No large circles, no
colourful badges.

Hover changes the background slightly and brings the arrow forward. Fast,
subtle.

CRITICAL: STEPS OPEN IN PLACE
Pressing a step must NOT navigate to another page. The form opens on the home
page: the row expands, or a modal for the ones needing room like the garment
picker. On success, refetch GET /api/launch and update the board where it
stands.

There are no separate step pages and no /launch/<step> routes. Breadcrumbs
should reflect the section, not imply a step is its own page.

The ONE exception: "Upload your first design" goes to /designs, because
uploading is its own flow, and returns to Home afterwards.

HOME
While the guide is unfinished, Home IS the guide, with a short line above it:

  Your brand is 33% ready
  Continue where you left off, next up: Choose your garment

Greet by name ONLY when there is one. GET /api/dashboard returns
seller: { name, email }, where name is null unless the person signed in with
Google and consented. Null means no greeting, not a fallback: never derive one
from the email address. See prompt 19.

Do NOT add a "Recent activity" feed. No endpoint returns an event history and
it would have to be fabricated.

Once the guide is finished, Home becomes the store: earnings, recent orders,
products, and a link to the live storefront.

GARMENTS
A clean library, table and grid hybrid rather than large cards.
GET /api/catalog returns exactly:
  { id, brand, model, decoration, imageUrl, fromUnitCostCents }

  Garment                     Decoration        From
  Bella + Canvas 3001         DTG, embroidery   $18.00
  Gildan 5000                 DTG, DTF          $15.56

There is no "type" field and no availability status, so do not invent columns.
Keep the price: it is what a seller most needs to see. fromUnitCostCents
already includes our fee, so render it as sent.

DESIGNS
A clean grid, generous spacing. GET /api/designs returns filename, image,
dimensions, created date and a review status. Show those.

Do NOT show "products using this design". That relationship is not returned by
any endpoint.

PRODUCTS
The seller's catalogue. GET /api/products returns
  { id, name, slug, status, createdAt, variantCount, priceCents, unitCostCents }

A product spans EVERY colour and size, not one. Do not present it as a single
colourway. priceCents and unitCostCents are the lowest across enabled
variants.

DROPS
Read this carefully, because it is the screen most likely to be built wrong.

A drop here is ONE product with a reservation threshold and a closing date. It
is not a collection, not a season, and not a set of products. One open drop per
product, enforced by the server.

GET /api/drops returns
  { id, product: { id, name, slug }, status, thresholdUnits, reservedUnits,
    unitsRemaining, percentToThreshold, opensAt, closesAt, resolvedAt }

Present each as a project-style row:

  First Tee
  18 of 25 reserved, 7 to go
  [==============      ]  72%
  Closes in 6 days

percentToThreshold is progress toward the number of reservations that triggers
production. It is NOT "percent ready" and must never be labelled that way.
Mislabelling it tells a seller their launch is nearly prepared when it actually
means customers are nearly enough to start manufacturing.

Do NOT build: an audience tab, follower counts, waitlist member counts, launch
teasers, social post scheduling, or a content section. None of that data
exists.

PAYOUTS
Keep the functionality. Make it feel like a financial product.

  READY FOR YOU     $0.00
  WAITING TO CLEAR  $0.00
  EARNED ALL TIME   $0.00

Compact horizontal sections, not giant empty boxes. Keep the explanation that
money clears 14 days after delivery, as secondary text.

MENUS AND DROPDOWNS
Every popover, select, dropdown, dialog and tooltip needs an explicit
background, text colour and border. They render in a portal, so a background
set on a page container never reaches them, and they are currently unreadable
in places. Native select options are styled by the operating system, so set
colours on the options too, or use the component version.

PRICES
Any price input shows a dollar sign that is part of the field and cannot be
deleted, formats as they type, and sends whole cents.

MICROINTERACTIONS
Fast and subtle, 100 to 250ms: sidebar active state, row hover, progress
animation, button hover, step completion, the unlock when a prerequisite
finishes. Nothing loops, nothing is decorative.

DO NOT
- Do not change any API call, request shape, or piece of business logic.
- Do not rename or reorder the guide's steps, or rewrite their copy.
- Do not restyle seller storefronts. Those are themed by each seller through
  /settings and are a separate surface.
- Do not invent data. If a screen needs a field, check it is in the response
  first. Several ideas in earlier briefs described data this API does not
  return.
```

**What was corrected from the original brief, and why**

*Invented data.* The Drops section described collections of twelve products,
an audience tab, follower and waitlist counts, launch teasers and social
scheduling. A drop is one product with a threshold. It also labelled
`percentToThreshold` as "82% ready", which inverts its meaning. Garments gained
a "Type" and "Status" column that do not exist and lost the price, which is the
column that matters. Products were shown as a single colourway. Designs claimed
a products-using-this-design relationship no endpoint returns. Home greeted the
seller by name, and there is no name, only an email. It also added an activity
feed with no source.

*Two decisions it reversed.* It put a permanent "Guide" item in the nav, which
prompt 10 deliberately removed because the guide is Home until the path is
finished. And its breadcrumbs and step pages implied navigating away to perform
a step, which is the exact bug prompt 13 fixed.

*A hardcoded domain.* `yourbrand.commit.store` does not exist; no domain is
bought and `NEXT_PUBLIC_ROOT_DOMAIN` is still the Vercel host.

### 19. Sign in with Google, and greeting by name

Added 2026-08-19. `GET /api/dashboard` now returns a `seller` object:

```
seller: { name, email }
```

`name` comes from the OAuth provider's metadata and is **null** for
email-and-password signups, because nothing ever asked them. It is deliberately
NOT derived from the email address: `sohamp1005@gmail.com` would yield
"Sohamp1005", and a mangled address is a worse greeting than none.

**Requires Supabase configuration first.** In the Supabase dashboard under
Authentication → Providers, enable Google and paste in a client ID and secret
from a Google Cloud OAuth consent screen. Until that is done the button will
not work, and nothing about the prompt below can be tested.

```
Add Google sign-in, and a greeting that only appears when it is real.

1. GOOGLE SIGN-IN

On /auth, add "Continue with Google" above the email and password fields,
with a divider between them. Use Supabase's OAuth flow with the google
provider, redirecting back to the app.

Keep email and password exactly as it is. This is an additional way in, not a
replacement, and existing accounts must keep working.

Google asks the person to share their name and email. When they agree,
Supabase stores the name in the user's metadata and our API returns it.

2. THE GREETING

GET /api/dashboard now returns:
  seller: { name, email }

name is a real name or null. There is no third case.

  name present   "Good morning, Soham"
  name null      no greeting at all

Do NOT fall back to the email address, to the part before the @, or to any
capitalised or prettified version of it. Do not write "Good morning, there" or
"Good morning, friend". If we do not know, say nothing and start with the
content.

Time of day from the browser: morning, afternoon, evening.

3. WHAT TO SHOW WHEN THERE IS NO NAME

The store name is always known, so lead with the work instead of the person:

  Your brand is 33% ready
  Continue where you left off, next up: Choose your garment

That line is more useful than a greeting anyway, so it should appear whether
or not a name exists. The greeting sits above it when we have one.

DO NOT
- Do not invent, guess or derive a name.
- Superseded by prompt 20: the name is now asked for once after sign-in, and
  Google's name, when present, pre-fills that question.
- Do not remove email and password sign-in.
```

### 20. "What should we call you?"

Decided 2026-08-19: ask the person, once, after sign-in. Works for every
account regardless of how they signed up, and lets them choose what they go by
rather than reading a legal name off a payment method.

Backend is `GET` and `PATCH /api/me`:

```
GET  /api/me         -> { name, email, needsName }
PATCH /api/me        { name }  -> same shape
```

`name` is validated: trimmed, whitespace collapsed, control characters
stripped, 40 characters or fewer. Send `null` to clear it. This replaces the
Google-only greeting in prompt 19; Google sign-in can still be added, and if it
supplies a name that name pre-fills the question.

```
Ask the seller what to call them, once, and use it.

1. THE QUESTION

Right after sign-in, if GET /api/me returns needsName: true, show a single
small screen before the dashboard:

  What should we call you?
  Your name, or whatever you'd rather go by.

  [                              ]

  Continue          Skip for now

That last line of copy matters. It is not "enter your full name". People go by
shortenings, chosen names and handles, and this is theirs to decide.

Continue sends PATCH /api/me { name }. Skip goes straight to the dashboard and
does not ask again this session. Ask again next sign-in only while needsName
is still true; once they have answered or explicitly skipped twice, stop.

If the field is pre-filled because Google supplied a name, show it as the
default and let them change it before continuing.

Errors come back as { error } with the real reason, for instance a length
message that says how many characters they typed. Show it beside the field.

2. THE GREETING

GET /api/dashboard returns seller: { name, email }.

  name present   "Good morning, Sam"
  name null      no greeting

Time of day from the browser: morning, afternoon, evening. No fallback to the
email address or any part of it, ever.

3. CHANGING IT LATER

In /settings, an "About you" section with one field, the name, calling
PATCH /api/me. Clearing the field and saving sends null, and the greeting goes
away rather than reverting to something else.

DO NOT
- Do not derive a name from the email address.
- Do not block the dashboard behind the question. Skip must always work.
- Do not put a nag banner on the dashboard for people who skipped.
- Do not call supabase.auth.updateUser from the browser for this. Go through
  PATCH /api/me, which is where the validation lives.
```

### 21. Density and motion — the pass that removes the "AI-made" feel

Feedback after 18 and 20 landed: still bulky, still reads as generated. Two
causes, and only the second is about animation.

**Bulky is a spacing and type problem, not a motion problem.** Fading in an
oversized layout gives you an oversized layout that fades. So this prompt fixes
proportions first and adds motion second.

Techniques are checked against current browser support: `@starting-style` has
been Baseline since August 2024, so entry animations need no library.
`sibling-index()` only reached Baseline in August 2026, so the stagger uses a
React-set custom property instead, which works everywhere.

```
Two changes: tighten the proportions, then add motion. No new dependencies —
no framer-motion, no animation library. Modern CSS does all of this.

===========================================================
PART 1 — DENSITY. This is what makes it feel generated.
===========================================================

The interface is too big everywhere. Uniform generous padding, oversized type
and a card around everything is exactly the look of a generated UI. Real
numbers to hit:

  TYPE
    page title        24px, weight 600, tracking -0.02em
    section heading   15px, weight 600
    body / rows       13.5-14px, weight 400
    secondary         13px, muted
    caption / meta    12px, faint
  Nothing on a dashboard should be 32px or larger except a single hero number.

  SPACING
    page padding          24px, 32px on wide screens
    space between sections 32px
    space inside a group   12px
    list row vertical      10-12px, giving a 36-40px row
  A list row is one line of text with a second muted line at most. It is not a
  144px tall card.

  SHAPE
    radius        6px, 8px on the largest surfaces only. No pill shapes.
    borders       1px hairline at low alpha. Never a solid grey line.
    shadows       none. Depth comes from background, not drop shadows.

  WIDTH
    Tables and lists run to about 1100px. Do not centre everything in a narrow
    640px column with big margins — that is what makes a dashboard feel like a
    landing page.

  DELETE CARDS
    If a card contains one number, or one row, or a single form field, remove
    the card and keep the content. A border is only justified when it groups
    several things that belong together.

===========================================================
PART 2 — MOTION
===========================================================

Rules for every animation in the app:
  duration   120-200ms. Nothing longer. Hovers 80-120ms.
  easing     ease-out for entry, ease-in for exit. Never a spring, never a
             bounce, never overshoot.
  properties opacity and a 4-6px translate. Never scale on lists or rows.
  budget     one thing moves at a time. If two animations overlap, cut one.

MANDATORY: every animation must be disabled or reduced under
@media (prefers-reduced-motion: reduce). Keep a short fade, drop all movement.

  1. ENTRY, when content first renders
     Use @starting-style with a normal CSS transition. It is Baseline and needs
     no JavaScript:

       .row {
         opacity: 1;
         translate: 0;
         transition: opacity 160ms ease-out, translate 160ms ease-out;
       }
       @starting-style {
         .row { opacity: 0; translate: 0 4px; }
       }

     If an element is toggled via display or the hidden attribute, add
     `transition-behavior: allow-discrete` as its OWN declaration, not inside
     the transition shorthand, and include display in the transition list.

  2. STAGGER, for lists and the guide's steps
     Set the index as a custom property when rendering, then use it as a delay:

       {items.map((item, i) => (
         <Row key={item.id} style={{ "--i": i }} />
       ))}

       .row { transition-delay: calc(var(--i, 0) * 30ms); }

     30ms per item, and cap the total: after the 8th item use the same delay
     for everything, or a long list turns into a slow wave.

     Do not use sibling-index() — it only became widely available in August
     2026 and the React approach above works everywhere.

  3. STATE CHANGES worth animating
     A step turning complete, a locked step unlocking when its prerequisite
     finishes, a progress bar advancing, a row appearing after creation. These
     are the moments that make the product feel alive. Everything else can be
     instant.

  4. NOTHING THAT LOOPS
     No pulsing dots, no shimmer that never stops, no floating gradients.

===========================================================
PART 3 — INTERACTIVITY
===========================================================

Sleek is mostly about response time, not animation.

  HOVER
    Rows lift their background a few percent and reveal their trailing action
    or chevron. 80ms. The cursor changes on anything clickable.

  FOCUS
    A visible focus ring on every interactive element, using :focus-visible so
    it appears for keyboards and not for mouse clicks. Accent colour, 2px,
    with a small offset. Never remove outlines without replacing them.

  KEYBOARD
    Cmd+K / Ctrl+K   command menu (already specified)
    /                focus the search field
    Up / Down        move through a list
    Enter            open the focused item
    Escape           close a modal, panel or menu
    Tab order must follow what you see on screen.

  OPTIMISTIC UPDATES
    This does more for perceived speed than any animation. When a seller
    completes a step, renames a product or saves a colour, update the screen
    immediately and reconcile when the response lands. On failure, roll back
    and show the server's message.

    Never show a spinner on a button for an action that usually succeeds in
    under a second.

  SKELETONS THAT MATCH
    A loading skeleton must be the same shape and height as the content that
    replaces it. If the layout jumps when data arrives, the skeleton is wrong.

  EMPTY IS NOT LOADING
    An empty list renders its empty state instantly. Do not show a skeleton
    for something already known to be empty.

===========================================================
DO NOT
===========================================================
- Do not add framer-motion, GSAP, or any animation dependency.
- Do not animate layout properties like width, height, top or left. Use
  opacity and translate.
- Do not stagger anything longer than about 8 items.
- Do not add page-level transitions between routes. They delay every
  navigation and Linear does not use them.
- Do not change any API call, data shape or business logic.
```

### 22. Contrast, hierarchy and conversion

Direction 2026-08-19: fix layer, colour and typography; high-contrast solid
CTAs, no ghost buttons; an accessible palette on 60-30-10; and optimise for
conversion — clarity, scanability, and making it easy to say yes — rather than
for prettiness.

**Three values in the palette from prompt 12 and 18 actually fail WCAG.**
Measured, not assumed:

| | Ratio | Needs | |
|---|---|---|---|
| `faint` `#62666D` on background | 3.45:1 | 4.5:1 | **fails** |
| `accent` `#5E6AD2` as link text | 4.24:1 | 4.5:1 | **fails** |
| `#F7F8F8` label on an accent button | 4.42:1 | 4.5:1 | **fails** |

The cause of the last two is that **one accent cannot do both jobs**. A fill
dark enough for white text to sit on is too dark to read as text against a
near-black background. So the palette below splits it in two, which is what
mature systems do.

**This adjusts prompt 12's restraint rather than replacing it.** Linear-style
quiet is right for surfaces where someone works — lists, settings, tables.
Directive, high-contrast design is right where someone decides. Those are
different rooms, and the guide's next action, the public site and any primary
button live in the second.

```
Fix contrast, hierarchy and the way actions read. Appearance and copy
emphasis only: no changes to routes, data or logic.

===========================================================
PALETTE — every value below is measured against WCAG
===========================================================

  bg              #08090A   page
  surface         #0F1011   cards, rows, raised panels
  surface-2       #16181A   hover, selected
  border          rgba(255,255,255,0.08)

  text            #F7F8F8   primary            18.73:1
  muted           #9CA1AA   secondary           7.68:1
  faint           #7C818A   captions, meta      5.09:1

  accent-fill     #4F5BC4   button backgrounds  white on it: 5.79:1
  accent-text     #8B95E8   links, active nav   7.18:1 on bg

  positive        #4CB782   7.97:1
  danger          #EB5757   5.73:1

TWO ACCENTS, USED FOR DIFFERENT THINGS
  accent-fill  is a background. Put #FFFFFF on it, never #F7F8F8, which drops
               below 4.5:1.
  accent-text  is a foreground. Links, the active nav item, a highlighted
               number. Never use accent-fill as text on the page background.

Do not use the old #5E6AD2 for either. It sits between the two roles and fails
at both.

60-30-10, on a dark interface
  60%  bg and surface. Most of the screen is near-black and does nothing.
  30%  text, muted and borders. The content itself.
  10%  accent, positive and danger, together. If more than roughly a tenth of
       a screen carries colour, remove some.
On a dashboard that usually means ONE accent-filled button per view, plus the
active nav item. Everything else earns attention through size and position.

===========================================================
CALL TO ACTION
===========================================================

The primary action on any screen is a SOLID accent-fill button with white
text. Never a ghost button, never an outline, never a text link.

  primary     accent-fill background, #FFFFFF label
  secondary   surface-2 background, text label, hairline border
  tertiary    text-only, muted, for genuinely minor things like Cancel

ONE primary per screen. If two things look equally primary, neither is.

Buttons say what happens, in the seller's words. Not "Submit", not "Continue"
where something more specific is true:

  "Name your brand"          not  "Submit"
  "Upload your design"       not  "Continue"
  "Put my store live"        not  "Launch"
  "Set my price"             not  "Save"

Destructive actions use danger, and never sit next to the primary action.

===========================================================
HIERARCHY AND SCANABILITY
===========================================================

Someone should understand a screen without reading it. Three levels, no more:

  1. What is this screen, and what is the one thing to do
  2. The content
  3. Supporting detail, in muted or faint

Rules that get you there:
  - One h1 per screen. Everything else is smaller.
  - The primary action sits above the fold and is visually heaviest.
  - Numbers a seller cares about — what they earn, what is ready, how many
    reserved — get size. Labels stay small and muted.
  - Left-align text. Centred paragraphs are slower to scan.
  - Line length caps at about 70 characters.
  - Group related things with space, not with borders.

===========================================================
CONVERSION, WHICH HERE MEANS FINISHING THE GUIDE
===========================================================

The thing being "converted" is a first-time brand owner getting from signup to
a live store. Every step is a chance to stop. So:

  SAY WHAT HAPPENS, NOT WHAT IT IS CALLED
  Each step already carries an `outcome` from the API — "Creates your
  storefront", "Shows what you earn per sale". Show it. It answers "why am I
  doing this" before they ask.

  SHOW PROGRESS HONESTLY
  "4 of 12" and a thin bar. Progress that is visibly moving is the single
  strongest reason to continue.

  REDUCE VISIBLE EFFORT
  Never show twelve steps as twelve identical demands. The phases already
  group them; show the current phase expanded and the others collapsed to a
  title and a count.

  ONE DECISION AT A TIME
  A step's form shows only the fields that step needs. Nothing else on screen
  competes.

  REMOVE DEAD ENDS
  Every empty state has an action. Every error says what to do next. Every
  locked step says what unlocks it.

  NEVER FAKE URGENCY
  No countdowns, no "3 people are viewing", no invented scarcity. The audience
  is someone risking their own money on a first business; a manipulative
  pattern costs their trust permanently and it is not worth the click.

===========================================================
THE AUDIENCE
===========================================================

Someone starting their first clothing brand. Not technical, no audience, no
money to lose, and quite likely unsure they are allowed to be doing this.

  - Plain words. "Earnings", not "ledger". "Clears in 14 days", not "net 14".
  - Never assume they know what a blank, a DTG print or a drop is. Say it in
    the sentence.
  - Money is explained wherever it appears: what they pay, what they keep.
  - Confidence without hype. No exclamation marks, no "🎉", no "You're
    crushing it".

===========================================================
DO NOT
===========================================================
- Do not use a ghost or outline button for a primary action.
- Do not use accent-fill as text, or #F7F8F8 as a label on accent-fill.
- Do not add colour beyond the 10%.
- Do not centre body text.
- Do not invent urgency, scarcity or social proof.
- Do not change routes, data or business logic.
```

### The public directory endpoint

`GET /api/stores` is public, no auth. It serves the marketing home, which
lives in the Next.js repo rather than here — but the shape is recorded so both
sides agree.

```
{
  newest:     [ { name, subdomain, url, productCount, coverImageUrl, openedAt } ],
  topEarners: [ { name, subdomain, url, productCount, coverImageUrl, rank } ]
}
```

`topEarners` is ordered by what sellers have actually earned, highest first,
and carries **no amounts** — only `rank`. A viewer cannot tell whether first
place earned ten dollars or ten thousand. Render it as a horizontally
scrolling row of cards, five by default. `?earners=10` asks for ten.

It comes back **empty** until at least five stores qualify. A ranking hides
amounts but not order, and a top five drawn from six stores tells everyone who
is last. Design the section to disappear cleanly rather than showing an empty
shelf.

### 8. The guide as home, and what replaces it after launch

The shape the seller experience should take, from 2026-08-19. This is
information architecture, not visual styling: colours, type and spacing are
still unspecified, so this prompt says nothing about them and the current look
should carry over untouched.

```
Rework the signed-in home so it changes as the seller progresses.

/dashboard is the home. What it shows depends on how far through the launch
path they are. Read GET /api/launch for that:
  { progress: { done, total, percent }, current: {...}, steps: [...] }

BEFORE THE LAUNCH PATH IS FINISHED (progress.done < progress.total)

The guide IS the home page. Not a checklist tucked in a corner, the main
thing on the screen.

Lay the 8 steps out as a board of cards they can look across, rather than a
single vertical list they scroll. Each card shows the step title, its
`outcome` line, and its state:
  completed  quiet, checked, with completedAt
  available  the one with an active button, visibly the next thing to do
  locked     dimmed, and says what it is waiting for from blockedBy

Clicking any card opens that step. A completed card opens what it produced,
so they can revisit their brand name or their design without hunting for it.
A locked card explains what comes first rather than doing nothing.

Show progress as "3 of 8" plus the percent. Sellers are three weeks into
this; they need to see it moving.

AT THE END OF THE BOARD, A PAYOUTS PREVIEW

After the last step card, show a small earnings panel. It is there to make
the point that this is how they get paid.

From GET /api/dashboard:
  earnings: { payableCents, pendingCents, lifetimeCents, payoutsHeld }
  bank:     { connected, ready }

Be honest about the state. It will read $0.00 with no bank connected, and
that is fine. Say what it will show once they sell, and link to
/settings/payouts to connect a bank. Never imply money is waiting when it
is not, and never present $0 as a failure.

AFTER THE LAUNCH PATH IS FINISHED (progress.done === progress.total)

The guide steps aside. It has done its job and should stop occupying the
home page.

/dashboard becomes the store: earnings, recent orders, products, and a
clear link to their live storefront (store.url from GET /api/dashboard).

Keep the guide reachable at /launch, showing all steps complete, so they can
still revisit what they made. Do NOT delete it, and do NOT keep it as the
first thing they see.

Make the transition feel like an arrival rather than a page quietly
changing. The first time they land on the finished version, say something
that marks it: their store is live, here is where it lives.

RULES
- Drive the switch off progress from GET /api/launch. Never off local state
  or a flag you keep yourself, or a seller on a second device sees the wrong
  home.
- Everything here uses endpoints that already exist. No new API is needed.
- Do not change colours, fonts or spacing. Visual direction is coming
  separately and a restyle now would be thrown away.
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
