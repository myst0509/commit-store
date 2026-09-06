-- =====================================================================
-- 0007 — Human names for garments
--
-- `model` is the garment SKU, and for most blanks it is a bare number: "5001",
-- "3001", "1717". A seller browsing the catalogue saw "AS Colour 5001" and had
-- no idea whether that was a t-shirt or a hoodie.
--
-- The vendor has the name all along. Printful returns
-- "Unisex Staple T-Shirt | Bella + Canvas 3001" and a type of "T-SHIRT"; the
-- sync simply never kept either. These two columns hold them.
--
-- Nullable because they are filled by a catalogue sync, and a blank cached
-- before this migration has neither until it is re-synced.
-- =====================================================================

alter table catalog_blanks
  -- "Unisex Staple T-Shirt". The part a person recognises, without the brand
  -- and SKU that already live in their own columns.
  add column if not exists display_name text,

  -- "T-SHIRT", "HOODIE". Useful for grouping and filtering a catalogue that
  -- is currently all t-shirts but will not stay that way.
  add column if not exists garment_type text;

comment on column catalog_blanks.display_name is
  'Human product name from the vendor, brand and SKU stripped. Null until re-synced.';

comment on column catalog_blanks.garment_type is
  'Vendor garment type, e.g. T-SHIRT. Null until re-synced.';
