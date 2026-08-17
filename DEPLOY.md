# Deploying

First deployment, in order. Roughly 20 minutes.

`.env.local` is gitignored and Vercel never sees it — every secret has to be
entered again in the Vercel dashboard. That is not duplication to be tidied away;
it is the reason a leaked repo does not leak your Stripe account.

---

## 1. GitHub

Create an **empty private** repository at github.com/new — no README, no
.gitignore, no licence. Then, from the project folder:

```bash
git remote add origin https://github.com/<you>/commit-store.git
git branch -M main
git push -u origin main
```

Private matters. The repo carries no secrets, but it does carry the business
model, the pricing, and the vendor arrangement.

## 2. Vercel

vercel.com → Add New → Project → import the repo. Framework detects as Next.js;
the defaults are correct. **Do not deploy yet** — add the environment variables
first, or the first build ships a broken app and you debug a problem you already
know the answer to.

## 3. Environment variables

Settings → Environment Variables. Apply each to **Production, Preview and
Development**. Values come from your local `.env.local` unless noted.

| Variable | Value | Notes |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | copy | |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | copy | public by design |
| `SUPABASE_SERVICE_ROLE_KEY` | copy | **bypasses every access rule** |
| `STRIPE_SECRET_KEY` | copy | keep the `sk_test_` key |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | copy | public by design |
| `STRIPE_WEBHOOK_SECRET` | **new value, step 5** | the local one is for local only |
| `PRINTFUL_API_TOKEN` | copy | |
| `PRINTFUL_WEBHOOK_SECRET` | copy | |
| `CRON_SECRET` | copy | **without it the scheduled jobs return 503 and silently never run** |
| `NEXT_PUBLIC_ROOT_DOMAIN` | your Vercel host, e.g. `commit-store.vercel.app` | see the note on storefronts |
| `CORS_ALLOWED_ORIGINS` | your Lovable preview origin | e.g. `https://*.lovable.app` |
| `FULFILLMENT_LIVE` | `false` | **leave false** until a real garment has been made |

`FULFILLMENT_LIVE=false` is the one that stops a deployed app ordering real
garments. Printful has no sandbox; a submitted order is really printed and
really charged to you.

## 4. Deploy

Deploy. Then confirm:

- `https://<host>/` renders the marketing page
- `https://<host>/api/dashboard` returns `401` — that is correct, it means the
  route is live and refusing an unauthenticated request

## 5. Stripe webhook

Stripe Dashboard (**test mode**) → Developers → Webhooks → Add endpoint.

- URL: `https://<host>/api/webhooks/stripe`
- Events: `payment_intent.succeeded`, `payment_intent.payment_failed`,
  `payment_intent.amount_capturable_updated`, `charge.dispute.created`,
  `charge.refunded`

Copy the signing secret it shows and set `STRIPE_WEBHOOK_SECRET` in Vercel to
**that** value, then redeploy. It is different from your local one, and a
mismatch means every webhook is rejected as a forgery — which looks exactly like
Stripe being broken.

## 6. Cron

`vercel.json` schedules three jobs; Vercel picks them up on deploy. Check
Settings → Cron Jobs lists all three:

| Path | Schedule | |
|---|---|---|
| `/api/cron/retry-fulfillments` | every 10 min | orders paid but never submitted |
| `/api/cron/resolve-drops` | hourly | capture at threshold, release when short |
| `/api/cron/payouts` | daily 09:00 | pay sellers what has matured |

---

## Storefronts will not work yet, and that is expected

Storefronts resolve from a subdomain: `acme.ourdomain.com`. Vercel does not let
you wildcard `*.vercel.app`, so seller storefronts have nowhere to live until you
own a domain.

Working after this deployment: the marketing page, the whole API, webhooks, and
the scheduled jobs — which is everything a separately hosted dashboard needs.

When you have a domain: add it in Vercel, add `*.yourdomain.com` as a wildcard
domain, point DNS at Vercel, and set `NEXT_PUBLIC_ROOT_DOMAIN` to it.

## Before real money

- Rotate every secret that has been pasted into a chat window
- Switch Stripe to live keys **and** set `FULFILLMENT_LIVE=true` — in that order,
  and only after one real garment has been manufactured
