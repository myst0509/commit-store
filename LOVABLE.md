# Frontend handoff (Lovable)

All UI is built in Lovable as a separate app. This backend exposes an HTTP API
for it to call. Lovable cannot import from `lib/` — different codebase, different
domain — so everything it needs goes through `/api`.

| | |
|---|---|
| API base (this repo, on Vercel) | `https://commit-store-xuav.vercel.app` |
| Frontend (Lovable) | `https://commit-store.lovable.app` |

Two different hosts, which is why CORS and `APP_ORIGIN` both exist. CORS lives in
`proxy.ts`; if a call is blocked, add the exact origin from the browser console
to `CORS_ALLOWED_ORIGINS` in Vercel and redeploy.

**Newest work is at the top.** Paste what is under "Ready to paste", in the order
given. Everything below that is reference.

---

# Ready to paste

## 1. Prompt 25 — let the seller see their store

A seller can finish the whole guide and never see what they built, because
every store link points at a domain nobody has bought. Storefronts now resolve
by bare subdomain, so there is a working preview today. Full text under
[Prompt 25](#prompt-25).

## 2. Prompt 24 — light theme and conversion (applied)

The current one. Replaces prompts 22 and 23, which were dark and would repaint
each other. Full text below under [Prompt 24](#prompt-24).

## 3. Prompt 21 — density and motion (applied)

Status unconfirmed; it may have been partly applied before the theme work. If
the interface still feels bulky after 24, run this. Full text under
[Prompt 21](#prompt-21).

## 4. Prompt 19 — Google sign-in (did not land)

**Blocked** until Google is enabled in Supabase (Authentication → Providers,
with a client ID and secret from a Google Cloud OAuth consent screen). Optional:
prompt 20 already asks the seller what to call them, so this is a convenience.
Full text under [Prompt 19](#prompt-19).

---

# Rules that must not be undone

Decisions already applied and paid for. A later prompt that contradicts one of
these is wrong, and this has happened more than once.

**Navigation and the guide**

- There is **no permanent "Guide" nav item**. While the launch path is
  unfinished the guide *is* Home. A "Launch" item appears only once
  `progress.done === progress.total`, when Home becomes the store.
- `/launch` always renders the guide and is never hidden, so a bookmark works.
  Only its presence in the nav is conditional. While the guide is Home, it
  redirects to `/dashboard`.
- **Steps open in place.** Pressing a step never navigates. The row expands, or
  a modal for the ones needing room. The one exception is "Upload your first
  design", which goes to `/designs` and returns to Home afterwards.
- Twelve steps, three phases: make something, build your store, start selling.
  Do not rename, reorder or reword them.
- `sample` and `bank` are the only optional steps. "Not now" appears on those
  and only those, and sends `{ step, skip: true }`.

**Data honesty**

- **Never invent data.** If a screen needs a field, confirm it is in the
  response first. Past briefs described collections of products, audience tabs,
  follower counts, activity feeds and a products-using-this-design relationship.
  None of those exist.
- A **drop is one product** with a reservation threshold and a closing date. Not
  a collection, not a season.
- `percentToThreshold` is progress toward triggering *production*. It is not
  "percent ready" and must never be labelled that way.
- A **product spans every colour and size**, not one colourway. `priceCents` and
  `unitCostCents` are the lowest across enabled variants.
- **Greet by name only when there is one.** `seller.name` is null unless it was
  set. Never derive a name from an email address.

**Money**

- Every amount is integer cents. Divide by 100 to display only.
- Never calculate prices, fees, totals or margins. The server sends every number
  needed. The one exception is converting a typed dollar amount into cents on
  the way to the API.
- Price inputs show a `$` that is part of the field and cannot be deleted, and
  format as the seller types.

**Errors and states**

- Errors return `{ "error": "..." }` already written for a person. Show that
  message, not a generic one.
- A failed request must leave the loading state. Every fetch needs a catch that
  clears it.
- Empty states say what to do next and link there.

**Out of scope**

- Do not restyle seller storefronts. Those are themed per seller via
  `/settings` and are a separate surface.
- Do not create Supabase tables or query Supabase tables directly. Auth only.

---

# API reference

Base `https://commit-store-xuav.vercel.app`. Every authenticated request sends
`Authorization: Bearer <session.access_token>`. A 401 means sign in again.

## Collections and detail

| Endpoint | Returns |
|---|---|
| `GET /api/launch` | `{ store, progress {done,total,percent}, phases[], current, steps[] }` — each step has `key, day, phase, title, outcome, status, blockedBy, completedAt, optional` |
| `POST /api/launch` | `{ step, input }` to perform, or `{ step, skip: true }` for an optional one. Returns `{ step, result, progress, next }` |
| `GET /api/dashboard` | `{ seller {name,email}, store, earnings, bank, sales {orderCount, grossCents, recent[]}, payouts[], products[] }` |
| `GET /api/products` | `{ products: [{ id, name, slug, status, createdAt, variantCount, priceCents, unitCostCents }] }` |
| `POST /api/products` | `{ blankId, name, retailPriceCents, designId? }` → 201 `{ productId, slug, variantCount, unitCostCents, marginCents }` |
| `GET /api/products/{id}` | detail with `variants[]` and `artwork[]` |
| `PATCH /api/products/{id}` | `{ name?, description?, status?, retailPriceCents? }`, returns the GET shape |
| `GET /api/catalog` | `{ blanks: [{ id, brand, model, name, garmentType, decoration, decorationLabel, imageUrl, fromUnitCostCents }] }` |
| `GET /api/catalog?blank=<id>` | one blank with `colors[]`, `printAreas[]`, `variants[]` |
| `GET /api/designs` | filename, image, dimensions, created date, review status |
| `POST /api/designs/upload-url` | `{ filename }` → `{ uploadUrl, token, storagePath }` |
| `POST /api/designs` | `{ storagePath, filename, blankId? }` |
| `GET /api/drops` | `{ drops: [{ id, product{id,name,slug}, status, thresholdUnits, reservedUnits, unitsRemaining, percentToThreshold, opensAt, closesAt, resolvedAt }] }` |
| `POST /api/drops` | `{ productId, closesAt, thresholdUnits }` |
| `GET /api/orders/{id}` | items, customer, totals, earnings, shipment, timeline |
| `GET`/`PATCH /api/store` | `{ name, subdomain, status, url, customDomain, theme, bio, social, hasSold }` |
| `GET`/`PATCH /api/me` | `{ name, email, needsName }` |
| `GET`/`POST /api/connect/onboard` | payout onboarding status, and a link into Stripe |
| `GET /api/stores` | **public, no auth** — `{ newest[], topEarners[] }` for the marketing site |

## Things with no endpoint

- **There is no `GET /api/orders`.** The orders list comes from
  `/api/dashboard` → `sales.recent[]`, 25 most recent, no pagination. Orders
  have a detail route per id but no index.
- No activity or event feed.
- No products-using-a-design relationship.

## Uploading a design — three steps, and the middle one is easy to miss

1. `POST /api/designs/upload-url` `{ filename }` → `{ uploadUrl, storagePath }`
2. **Upload the file straight to `uploadUrl`.** Browser to Supabase Storage,
   never through our API, and **no Authorization header**.
3. Record it with the `storagePath` from step 1, via `POST /api/designs` or
   `POST /api/launch { step: "design", input: { storagePath, filename } }`.

Only png, jpg, jpeg, webp and svg. Never send `widthPx`/`heightPx`; the server
measures the real file and ignores anything the client claims. There is no URL
field anywhere in this flow.

## Store settings

`PATCH /api/store` takes `theme`, `bio` and `social`.

- **Theme replaces rather than merges**, which is what makes "remove this
  colour" expressible. Send the whole object.
- **Social takes handles, not URLs.** The server strips a leading `@` and pulls
  the handle out of a pasted profile link. `website` is the exception and takes
  a full `https://` address.
- The same rules apply in the guide's `style`, `story` and `socials` steps.
  Build one editor and use it in both places.

## Two things Lovable gets wrong by default

**It queries Supabase tables directly.** Vendor cost and the base/fee split are
hidden by column grants (migration 0002), so a direct query hits a permissions
error rather than returning data — and the fix it reaches for is `GRANT SELECT`,
which republishes the cost basis.

**It computes totals and margins in React.** Every number is already in the
response. Prices computed client-side are a fraud vector, and we are merchant of
record, so the chargeback is ours.

## Known dead link

`store.url` is `https://<subdomain>.<root domain>`, and no domain is bought yet —
`NEXT_PUBLIC_ROOT_DOMAIN` is still the Vercel host, which cannot be wildcarded.
Store links go nowhere until a real domain exists. Do not make "view your store"
prominent.

---

# What stays out of Lovable

Storefronts (`/s/[host]`) are server-rendered in the Next.js repo and stay
there. PROJECT.md requires crawlable HTML because sellers start with no
audience, and a client-rendered storefront hands that away. `/api/storefront`
exists for cart and live drop counters, not for rendering product pages.

The public marketing site was built in Lovable by decision, with the SEO
tradeoff understood; porting it to server-rendered is a pre-launch task.

---

# Prompts

Pending ones first. Applied ones are logged at the bottom without their text —
what they decided is in "Rules that must not be undone" above.

<a id="prompt-25"></a>

## Prompt 25 — let the seller see their store

A seller can finish all twelve steps and has never once been able to look at
what they built. `store.url` points at a subdomain on a domain nobody has
bought, so every "view your store" link is dead.

Storefronts now resolve by bare subdomain, so `/s/<subdomain>` on the API host
works today with no domain at all. Both `/api/dashboard` and `/api/store` return
it as `previewUrl`.

```
Give the seller a way to see their storefront.

BOTH URLS ARE NOW RETURNED
  store.url         where it WILL live once a domain exists. Dead today.
  store.previewUrl  where it can be seen right now. Works.

Use previewUrl for anything a seller clicks. Keep url only as text showing the
address they will eventually have, and never link it.

WHERE IT BELONGS

1. On Home, once the store is live, a clear "View your store" that opens
   previewUrl in a new tab. This is the payoff for finishing the guide, so it
   should not be a small link in a corner.

2. On the Launch step, after it succeeds: their store is live, here is where it
   is. That moment is the one the whole guide builds to.

3. In Settings beside the web address, as "Preview".

4. On a published product, a way to see that product on the storefront:
   previewUrl + "/p/" + product.slug

BE HONEST ABOUT WHAT IT IS
Do not present previewUrl as their final address, because it is not: it lives
on our API host. Something like "Your store is live. While your address is
being set up, view it here." One line, no apology, no banner.

A DRAFT STORE HAS NO PREVIEW
Storefronts only resolve for stores with status "active". Before the launch
step, previewUrl returns 404, so do not show the link until store.status is
"active".

WHAT THE STOREFRONT NOW SHOWS
The bio from "Say who you are" and the links from "Add your links" render on
the storefront. Both were being saved and never displayed. Nothing to build
here, but it is worth telling the seller that filling those steps in changes
what customers see.
```

---

<a id="prompt-24"></a>

## Prompt 24 — light theme and conversion


Prompt 22 was started and interrupted, and its palette is dark, which 23 then
replaces. Running them in sequence would paint the app dark and then repaint it
light, on top of a half-applied state.

**This is 22's substance with 23's colours, as one paste. Do not run 22 or 23.**

```
Apply a light theme and tighten the interface for clarity and conversion.

Colours, hierarchy and copy emphasis only. No changes to routes, data
fetching, business logic, or the guide's steps and their wording. Every rule
from the earlier prompts about density, spacing, motion and plain language
still applies.

===========================================================
PALETTE — light. Every value is measured against WCAG.
===========================================================

  bg              #FFFFFF   the page
  surface         #F7F8FA   cards, raised rows, grouped panels
  surface-2       #EFF1F4   hover, selected

  text            #16181D   primary            17.76:1
  muted           #4A4F57   secondary           8.24:1
  faint           #6A6E76   captions, meta      5.12:1

  accent          #4F5BC4   fills AND text      5.79:1 both ways
  positive        #357F5A   4.84:1
  danger          #C44848   4.81:1

  separator       #E6E9EE   decorative row lines only
  control-border  #929599   inputs, selects, any edge that means something

If the app is currently dark, replace every dark value. Do not keep a mix.

ONE ACCENT, BOTH JOBS
On white, #4F5BC4 works as a fill with white text on it AND as text on the
page. There is no second accent token. Do not introduce one.

TWO KINDS OF BORDER, AND THE DIFFERENCE MATTERS
  separator       is decoration. A hairline between rows. Keep it faint.
  control-border  is information. It shows where a field begins, and 3:1 is
                  the minimum for a UI component boundary. Lightening it to
                  look tidier makes inputs invisible to anyone with low
                  vision.

FAINT HAS A FLOOR
#6A6E76 is set so it still passes on the hover surface (4.52:1 on #EFF1F4),
not just on white. Do not lighten it for rows that change on hover.

DEPTH WITHOUT SHADOWS
  page          #FFFFFF
  card on it    #F7F8FA with an #E6E9EE hairline
  hovered       #EFF1F4
No drop shadows.

60-30-10
  60%  white and the near-white surfaces
  30%  text, muted, separators
  10%  accent, positive and danger together
In practice: one accent-filled button per view, plus the active nav item. On
white, colour reads louder than it did on black, so if anything be stricter.

===========================================================
CALL TO ACTION
===========================================================

  primary     #4F5BC4 fill, #FFFFFF label. SOLID. Never ghost, never outline,
              never a text link.
  secondary   #F7F8FA fill, #16181D label, #929599 border
  tertiary    text only, muted, for minor things like Cancel

ONE primary per screen. If two things look equally primary, neither is.

Buttons say what happens, in the seller's words:
  "Name your brand"        not  "Submit"
  "Upload your design"     not  "Continue"
  "Put my store live"      not  "Launch"

Destructive actions use danger and never sit beside the primary action.

FOCUS
2px accent ring with a 2px offset, via :focus-visible so it shows for
keyboards and not mouse clicks. 5.79:1 on white, above the 3:1 required.

===========================================================
HIERARCHY AND SCANABILITY
===========================================================

Someone should understand a screen without reading it. Three levels, no more:
  1. What this screen is, and the one thing to do
  2. The content
  3. Supporting detail, in muted or faint

  - One h1 per screen. Everything else is smaller.
  - The primary action is above the fold and visually heaviest.
  - Numbers a seller cares about — what they earn, what is ready, how many
    reserved — get size. Their labels stay small and muted.
  - Left-align text. Centred paragraphs are slower to scan.
  - Line length caps around 70 characters.
  - Group with space, not with borders.

===========================================================
CONVERSION, WHICH HERE MEANS FINISHING THE GUIDE
===========================================================

What is being converted is a first-time brand owner getting from signup to a
live store. Every step is a chance to stop.

  SAY WHAT HAPPENS, NOT WHAT IT IS CALLED
  Each step carries an `outcome` from the API — "Creates your storefront",
  "Shows what you earn per sale". Show it. It answers "why am I doing this".

  SHOW PROGRESS HONESTLY
  "4 of 12" and a thin bar. Visible movement is the strongest reason to keep
  going.

  REDUCE VISIBLE EFFORT
  Never render twelve steps as twelve identical demands. Expand the current
  phase; collapse the others to a title and a count.

  ONE DECISION AT A TIME
  A step's form shows only that step's fields. Nothing else competes.

  REMOVE DEAD ENDS
  Every empty state has an action. Every error says what to do next. Every
  locked step says what unlocks it.

  NEVER FAKE URGENCY
  No countdowns, no "3 people are viewing", no invented scarcity or social
  proof. This audience is risking their own money on a first business, and a
  manipulative pattern costs their trust permanently.

===========================================================
THE AUDIENCE
===========================================================

Someone starting their first clothing brand. Not technical, no audience, no
money to lose, quite likely unsure they are allowed to be doing this.

  - Plain words. "Earnings", not "ledger". "Clears in 14 days", not "net 14".
  - Never assume they know what a blank, a DTG print or a drop is.
  - Money is explained wherever it appears: what they pay, what they keep.
  - Confidence without hype. No exclamation marks, no emoji, no "You're
    crushing it".

===========================================================
DO NOT
===========================================================
- Do not leave any dark values behind. Replace the palette wholesale.
- Do not add a second accent token.
- Do not lighten control-border to make forms look cleaner.
- Do not use a ghost or outline button for a primary action.
- Do not add drop shadows, centre body text, or invent urgency.
- Do not restyle seller storefronts; those are themed by sellers in /settings.
- Do not change routes, data or business logic.
```

**On the public marketing site:** it can stay dark. A dark landing page leading
into a light workspace is a deliberate pattern and the homepage already reads
well. Say so explicitly if you want it light too.

---

<a id="prompt-21"></a>

## Prompt 21 — density and motion


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

---

<a id="prompt-19"></a>

## Prompt 19 — Google sign-in


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

---

# Applied prompts

Their text is gone; what they decided lives in "Rules that must not be undone".
Kept as a log so a later prompt contradicting one of them is recognisable.

| | What it did |
|---|---|
| 1 | Products screen |
| 2 | Drops screen |
| 3 | Order detail |
| 4 | Payouts |
| 5 | Store settings — name, web address, theme |
| 6 | App shell, nav, shared fetch helper, loading states |
| 7 | New product flow and catalog browsing |
| 8 | Guide as home; store view once the path completes |
| 9 | Public homepage, how-it-works, store directory |
| 10 | One home; Launch tab arrives on completion |
| 11 | First visual direction — **superseded by 24** |
| 12 | Linear direction — **palette superseded by 24** |
| 13 | Steps open in place, not on another page |
| 14 | Design upload is a file, not a link |
| 15 | Garments as a page, side panel, dollar prices |
| 16 | Dropdown contrast — **rolled into 24** |
| 17 | Twelve steps in three phases |
| 18 | Full UI refinement, corrected against the real API |
| 20 | "What should we call you?" |
| 22, 23 | Contrast and light theme — **merged into 24** |

## The original brief

The first message the project was built from. Kept for the record; the API
shapes in it are out of date and the reference above supersedes them.

```
Build a seller dashboard for "Commit", a platform where people start independent
clothing brands. Sellers design products, we handle manufacturing and payments.

STACK
- React + Tailwind + shadcn/ui
- Supabase ONLY for authentication. Do NOT create any database tables, and do
  NOT query Supabase tables directly. All data comes from the REST API.

SUPABASE (auth only)
  URL:  https://aktehepmvbaxuidpdzjh.supabase.co
  Key:  sb_publishable_558KPS3oSPx8TqocywYekQ_Pl2_0FVs

DESIGN DIRECTION
The user is starting their first clothing brand. They are not technical and have
no audience. One clear action per screen. Never show jargon — say "earnings",
not "ledger"; "waiting to clear", not "net 14". Empty states should tell them
what to do next, not just say "no data".

DO NOT
- Do not create Supabase tables or use the Supabase database client.
- Do not calculate prices, totals, fees or margins anywhere in the frontend.
- Do not build a storefront or checkout — those are handled elsewhere.
```
