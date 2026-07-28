-- Loupe · Phase 1 · 10 — next_sku(): the atomic SKU counter
--
-- THE most important function in this project. The live store carries two
-- different products on SKU RS221 because the number was allocated by reading a
-- current value and then writing value + 1. Two people did that at once.
--
-- CLAUDE.md hard rule 1 · docs/DECISIONS.md D2.
--
-- WHY THIS IS SAFE, precisely:
--
--   A single `UPDATE ... RETURNING` takes a ROW-EXCLUSIVE lock on the counter row
--   as part of finding it. Under Postgres READ COMMITTED, a second transaction
--   whose UPDATE targets the same row BLOCKS at that point. When the first
--   transaction commits, the second does not proceed with the stale row it read
--   at statement start — it re-evaluates against the newly committed version
--   (EvalPlanQual) and increments from the value the winner just wrote.
--   Serialisation is therefore automatic and needs no advisory lock, no
--   SERIALIZABLE isolation, and no retry loop.
--
--   The equivalent SELECT-then-UPDATE has no such barrier: the SELECT takes no
--   lock, both readers see the same number, and both write the same number + 1.
--   That is exactly how RS221 happened. Do not "simplify" this function into
--   two statements. tests/next-sku.concurrency.test.ts proves the difference by
--   running both implementations under the same load.
--
-- The counter is the source of truth. Never derive a number from Shopify: it
-- enforces no SKU uniqueness, and drafts, deletions and in-flight writes make
-- any "current max" query lie.

create or replace function public.next_sku(p_prefix text)
returns integer
language plpgsql
volatile
set search_path = public, pg_temp
as $$
declare
  v_next integer;
begin
  -- ONE statement. The row lock, the increment and the read are indivisible.
  update public.sku_counters
     set last_number = last_number + 1,
         updated_at  = now()
   where sku_prefix = p_prefix
  returning last_number into v_next;

  -- No row matched. Raise rather than returning NULL or silently creating a
  -- counter: an unknown prefix means the category was never confirmed against
  -- the live store, and inventing a sequence for it would corrupt a real one.
  if not found then
    raise exception 'next_sku: unknown SKU prefix %', coalesce(p_prefix, '<null>')
      using errcode = '22023',  -- invalid_parameter_value
            hint    = 'Confirm the category against the live store, then add it to categories and sku_counters. Do not invent a prefix.';
  end if;

  return v_next;
end;
$$;

comment on function public.next_sku(text) is
  'Atomically allocates and returns the next SKU number for a prefix. Single UPDATE ... RETURNING — the row lock serialises concurrent callers. Raises SQLSTATE 22023 on an unknown prefix. Never implement as SELECT then UPDATE; see RS221.';

-- Allocating a SKU is a server-side act inside the publish transaction. An
-- anonymous caller must not be able to reach it: burning numbers from the
-- browser would open gaps in the sequence for free. Functions are EXECUTE-able
-- by PUBLIC by default, so that has to be revoked explicitly.
revoke all on function public.next_sku(text) from public;
revoke all on function public.next_sku(text) from anon, authenticated;
grant execute on function public.next_sku(text) to service_role;
