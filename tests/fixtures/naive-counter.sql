-- CONTROL EXPERIMENT — a deliberately BROKEN counter. Never ship this.
--
-- This is the implementation that produced SKU RS221 twice in the live store:
-- read the current number, then write number + 1. It is what most people write
-- first, and it looks completely reasonable.
--
-- Its purpose here is to prove that tests/next-sku.concurrency.test.ts can
-- actually detect the failure it claims to guard against. A passing test that
-- would also pass against a broken implementation proves nothing.
--
-- Reproduce (needs direct Postgres access, i.e. a working SUPABASE_DB_PASSWORD):
--
--   psql "$DATABASE_URL" -f tests/fixtures/naive-counter.sql
--   npx tsx scripts/control-naive-counter.ts
--   psql "$DATABASE_URL" -c 'drop function public._loupe_naive_next_sku(text);'
--
-- The pg_sleep stands in for any real work between the read and the write —
-- a validation, a log line, a network hop. It makes the race deterministic
-- rather than intermittent. Remove it and the collision still happens, just
-- less often, which is exactly what makes this bug survive code review.

create or replace function public._loupe_naive_next_sku(p_prefix text)
returns integer
language plpgsql
volatile
set search_path = public, pg_temp
as $$
declare
  v_current integer;
begin
  -- Takes NO lock. Every concurrent caller reads the same number.
  select last_number into v_current
    from public.sku_counters
   where sku_prefix = p_prefix;

  if v_current is null then
    raise exception 'naive next_sku: unknown SKU prefix %', p_prefix
      using errcode = '22023';
  end if;

  perform pg_sleep(0.01);

  -- ...and every one of them writes the same number + 1. Lost update.
  update public.sku_counters
     set last_number = v_current + 1,
         updated_at  = now()
   where sku_prefix = p_prefix;

  return v_current + 1;
end;
$$;

revoke all on function public._loupe_naive_next_sku(text) from public;
revoke all on function public._loupe_naive_next_sku(text) from anon, authenticated;
grant execute on function public._loupe_naive_next_sku(text) to service_role;
