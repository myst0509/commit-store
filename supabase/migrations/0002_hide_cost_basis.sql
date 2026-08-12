-- =====================================================================
-- 0002_hide_cost_basis.sql
--
-- Fixes a column-level exposure left by 0001.
--
-- RLS decides which ROWS a role can see. It says nothing about COLUMNS.
-- 0001 enabled RLS everywhere and stopped there, so two things leaked:
--
--   1. catalog_variants.base_cost_cents — our raw vendor cost — was readable
--      by `anon`. The publishable key is in the browser bundle of every
--      storefront by design, so this exposed the platform's entire cost basis
--      to anyone who looked.
--
--   2. product_variants.base_cost_cents and .platform_fee_cents were readable
--      by the owning seller. PROJECT.md is explicit: seller-visible product
--      cost is vendor base + our fee, and "the seller never sees the split."
--
-- Postgres resolves table-level privileges BEFORE column-level ones, so a
-- column REVOKE does nothing while table-wide SELECT is still granted. The
-- table grant has to be withdrawn first, then re-granted column by column.
-- Any column added later is therefore invisible until explicitly granted,
-- which is the safe direction to fail.
-- =====================================================================

-- --- catalog_variants -------------------------------------------------
-- Colour, size and stock are needed by storefronts and the design tool.
-- Cost is ours alone.

revoke select on catalog_variants from anon, authenticated;

grant select (
  id, blank_id, provider, external_id,
  color, size, in_stock,
  synced_at, created_at, updated_at
) on catalog_variants to anon, authenticated;


-- --- product_variants -------------------------------------------------
-- A seller needs to know what a unit costs them and what it sells for.
-- They must not be able to decompose the cost into vendor price and our fee.

-- Generated, not written by application code, so the two can never drift.
alter table product_variants
  add column seller_cost_cents bigint
  generated always as (base_cost_cents + platform_fee_cents) stored;

comment on column product_variants.seller_cost_cents is
  'What the seller pays per unit. The base/fee split behind it is deliberately not readable by sellers.';

revoke select on product_variants from anon, authenticated;

grant select (
  id, product_id, catalog_variant_id,
  retail_price_cents, seller_cost_cents,
  is_enabled, created_at, updated_at
) on product_variants to anon, authenticated;

-- Sellers still create and price their own variants; only reading the split is
-- withdrawn. INSERT and UPDATE remain column-scoped to what they legitimately set.
grant insert (
  product_id, catalog_variant_id, retail_price_cents,
  base_cost_cents, platform_fee_cents, is_enabled
) on product_variants to authenticated;

grant update (retail_price_cents, is_enabled) on product_variants to authenticated;


-- =====================================================================
-- Note for anything querying these tables:
--
--   select('*') on either table now FAILS for anon and authenticated, because
--   `*` expands to columns the role cannot read. That is intentional. Name the
--   columns you need. Server-side code using the service role is unaffected —
--   it bypasses both RLS and these grants.
-- =====================================================================
