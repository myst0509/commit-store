-- =====================================================================
-- 0001_init.sql — initial schema
--
-- Read PROJECT.md first. The constraints encoded here are business
-- constraints, not stylistic ones:
--
--   * We are merchant of record. Money flows through OUR Stripe account.
--     Seller margin is a liability we owe, not money they ever held.
--   * All money is integer cents (bigint). No float, no numeric, ever.
--     Floats lose pennies; numeric invites float-ish thinking.
--   * store_id is the tenancy boundary. Every seller-owned table carries
--     it and every seller-facing query goes through RLS.
--   * Vendor-specific values live in *_external_id columns and are
--     opaque. No vendor field names appear as column names.
--
-- Run this in the Supabase SQL Editor, then confirm in the Table Editor
-- that RLS shows as enabled on every table.
-- =====================================================================

create extension if not exists "pgcrypto";   -- gen_random_uuid()
create extension if not exists "citext";     -- case-insensitive domains/emails


-- =====================================================================
-- SECTION 1 — Enumerated types
--
-- These mirror the closed unions in lib/fulfillment/types.ts. They are
-- OUR normalized vocabulary, not any vendor's, so it is safe for the
-- database to know them.
--
-- Note on enums: you can add a value later (ALTER TYPE ... ADD VALUE)
-- but you cannot remove one. If a list feels likely to churn, that is a
-- signal to use text + CHECK instead. These lists are stable by design.
-- =====================================================================

create type provider_id as enum ('printful', 'apliiq');

create type decoration_method as enum (
  'dtg', 'dtf', 'screen_print', 'embroidery', 'applique', 'sublimation'
);

create type placement_code as enum (
  'front', 'back', 'left_chest', 'right_chest',
  'sleeve_left', 'sleeve_right', 'neck_inner', 'neck_outer'
);

create type shipping_speed as enum ('standard', 'expedited', 'rush');

-- Mirrors FulfillmentStatus. 'unknown' exists so an unrecognized vendor
-- status is recorded loudly rather than silently dropped.
create type fulfillment_status as enum (
  'pending', 'submitted', 'in_production', 'shipped',
  'delivered', 'cancelled', 'failed', 'unknown'
);

-- Our order lifecycle, which is NOT the same thing as the vendor's.
-- 'reserved' = drop threshold not yet met, payment authorized not captured.
create type order_status as enum (
  'pending', 'reserved', 'paid', 'in_fulfillment',
  'shipped', 'delivered', 'cancelled', 'refunded'
);

create type payment_status as enum (
  'requires_payment', 'authorized', 'captured',
  'refunded', 'partially_refunded', 'disputed', 'failed'
);

create type review_status as enum ('pending', 'approved', 'rejected');

create type store_status as enum ('draft', 'active', 'suspended', 'closed');

create type product_status as enum ('draft', 'published', 'archived');

create type drop_status as enum ('open', 'threshold_met', 'in_production', 'fulfilled', 'failed_threshold', 'cancelled');

-- Ledger movement kinds. Positive amounts credit the seller, negative
-- amounts claw back. See SECTION 8.
create type ledger_kind as enum (
  'seller_margin',      -- earned on delivery, owed to seller
  'payout',             -- paid out to seller (negative)
  'refund_reversal',    -- customer refunded, margin clawed back (negative)
  'chargeback',         -- dispute lost, clawed back (negative)
  'adjustment'          -- manual correction, either sign
);

create type payout_status as enum ('scheduled', 'in_transit', 'paid', 'failed', 'cancelled');


-- =====================================================================
-- SECTION 2 — Helper functions
-- =====================================================================

-- Standard updated_at trigger.
create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- The ownership predicate used by nearly every policy is defined in
-- SECTION 3, immediately after the stores table it queries. Postgres
-- validates SQL function bodies at creation time, so it cannot be
-- declared before that table exists.


-- =====================================================================
-- SECTION 3 — Stores (the tenancy root)
-- =====================================================================

