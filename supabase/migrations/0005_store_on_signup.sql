-- =====================================================================
-- 0005 — Give every new user a store
--
-- lib/launch/actions.ts create_store says "the store row itself is created
-- before this by signup; this names it" — and only runs an UPDATE. Nothing
-- ever did the INSERT, so a new seller was stuck: requireSeller() 404s
-- without a store, which includes /api/launch, whose first step is the thing
-- that was supposed to give them one.
--
-- The store is created in `draft`, so it is invisible on the storefront until
-- the seller launches it. The name and subdomain are placeholders that the
-- `name` step overwrites.
-- =====================================================================

-- The subdomain must be unique and match the format check on stores. Deriving
-- it from the user's uuid makes it unique by construction rather than by
-- retry: 'store-' plus 32 hex characters is 38, inside the 63 limit, starts
-- and ends alphanumeric, and is already lowercase.
create or replace function public.create_store_for_new_user()
returns trigger
language plpgsql
-- security definer: the trigger fires as the auth system inserting into
-- auth.users, which has no rights on public.stores.
security definer
-- Pinned so the function cannot be redirected to a shadowed table by a
-- caller-controlled search_path. Required for any security definer function.
set search_path = public, pg_temp
as $$
begin
  insert into public.stores (owner_id, name, subdomain)
  values (
    new.id,
    'My brand',
    'store-' || replace(new.id::text, '-', '')
  );
  return new;
end;
$$;

-- AFTER INSERT: the user row must exist before stores.owner_id can reference
-- it. Note this runs inside the signup transaction, so a failure here fails
-- the signup — which is why the subdomain cannot collide.
drop trigger if exists create_store_on_signup on auth.users;

create trigger create_store_on_signup
  after insert on auth.users
  for each row execute function public.create_store_for_new_user();

-- Backfill anyone who signed up before this existed. Idempotent: the
-- not-exists guard makes a re-run a no-op.
insert into public.stores (owner_id, name, subdomain)
select u.id, 'My brand', 'store-' || replace(u.id::text, '-', '')
from auth.users u
where not exists (select 1 from public.stores s where s.owner_id = u.id);
