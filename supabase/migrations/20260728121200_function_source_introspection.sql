-- Loupe · Phase 1 · 13 — read the source of a deployed function
--
-- Exists so tests/next-sku.concurrency.test.ts can assert the shape of the
-- next_sku that is ACTUALLY DEPLOYED, not just the shape of the migration file
-- on disk. Those can drift: someone edits the function in the Supabase SQL
-- editor to "simplify" it, the file still looks right, and the row lock is gone.
-- That drift is precisely how RS221 becomes possible again.
--
-- Leaks nothing: service_role can already read pg_proc directly. anon and
-- authenticated are revoked.

create or replace function public._loupe_function_source(p_name text)
returns text
language sql
stable
security invoker
set search_path = pg_catalog, pg_temp
as $$
  select p.prosrc
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname = p_name
   limit 1;
$$;

comment on function public._loupe_function_source(text) is
  'Test-support introspection: returns the body of a public function so a test can assert what is deployed, not merely what is committed.';

revoke all on function public._loupe_function_source(text) from public;
revoke all on function public._loupe_function_source(text) from anon, authenticated;
grant execute on function public._loupe_function_source(text) to service_role;
