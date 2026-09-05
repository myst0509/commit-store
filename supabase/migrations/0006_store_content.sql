-- =====================================================================
-- 0006 — Storefront content
--
-- The guide was only ever a sequence for launching a drop. It now also has to
-- help someone BUILD the store, and a store that is only a product grid is not
-- a brand. These are the two cheapest things that change that: who you are, and
-- where else to find you.
--
-- Both are seller-controlled and rendered publicly, so both are validated on
-- the way in — see lib/store/settings.ts. Social handles are stored as handles,
-- never as URLs, so the storefront builds the link and a seller cannot point
-- their "Instagram" at somewhere else.
-- =====================================================================

alter table stores
  -- A short introduction shown on the storefront. Length-capped in the
  -- application rather than here, so the limit can move without a migration.
  add column if not exists bio text,

  -- { instagram, tiktok, youtube, x, website }. Handles for the platforms and
  -- one absolute URL for the website. Sparse: absent keys mean not set.
  add column if not exists social jsonb not null default '{}'::jsonb;

comment on column stores.bio is
  'Short brand introduction shown on the storefront. Seller-controlled, validated in lib/store/settings.ts.';

comment on column stores.social is
  'Social handles, not URLs. The storefront builds each link so a handle cannot redirect elsewhere.';