create table stores (
  id                    uuid primary key default gen_random_uuid(),
  owner_id              uuid not null references auth.users(id) on delete restrict,

  name                  text not null,
  -- Resolved by middleware: subdomain -> store_id. citext so 'Acme' and
  -- 'acme' cannot both be claimed.
  subdomain             citext not null unique,
  custom_domain         citext unique,
  custom_domain_verified_at timestamptz,

  status                store_status not null default 'draft',

  -- Vendor sub-store. One Printful "Manual orders / API platform" store
  -- per seller, created with OUR account-level token. Nullable because it
  -- is provisioned after signup. See the UNVERIFIED note in PROJECT.md
  -- about per-account store caps — if Printful caps this, the fallback is
  -- a single shared store and reconciliation by external_id, which this
  -- column simply stays null for.
  vendor_store_id       text,
  vendor_provider       provider_id,

  -- Stripe Connect Express account, for paying the seller out. Customers
  -- pay OUR account; this is only the payout destination.
  stripe_account_id     text unique,
  stripe_payouts_enabled boolean not null default false,

  -- Fraud controls (PROJECT.md "Known risks"). Payouts are held by
  -- default and released deliberately.
  payouts_held          boolean not null default true,
  first_sale_at         timestamptz,
  -- Cap on gross volume in the store's first month. Null = platform default.
  first_month_cap_cents bigint check (first_month_cap_cents is null or first_month_cap_cents >= 0),
  risk_notes            text,

  theme                 jsonb not null default '{}'::jsonb,

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  constraint subdomain_format check (subdomain ~ '^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$')
);

create index stores_owner_idx on stores(owner_id);
create index stores_status_idx on stores(status);

create trigger stores_updated_at
  before update on stores
  for each row execute function set_updated_at();


-- The ownership predicate every seller-facing policy is built on.
--
-- SECURITY DEFINER on purpose. If policies subqueried the stores table
-- directly, those subqueries would themselves be subject to stores' RLS —
-- both slow and a recursion hazard. STABLE lets the planner call it once
-- per statement rather than once per row. The pinned search_path stops a
-- caller from shadowing `stores` with their own table, which would
-- otherwise be a privilege-escalation route through a definer function.
create or replace function owns_store(target uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from stores
    where id = target and owner_id = auth.uid()
  );
$$;


-- =====================================================================
-- SECTION 4 — Catalog cache
--
-- A local mirror of vendor catalogs, populated by the adapter. Never hit
-- a vendor API on a page load. These tables are platform-global, not
-- per-store: every seller picks from the same blanks.
--
-- external_id is the vendor's identifier and is opaque to application
-- code — only lib/fulfillment/ knows what it means.
-- =====================================================================

create table catalog_blanks (
  id                    uuid primary key default gen_random_uuid(),
  provider              provider_id not null,
  external_id           text not null,

  brand                 text not null,          -- "Independent Trading Co."
  model                 text not null,          -- "SS4500 Midweight Hoodie"
  description           text,
  supported_decoration  decoration_method[] not null default '{}',
  image_url             text,

  -- Sellers only see blanks we have deliberately turned on.
  is_enabled            boolean not null default false,
  synced_at             timestamptz not null default now(),

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  unique (provider, external_id)
);

create index catalog_blanks_enabled_idx on catalog_blanks(provider, is_enabled);

create trigger catalog_blanks_updated_at
  before update on catalog_blanks
  for each row execute function set_updated_at();


create table catalog_colors (
  id                    uuid primary key default gen_random_uuid(),
  blank_id              uuid not null references catalog_blanks(id) on delete cascade,
  name                  text not null,
  hex                   text check (hex is null or hex ~* '^#[0-9a-f]{6}$'),
  -- Derived from hex luminance by the adapter. Used to block DTG on darks,
  -- which is the most common print-quality complaint across every vendor.
  is_dark               boolean not null default false,

  unique (blank_id, name)
);

create index catalog_colors_blank_idx on catalog_colors(blank_id);


create table catalog_placements (
  id                    uuid primary key default gen_random_uuid(),
  blank_id              uuid not null references catalog_blanks(id) on delete cascade,
  code                  placement_code not null,
  -- Print area in inches. Kept as numeric because these are physical
  -- measurements, not money — the integer-cents rule is about money only.
  width_in              numeric(6,2) not null check (width_in > 0),
  height_in             numeric(6,2) not null check (height_in > 0),
  min_dpi               integer not null check (min_dpi > 0),

  unique (blank_id, code)
);

create index catalog_placements_blank_idx on catalog_placements(blank_id);


create table catalog_variants (
  id                    uuid primary key default gen_random_uuid(),
  blank_id              uuid not null references catalog_blanks(id) on delete cascade,
  provider              provider_id not null,
  external_id           text not null,

  color                 text not null,
  size                  text not null,
  -- What the vendor charges us, before our fee. Integer cents.
  -- Printful returns this as a dollar STRING; the adapter converts.
  base_cost_cents       bigint not null check (base_cost_cents >= 0),
  in_stock              boolean not null default true,

  synced_at             timestamptz not null default now(),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  unique (provider, external_id)
);

