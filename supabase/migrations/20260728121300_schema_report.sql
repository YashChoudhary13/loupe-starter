-- Loupe · Phase 1 · 14 — machine-readable schema report
--
-- PostgREST exposes only the public schema, so a test cannot reach pg_catalog or
-- information_schema directly. This returns the facts tests/schema.test.ts needs
-- to assert: that RLS is on with no policies, that the specified indexes exist,
-- that the enums still hold the values the application switches on.
--
-- Those are all things that break quietly. An index silently dropped during a
-- later migration does not fail anything until the "what has stalled" query goes
-- from milliseconds to a sequential scan over a year of intake rows.
--
-- service_role only — it already has full catalog access, so this grants nothing new.

create or replace function public._loupe_schema_report()
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog, pg_temp
as $$
  select jsonb_build_object(
    'tables', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'name', c.relname,
               'rls_enabled', c.relrowsecurity,
               'policy_count', (select count(*) from pg_policy p where p.polrelid = c.oid)
             ) order by c.relname), '[]'::jsonb)
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r'
    ),
    'indexes', (
      select coalesce(jsonb_agg(c.relname order by c.relname), '[]'::jsonb)
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'i'
    ),
    'enums', (
      select coalesce(jsonb_object_agg(t.typname, vals), '{}'::jsonb)
        from pg_type t
        join pg_namespace n on n.oid = t.typnamespace
        join lateral (
          select jsonb_agg(e.enumlabel order by e.enumsortorder) as vals
            from pg_enum e where e.enumtypid = t.oid
        ) v on true
       where n.nspname = 'public' and t.typtype = 'e'
    ),
    'functions', (
      select coalesce(jsonb_agg(p.proname order by p.proname), '[]'::jsonb)
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
    ),
    'columns', (
      select coalesce(jsonb_object_agg(k, v), '{}'::jsonb) from (
        select c.relname || '.' || a.attname as k,
               format_type(a.atttypid, a.atttypmod) as v
          from pg_attribute a
          join pg_class c on c.oid = a.attrelid
          join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relkind = 'r' and a.attnum > 0 and not a.attisdropped
      ) s
    )
  );
$$;

comment on function public._loupe_schema_report() is
  'Test-support introspection: RLS state, index names, enum values, function names and column types for the public schema.';

revoke all on function public._loupe_schema_report() from public;
revoke all on function public._loupe_schema_report() from anon, authenticated;
grant execute on function public._loupe_schema_report() to service_role;
