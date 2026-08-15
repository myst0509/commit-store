-- =====================================================================
-- 0004_vendor_safe_idempotency_key.sql
--
-- orders.idempotency_key is sent to the vendor as their external reference.
-- Printful caps that field at 32 characters — undocumented, and discovered by
-- binary-searching the length against their live estimator.
--
-- The default was gen_random_uuid()::text, which is 36 characters because of the
-- hyphens. Every order submission would have failed, and the error Printful
-- returns is "Invalid External ID specified", which points at the value being
-- malformed rather than too long. That would have surfaced on the first real
-- order, after the customer had already paid.
--
-- Hyphens removed: same 128 bits of entropy, 32 characters exactly.
-- =====================================================================

alter table orders
  alter column idempotency_key
  set default replace(gen_random_uuid()::text, '-', '');

-- Existing rows. No real orders exist yet, but a stray 36-character key would
-- fail the constraint below.
update orders
set idempotency_key = replace(idempotency_key, '-', '')
where char_length(idempotency_key) > 32;

-- So this can never regress into a runtime failure at the worst moment.
alter table orders
  add constraint idempotency_key_vendor_safe
  check (char_length(idempotency_key) between 1 and 32);

comment on column orders.idempotency_key is
  'Sent to the vendor as their external reference. MAX 32 CHARS — Printful rejects longer values with a misleading "Invalid External ID" error. Do not widen without checking every vendor adapter.';
