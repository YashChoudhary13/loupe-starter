-- The first Phase 3A deployment installed pg_net before its namespace was
-- explicit. On Supabase that defaults the extension record to public, which the
-- security advisor correctly flags even though pg_net's API lives in `net`.
--
-- pg_net is not relocatable, so the only supported correction is a clean
-- reinstall. This migration runs before any Loupe cron jobs are provisioned;
-- there are no durable application records in pg_net's unlogged queue/response
-- tables to preserve.

do $migration$
declare
  v_schema text;
begin
  select n.nspname
    into v_schema
    from pg_extension as e
    join pg_namespace as n on n.oid = e.extnamespace
   where e.extname = 'pg_net';

  if v_schema is null then
    create extension pg_net with schema extensions;
  elsif v_schema = 'public' then
    drop extension pg_net;
    create extension pg_net with schema extensions;
  elsif v_schema <> 'extensions' then
    raise exception 'pg_net is installed in unexpected schema %', v_schema
      using hint = 'Move pg_net to the Supabase extensions schema before configuring Loupe cron jobs.';
  end if;
end
$migration$;
