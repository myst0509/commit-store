-- =====================================================================
-- 0003_public_views.sql
--
-- Gives client code a safe `select('*')` target, and defuses a dangerous
-- error hint.
--
-- After 0002, `select('*')` on catalog_variants or product_variants fails
-- for anon and authenticated, because `*` expands to columns those roles
-- cannot read. That is correct, but PostgREST responds with:
--
--     "Grant the required privileges to the current role with:
--      GRANT SELECT ON public.catalog_variants TO anon;"
--
-- Following that hint re-grants the table wholesale and republishes the
-- cost basis 0002 just hid. The hint is generic; it has no idea the
-- column grants are deliberate. Anyone debugging a permissions error —
-- a person, an AI assistant, a future session — is one copy-paste from
-- undoing the fix.
--
-- So: give them something that just works instead. These views expose
-- exactly the safe columns, so `select('*')` against them is both
-- ergonomic and safe.
--
-- security_invoker = on is load-bearing. Without it a view runs with its
-- OWNER's privileges, which would bypass the row-level policies on the
-- underlying tables and leak every store's rows to everyone. On, the
-- caller's own RLS applies exactly as it does to the base table.
-- =====================================================================

create view catalog_variants_public
with (security_invoker = on) as
select
  id, blank_id, provider, external_id,
  color, size, in_stock,
  synced_at, created_at, updated_at
from catalog_variants;

grant select on catalog_variants_public to anon, authenticated;

comment on view catalog_variants_public is
  'Catalog variants without base_cost_cents. Use this for select(*); the base table deliberately withholds our vendor cost.';


create view product_variants_public
with (security_invoker = on) as
select
  id, product_id, catalog_variant_id,
  retail_price_cents, seller_cost_cents,
  is_enabled, created_at, updated_at
from product_variants;

grant select on product_variants_public to anon, authenticated;

comment on view product_variants_public is
  'Product variants without the base/fee split. Use this for select(*); sellers see seller_cost_cents only.';


-- Warnings on the base tables, so anyone inspecting the schema sees why a
-- permissions error is expected before they act on PostgREST's hint.
comment on table catalog_variants is
  'Column grants are deliberate: base_cost_cents is withheld from anon and authenticated. Do NOT run GRANT SELECT ON catalog_variants — that republishes our vendor cost basis. Use catalog_variants_public, or name columns explicitly. See 0002.';

comment on table product_variants is
  'Column grants are deliberate: base_cost_cents and platform_fee_cents are withheld. PROJECT.md — the seller never sees the split. Do NOT run GRANT SELECT ON product_variants. Use product_variants_public, or seller_cost_cents. See 0002.';