create index catalog_variants_blank_idx on catalog_variants(blank_id);

create trigger catalog_variants_updated_at
  before update on catalog_variants
  for each row execute function set_updated_at();


-- =====================================================================
-- SECTION 5 — Designs (seller artwork)
--
-- Vendors fetch artwork by URL rather than accepting bytes, so every
-- design needs a stable, publicly reachable URL.
--
-- review_status is the IP takedown defense from PROJECT.md: we are
-- merchant of record, so infringement claims come to us. Nothing reaches
-- a vendor unapproved.
-- =====================================================================

create table designs (
  id                    uuid primary key default gen_random_uuid(),
  store_id              uuid not null references stores(id) on delete cascade,

  filename              text not null,
  storage_path          text not null,     -- path within the 'artwork' bucket
  public_url            text not null,     -- what we hand the vendor
  width_px              integer check (width_px is null or width_px > 0),
  height_px             integer check (height_px is null or height_px > 0),
  byte_size             bigint check (byte_size is null or byte_size >= 0),
  checksum              text,              -- dedupe identical uploads

  review_status         review_status not null default 'pending',
  reviewed_at           timestamptz,
  reviewed_by           uuid references auth.users(id),
  review_note           text,

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index designs_store_idx on designs(store_id);
create index designs_review_idx on designs(review_status) where review_status = 'pending';

create trigger designs_updated_at
  before update on designs
  for each row execute function set_updated_at();


-- =====================================================================
-- SECTION 6 — Products
--
-- A product is a seller's design applied to a catalog blank. It exists
-- in our database first; the vendor-side product is created lazily and
-- recorded in vendor_products.
-- =====================================================================

create table products (
  id                    uuid primary key default gen_random_uuid(),
  store_id              uuid not null references stores(id) on delete cascade,
  blank_id              uuid not null references catalog_blanks(id) on delete restrict,

  name                  text not null,
  slug                  citext not null,
  description           text,
  status                product_status not null default 'draft',

  decoration            decoration_method not null,

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  -- Slugs must be unique within a storefront, not globally.
  unique (store_id, slug)
);

create index products_store_status_idx on products(store_id, status);

create trigger products_updated_at
  before update on products
  for each row execute function set_updated_at();


create table product_artwork (
  id                    uuid primary key default gen_random_uuid(),
  product_id            uuid not null references products(id) on delete cascade,
  design_id             uuid not null references designs(id) on delete restrict,
  placement             placement_code not null,
  decoration            decoration_method not null,

  created_at            timestamptz not null default now(),

  -- One artwork per placement per product.
  unique (product_id, placement)
);

create index product_artwork_product_idx on product_artwork(product_id);


create table product_variants (
  id                    uuid primary key default gen_random_uuid(),
  product_id            uuid not null references products(id) on delete cascade,
  catalog_variant_id    uuid not null references catalog_variants(id) on delete restrict,

  -- What the customer pays. Integer cents.
  retail_price_cents    bigint not null check (retail_price_cents >= 0),

  -- Snapshot of the economics at the time of pricing, so a later catalog
  -- sync cannot silently rewrite what the seller was shown.
  --   seller-visible "product cost" = base_cost_cents + platform_fee_cents
  -- The seller never sees this split; only the sum. Our fee is a flat
  -- per-unit amount (~$4-6), never a percentage.
  base_cost_cents       bigint not null check (base_cost_cents >= 0),
  platform_fee_cents    bigint not null check (platform_fee_cents >= 0),

  is_enabled            boolean not null default true,

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  unique (product_id, catalog_variant_id)
);

create index product_variants_product_idx on product_variants(product_id);

create trigger product_variants_updated_at
  before update on product_variants
  for each row execute function set_updated_at();


-- Mapping from our products to the vendor's. Kept in its own table so a
-- product can exist with more than one vendor over its life (or be
-- re-created vendor-side without touching the product row).
create table vendor_products (
  id                    uuid primary key default gen_random_uuid(),
  product_id            uuid not null references products(id) on delete cascade,
  provider              provider_id not null,
  external_product_id   text not null,

  created_at            timestamptz not null default now(),

  unique (provider, external_product_id),
  unique (product_id, provider)
);


create table vendor_product_variants (
  id                    uuid primary key default gen_random_uuid(),
  vendor_product_id     uuid not null references vendor_products(id) on delete cascade,
  product_variant_id    uuid not null references product_variants(id) on delete cascade,
  external_variant_id   text not null,

  created_at            timestamptz not null default now(),

  unique (vendor_product_id, product_variant_id)
);

create index vendor_product_variants_variant_idx on vendor_product_variants(product_variant_id);


-- =====================================================================
-- SECTION 7 — Orders
--
-- The customer pays us. We pay the vendor. We owe the seller their
-- margin later. All three legs are recorded here and in SECTION 8.
--
-- idempotency_key is the anchor for the worst failure mode in
-- PROJECT.md: money taken, nothing manufactured. It is generated at
-- order creation and reused on every vendor submission attempt.
-- =====================================================================

create table orders (
  id                    uuid primary key default gen_random_uuid(),
  store_id              uuid not null references stores(id) on delete restrict,

  -- Human-facing, per-store sequential-ish reference shown to customers.
  order_number          text not null,

  -- Vendor submissions are idempotent on this. Globally unique.
  idempotency_key       text not null unique default gen_random_uuid()::text,

  status                order_status not null default 'pending',
  payment_status        payment_status not null default 'requires_payment',

  customer_email        citext not null,
  customer_name         text,

  -- Shipping address, flattened. Mirrors ShippingAddress in types.ts.
  ship_line1            text not null,
  ship_line2            text,
  ship_city             text not null,
  ship_state            text,               -- ISO 3166-2 subdivision where applicable
  ship_postal_code      text not null,
  ship_country          char(2) not null,   -- ISO 3166-1 alpha-2
  ship_phone            text,
  shipping_speed        shipping_speed not null default 'standard',

  -- Money, all integer cents. What the CUSTOMER paid:
  subtotal_cents        bigint not null default 0 check (subtotal_cents >= 0),
  shipping_cents        bigint not null default 0 check (shipping_cents >= 0),
  tax_cents             bigint not null default 0 check (tax_cents >= 0),
  discount_cents        bigint not null default 0 check (discount_cents >= 0),
  total_cents           bigint not null default 0 check (total_cents >= 0),

  -- What WE paid the vendor. Null until the vendor prices the order.
  vendor_cost_cents     bigint check (vendor_cost_cents is null or vendor_cost_cents >= 0),

  -- Our Stripe account. Not the seller's.
  stripe_payment_intent_id text unique,
  stripe_charge_id      text,

  -- Set when this order is a drop reservation (SECTION 10).
  drop_id               uuid,

  placed_at             timestamptz not null default now(),
  paid_at               timestamptz,
  delivered_at          timestamptz,
  cancelled_at          timestamptz,

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  unique (store_id, order_number)
);

create index orders_store_placed_idx on orders(store_id, placed_at desc);
create index orders_status_idx on orders(status);
create index orders_customer_email_idx on orders(customer_email);
create index orders_drop_idx on orders(drop_id) where drop_id is not null;

create trigger orders_updated_at
  before update on orders
  for each row execute function set_updated_at();


create table order_items (
  id                    uuid primary key default gen_random_uuid(),
  order_id              uuid not null references orders(id) on delete cascade,
  -- restrict, not cascade: a seller deleting a product must never erase
  -- the record of what was actually sold.
  product_variant_id    uuid not null references product_variants(id) on delete restrict,

  quantity              integer not null check (quantity > 0),

  -- Price snapshots. These are deliberately duplicated from
  -- product_variants so that repricing never rewrites history.
  unit_retail_cents     bigint not null check (unit_retail_cents >= 0),
  unit_base_cost_cents  bigint not null check (unit_base_cost_cents >= 0),
  unit_platform_fee_cents bigint not null check (unit_platform_fee_cents >= 0),

  created_at            timestamptz not null default now()
);

create index order_items_order_idx on order_items(order_id);


-- One row per attempt to place this order with a vendor. Separate from
-- orders because retries, vendor switches, and partial failures all need
-- their own history.
create table fulfillments (
  id                    uuid primary key default gen_random_uuid(),
  order_id              uuid not null references orders(id) on delete cascade,
  provider              provider_id not null,

  external_order_id     text,
  status                fulfillment_status not null default 'pending',
  -- The vendor's own status string, verbatim. Kept for debugging and for
  -- support tickets, never parsed by application code.
  raw_status            text,

  vendor_cost_cents     bigint check (vendor_cost_cents is null or vendor_cost_cents >= 0),
  shipping_cost_cents   bigint check (shipping_cost_cents is null or shipping_cost_cents >= 0),
  tax_cents             bigint check (tax_cents is null or tax_cents >= 0),

  tracking_number       text,
  tracking_url          text,
  carrier               text,
  estimated_delivery    date,

  -- Retry bookkeeping for the "vendor call failed" alert path.
  attempt_count         integer not null default 0 check (attempt_count >= 0),
  last_attempt_at       timestamptz,
  last_error            jsonb,
  next_retry_at         timestamptz,

  submitted_at          timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  -- One live submission per order per vendor. This is the database-level
  -- backstop against double-submitting; the adapter also checks for an
  -- existing order by external_id before creating one.
  unique (order_id, provider),
  unique (provider, external_order_id)
);

create index fulfillments_status_idx on fulfillments(status);
-- Drives the retry worker.
create index fulfillments_retry_idx on fulfillments(next_retry_at)
  where next_retry_at is not null;

create trigger fulfillments_updated_at
  before update on fulfillments
  for each row execute function set_updated_at();


-- Webhook dedupe. NormalizedWebhookEvent.externalEventId is the vendor's
-- event id, or a hash of the payload when they do not supply one.
create table webhook_events (
  id                    uuid primary key default gen_random_uuid(),
  provider              provider_id not null,
  external_event_id     text not null,
  event_type            text not null,
  external_order_id     text,
  payload               jsonb not null,

  processed_at          timestamptz,
  process_error         text,

  received_at           timestamptz not null default now(),

  unique (provider, external_event_id)
);

create index webhook_events_unprocessed_idx on webhook_events(received_at)
  where processed_at is null;


-- =====================================================================
-- SECTION 8 — Seller ledger and payouts
--
-- Seller margin is money we OWE, not money they hold. It is earned on
-- delivery, released net 14, and must remain clawable — a chargeback
-- lands on our Stripe account and has to be recoverable against a future
-- payout.
--
-- Hence a ledger of signed entries rather than a mutable balance column:
-- a balance you can only reach by summing history is a balance nobody
-- can quietly corrupt.
-- =====================================================================

create table ledger_entries (
  id                    uuid primary key default gen_random_uuid(),
  store_id              uuid not null references stores(id) on delete restrict,
  order_id              uuid references orders(id) on delete restrict,
  payout_id             uuid,   -- FK added after payouts exists

  kind                  ledger_kind not null,
  -- Signed. Positive credits the seller, negative claws back. No CHECK on
  -- sign, deliberately: chargebacks and payouts are negative by nature.
  amount_cents          bigint not null,

  -- Net 14 after delivery. Nothing is payable before this timestamp.
  available_at          timestamptz,

  description           text,
  created_at            timestamptz not null default now()
);

create index ledger_entries_store_idx on ledger_entries(store_id, created_at desc);
create index ledger_entries_payable_idx on ledger_entries(store_id, available_at)
  where payout_id is null;


create table payouts (
  id                    uuid primary key default gen_random_uuid(),
  store_id              uuid not null references stores(id) on delete restrict,

  amount_cents          bigint not null check (amount_cents > 0),
  status                payout_status not null default 'scheduled',

  stripe_transfer_id    text unique,
  scheduled_for         timestamptz not null,
  paid_at               timestamptz,
  failure_reason        text,

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index payouts_store_idx on payouts(store_id, created_at desc);

create trigger payouts_updated_at
  before update on payouts
  for each row execute function set_updated_at();

alter table ledger_entries
  add constraint ledger_entries_payout_fk
  foreign key (payout_id) references payouts(id) on delete set null;


-- Seller balance. Only entries past available_at and not already paid out
-- are payable; the rest are pending.
create or replace function store_balance(target uuid)
returns table (payable_cents bigint, pending_cents bigint)
language sql
stable
as $$
  select
    coalesce(sum(amount_cents) filter (
      where payout_id is null and available_at is not null and available_at <= now()
    ), 0)::bigint,
    coalesce(sum(amount_cents) filter (
      where payout_id is null and (available_at is null or available_at > now())
    ), 0)::bigint
  from ledger_entries
  where store_id = target;
$$;


-- =====================================================================
-- SECTION 9 — The launch path
--
-- The 21-day guided sequence. PROJECT.md is explicit that this is the
-- product's main differentiator and that every step is a BUTTON THAT
-- PERFORMS AN ACTION, never advice text. action_key is what the UI
-- dispatches on; there is no free-text "tip" column, on purpose.
--
-- launch_steps  = the step definitions, platform-global, seeded below.
-- store_progress = one row per store per step, the actual state.
-- =====================================================================

create table launch_steps (
  key                   text primary key,
  day_index             integer not null check (day_index >= 0),
  title                 text not null,
  -- What the button does. The application maps this to a handler.
  action_key            text not null,
  -- Steps that must be complete before this one unlocks.
  requires              text[] not null default '{}',
  is_active             boolean not null default true,

  created_at            timestamptz not null default now()
);

create index launch_steps_day_idx on launch_steps(day_index);


create table store_progress (
  id                    uuid primary key default gen_random_uuid(),
  store_id              uuid not null references stores(id) on delete cascade,
  step_key              text not null references launch_steps(key) on delete cascade,

  status                text not null default 'locked'
                          check (status in ('locked', 'available', 'completed', 'skipped')),
  completed_at          timestamptz,
  -- Result of the action, e.g. the id of the thing the button created.
  result                jsonb not null default '{}'::jsonb,

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  unique (store_id, step_key)
);

create index store_progress_store_idx on store_progress(store_id);

create trigger store_progress_updated_at
  before update on store_progress
  for each row execute function set_updated_at();


-- The eight steps PROJECT.md names explicitly. The full 21-day sequence
-- is not specified anywhere in the handoff — day_index values below are
-- placeholders and the remaining steps still need defining.
insert into launch_steps (key, day_index, title, action_key, requires) values
  ('name',      1,  'Name your brand',            'create_store',        '{}'),
  ('design',    3,  'Upload your first design',   'upload_design',       '{name}'),
  ('blank',     5,  'Choose your blank',          'select_blank',        '{design}'),
  ('price',     7,  'Set your price',             'set_price',           '{blank}'),
  ('sample',    9,  'Order your sample',          'order_sample',        '{price}'),
  ('drop_date', 12, 'Pick your drop date',        'schedule_drop',       '{sample}'),
  ('waitlist',  14, 'Open your waitlist',         'publish_waitlist',    '{drop_date}'),
  ('launch',    21, 'Launch',                     'publish_store',       '{waitlist}')
on conflict (key) do nothing;


-- =====================================================================
-- SECTION 10 — Drops and reservations
--
-- Production only triggers once the threshold is met. Below it,
-- reservations auto-refund. Sellers never front inventory cost, which
-- means payment is AUTHORIZED at reservation and CAPTURED only when the
-- threshold is met.
-- =====================================================================

create table drops (
  id                    uuid primary key default gen_random_uuid(),
  store_id              uuid not null references stores(id) on delete cascade,
  product_id            uuid not null references products(id) on delete cascade,

  threshold_units       integer not null default 25 check (threshold_units > 0),
  status                drop_status not null default 'open',

  opens_at              timestamptz not null default now(),
  closes_at             timestamptz not null,
  resolved_at           timestamptz,

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  constraint drop_window check (closes_at > opens_at)
);

create index drops_store_idx on drops(store_id);
create index drops_open_idx on drops(closes_at) where status = 'open';

create trigger drops_updated_at
  before update on drops
  for each row execute function set_updated_at();

alter table orders
  add constraint orders_drop_fk
  foreign key (drop_id) references drops(id) on delete set null;


-- Units reserved so far, against the threshold.
create or replace function drop_reserved_units(target uuid)
returns integer
language sql
stable
as $$
  select coalesce(sum(oi.quantity), 0)::integer
  from orders o
  join order_items oi on oi.order_id = o.id
  where o.drop_id = target
    and o.status not in ('cancelled', 'refunded');
$$;


-- =====================================================================
-- SECTION 11 — Cost discipline
--
-- PROJECT.md: every subsidized feature needs a per-account cap, a global
-- monthly budget, and a kill switch. All three live here so that no
-- subsidized feature can ship without them.
-- =====================================================================

create table feature_budgets (
  key                   text primary key,          -- 'subsidized_sample', 'bulk_email_import', ...
  -- The kill switch.
  is_enabled            boolean not null default false,
  -- Gate on first real sale, per PROJECT.md's free/gated split.
  requires_first_sale   boolean not null default true,
  -- Per-account cap, in uses per month.
  per_store_monthly_cap integer not null default 0 check (per_store_monthly_cap >= 0),
  -- Global monthly budget in integer cents.
  global_monthly_budget_cents bigint not null default 0 check (global_monthly_budget_cents >= 0),

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create trigger feature_budgets_updated_at
  before update on feature_budgets
  for each row execute function set_updated_at();


create table feature_usage (
  id                    uuid primary key default gen_random_uuid(),
  feature_key           text not null references feature_budgets(key) on delete cascade,
  store_id              uuid not null references stores(id) on delete cascade,
  -- First day of the month this usage counts against.
  period_month          date not null,

  use_count             integer not null default 0 check (use_count >= 0),
  cost_cents            bigint not null default 0 check (cost_cents >= 0),

  updated_at            timestamptz not null default now(),

  unique (feature_key, store_id, period_month)
);

create index feature_usage_period_idx on feature_usage(feature_key, period_month);

create trigger feature_usage_updated_at
  before update on feature_usage
  for each row execute function set_updated_at();


-- =====================================================================
-- SECTION 12 — Row Level Security
--
-- Every table below gets RLS enabled. The rule from PROJECT.md:
--
--   * Every user-facing query goes through RLS.
--   * Order processing and vendor calls run with the SERVICE ROLE, which
--     bypasses RLS entirely and must stay server-only.
--
-- Because the service role bypasses RLS, there are deliberately NO
-- insert/update policies on money tables. A seller cannot write their own
-- orders, fulfillments, ledger entries, or payouts under any circumstance
-- — only server code can.
--
-- Three audiences:
--   anon          — storefront visitors. Read published products only.
--   authenticated — sellers. Read/write their own store's content.
--   service_role  — our server. Bypasses all of this.
-- =====================================================================

alter table stores                  enable row level security;
alter table catalog_blanks          enable row level security;
alter table catalog_colors          enable row level security;
alter table catalog_placements      enable row level security;
alter table catalog_variants        enable row level security;
alter table designs                 enable row level security;
alter table products                enable row level security;
alter table product_artwork         enable row level security;
alter table product_variants        enable row level security;
alter table vendor_products         enable row level security;
alter table vendor_product_variants enable row level security;
alter table orders                  enable row level security;
alter table order_items             enable row level security;
alter table fulfillments            enable row level security;
alter table webhook_events          enable row level security;
alter table ledger_entries          enable row level security;
alter table payouts                 enable row level security;
alter table launch_steps            enable row level security;
alter table store_progress          enable row level security;
alter table drops                   enable row level security;
alter table feature_budgets         enable row level security;
alter table feature_usage           enable row level security;

-- Note: FORCE ROW LEVEL SECURITY would also subject the table OWNER to
-- these policies. It is deliberately not used here — it would make the
-- Supabase Table Editor show zero rows for orders and payouts, which
-- looks like data loss. The keys your app actually uses (anon,
-- authenticated) are covered by plain RLS above.


-- --- stores ----------------------------------------------------------

create policy "owner reads own store" on stores
  for select to authenticated
  using (owner_id = auth.uid());

create policy "owner updates own store" on stores
  for update to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

create policy "user creates own store" on stores
  for insert to authenticated
  with check (owner_id = auth.uid());

-- Storefront resolution: middleware maps subdomain -> store_id for
-- visitors, so active stores must be publicly readable.
--
-- Granted to `authenticated` as well as `anon`, here and in every other
-- "public reads" policy below. A logged-in seller browsing someone else's
-- storefront is still just a shopper, and policies are OR'd — so a seller
-- sees every active store plus, via the owner policies above, their own
-- store in any state.
create policy "public reads active stores" on stores
  for select to anon, authenticated
  using (status = 'active');


-- --- catalog (read-only to everyone, written by service role) ---------

create policy "anyone reads enabled blanks" on catalog_blanks
  for select to anon, authenticated
  using (is_enabled);

create policy "anyone reads colors" on catalog_colors
  for select to anon, authenticated
  using (exists (select 1 from catalog_blanks b where b.id = blank_id and b.is_enabled));

create policy "anyone reads placements" on catalog_placements
  for select to anon, authenticated
  using (exists (select 1 from catalog_blanks b where b.id = blank_id and b.is_enabled));

create policy "anyone reads variants" on catalog_variants
  for select to anon, authenticated
  using (exists (select 1 from catalog_blanks b where b.id = blank_id and b.is_enabled));


-- --- designs ---------------------------------------------------------

create policy "seller manages own designs" on designs
  for all to authenticated
  using (owns_store(store_id))
  with check (owns_store(store_id));


-- --- products --------------------------------------------------------

create policy "seller manages own products" on products
  for all to authenticated
  using (owns_store(store_id))
  with check (owns_store(store_id));

create policy "public reads published products" on products
  for select to anon, authenticated
  using (
    status = 'published'
    and exists (select 1 from stores s where s.id = store_id and s.status = 'active')
  );

create policy "seller manages own product artwork" on product_artwork
  for all to authenticated
  using (exists (select 1 from products p where p.id = product_id and owns_store(p.store_id)))
  with check (exists (select 1 from products p where p.id = product_id and owns_store(p.store_id)));

create policy "public reads published product artwork" on product_artwork
  for select to anon, authenticated
  using (exists (
    select 1 from products p
    join stores s on s.id = p.store_id
    where p.id = product_id and p.status = 'published' and s.status = 'active'
  ));

create policy "seller manages own product variants" on product_variants
  for all to authenticated
  using (exists (select 1 from products p where p.id = product_id and owns_store(p.store_id)))
  with check (exists (select 1 from products p where p.id = product_id and owns_store(p.store_id)));

create policy "public reads published product variants" on product_variants
  for select to anon, authenticated
  using (
    is_enabled and exists (
      select 1 from products p
      join stores s on s.id = p.store_id
      where p.id = product_id and p.status = 'published' and s.status = 'active'
    )
  );


-- --- vendor mappings -------------------------------------------------
-- No policies at all. These are pure plumbing between our ids and the
-- vendor's; only the service role touches them. RLS enabled with zero
-- policies means anon and authenticated see nothing.


-- --- orders ----------------------------------------------------------
-- Read-only for sellers. Writes are service-role only, because every
-- order write has money attached to it.

create policy "seller reads own orders" on orders
  for select to authenticated
  using (owns_store(store_id));

create policy "seller reads own order items" on order_items
  for select to authenticated
  using (exists (select 1 from orders o where o.id = order_id and owns_store(o.store_id)));

create policy "seller reads own fulfillments" on fulfillments
  for select to authenticated
  using (exists (select 1 from orders o where o.id = order_id and owns_store(o.store_id)));

-- webhook_events: no policies. Service role only.


-- --- money -----------------------------------------------------------
-- Sellers can see what they are owed. They can never write it.

create policy "seller reads own ledger" on ledger_entries
  for select to authenticated
  using (owns_store(store_id));

create policy "seller reads own payouts" on payouts
  for select to authenticated
  using (owns_store(store_id));


-- --- launch path -----------------------------------------------------

create policy "anyone reads launch steps" on launch_steps
  for select to anon, authenticated
  using (is_active);

create policy "seller reads own progress" on store_progress
  for select to authenticated
  using (owns_store(store_id));

-- Progress is advanced by the server when the step's ACTION succeeds,
-- never by the client claiming completion. Hence select-only here.


-- --- drops -----------------------------------------------------------

create policy "seller manages own drops" on drops
  for all to authenticated
  using (owns_store(store_id))
  with check (owns_store(store_id));

create policy "public reads open drops" on drops
  for select to anon, authenticated
  using (exists (select 1 from stores s where s.id = store_id and s.status = 'active'));


-- --- cost discipline -------------------------------------------------

-- feature_budgets has no policies: it holds our global spend limits, which
-- are our business and not the seller's. The server reads it with the
-- service role and tells the UI only whether a feature is available.

create policy "seller reads own usage" on feature_usage
  for select to authenticated
  using (owns_store(store_id));


-- =====================================================================
-- SECTION 13 — Storage
--
-- Artwork must sit at a stable, publicly reachable URL because vendors
-- fetch by URL rather than accepting bytes (see printful.ts uploadArtwork).
--
-- If this section errors on your project, delete it and create the bucket
-- from the Supabase dashboard instead — the rest of the migration does
-- not depend on it.
-- =====================================================================

insert into storage.buckets (id, name, public)
values ('artwork', 'artwork', true)
on conflict (id) do nothing;

-- Sellers write only into a folder named for their store id, so the path
-- itself carries the tenancy check: artwork/<store_id>/<file>.
--
-- The regex guard matters. Without it, a path whose first segment is not
-- a uuid makes the ::uuid cast raise, which surfaces as a 500 instead of
-- a clean "denied" — and an error is a worse answer than a refusal.
create or replace function owns_artwork_path(object_name text)
returns boolean
language sql
stable
as $$
  select
    (storage.foldername(object_name))[1] ~*
      '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and owns_store(((storage.foldername(object_name))[1])::uuid);
$$;

create policy "seller uploads own artwork" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'artwork' and owns_artwork_path(name));

create policy "seller updates own artwork" on storage.objects
  for update to authenticated
  using (bucket_id = 'artwork' and owns_artwork_path(name));

create policy "seller deletes own artwork" on storage.objects
  for delete to authenticated
  using (bucket_id = 'artwork' and owns_artwork_path(name));

create policy "anyone reads artwork" on storage.objects
  for select to anon, authenticated
  using (bucket_id = 'artwork');
