-- =====================================================================
-- 0005_payment_events.sql
--
-- Dedupe and audit for Stripe webhooks.
--
-- Stripe delivers at-least-once and retries for up to three days, so the
-- same event WILL arrive more than once. Without a dedupe key, a repeated
-- payment_intent.succeeded submits a second order to the vendor: we pay
-- twice and ship twice.
--
-- Not reusing `webhook_events`: that table's `provider` column is the
-- fulfillment-vendor enum (printful | apliiq). Stripe is a payment
-- processor, not a fulfillment vendor, and widening that enum to fit it
-- would blur a boundary the whole codebase depends on.
-- =====================================================================

create table payment_events (
  id                uuid primary key default gen_random_uuid(),

  -- Stripe's own event id. The dedupe key.
  stripe_event_id   text not null unique,
  type              text not null,
  payload           jsonb not null,

  -- Resolved from metadata where the event carries it. Nullable: some events
  -- (account updates, payouts) belong to no order.
  order_id          uuid references orders(id) on delete set null,

  received_at       timestamptz not null default now(),
  processed_at      timestamptz,
  process_error     text,
  attempt_count     integer not null default 0 check (attempt_count >= 0)
);

-- Drives an alert: anything unprocessed for long is money in an unknown state.
create index payment_events_unprocessed_idx on payment_events(received_at)
  where processed_at is null;

create index payment_events_order_idx on payment_events(order_id)
  where order_id is not null;

alter table payment_events enable row level security;

-- No policies. Service role only — this is our payment audit trail, and a
-- seller has no business reading raw Stripe payloads for their customers.

comment on table payment_events is
  'Stripe webhook audit and dedupe. Service-role only. A row here with processed_at null is an event whose side effects may never have run.';
