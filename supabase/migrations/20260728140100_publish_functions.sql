-- Loupe · Phase 2 · 16 — the publish transaction, and the counter-seeding raise
--
-- Four functions. Three of them are the state machine behind CLAUDE.md hard rule 2
-- (publishing is idempotent by handle); the fourth exists only for the one-time
-- `npm run seed:counters` operation.
--
-- WHY THESE ARE SQL FUNCTIONS AND NOT APPLICATION CODE
--
--   "Reserve SKU + handle inside ONE transaction" is not achievable over PostgREST
--   from TypeScript: every supabase-js call is its own transaction. A crash between
--   `next_sku()` returning 225 and the UPDATE that stores RS225 would burn the
--   number AND leave the draft unreserved — and the next publish would produce a
--   product whose SKU is one ahead of the sequence with no record of why.
--
--   Inside a plpgsql function the whole thing is one transaction. Either the
--   counter moved and the draft carries the identity, or neither happened.

-- ---------------------------------------------------------------------------
-- 1. raise_sku_counter — monotone. Used ONLY by npm run seed:counters.
-- ---------------------------------------------------------------------------
--
-- READ docs/DECISIONS.md D2 BEFORE TOUCHING THIS. It looks like the thing D2
-- forbids and it is not. D2 forbids deriving a SKU number from Shopify AT PUBLISH
-- TIME. This is the one-time seeding operation that establishes where a
-- hand-maintained sequence had got to, run with the store quiet.
--
-- The safety property is `greatest`: this function can RAISE a counter and can
-- never LOWER one. That makes it idempotent, safe to re-run, and safe to run
-- against a store that has been published to since the last run — the worst a
-- stale read can do is nothing at all.
create or replace function public.raise_sku_counter(p_prefix text, p_to integer)
returns integer
language plpgsql
volatile
set search_path = public, pg_temp
as $$
declare
  v_now integer;
begin
  if p_to is null or p_to < 0 then
    raise exception 'raise_sku_counter: p_to must be a non-negative integer, got %', coalesce(p_to::text, '<null>')
      using errcode = '22023';
  end if;

  -- One statement, same discipline as next_sku(). greatest() makes it monotone:
  -- there is no ordering of concurrent calls that lowers the counter.
  update public.sku_counters
     set last_number = greatest(last_number, p_to),
         updated_at  = case when p_to > last_number then now() else updated_at end
   where sku_prefix = p_prefix
  returning last_number into v_now;

  if not found then
    raise exception 'raise_sku_counter: unknown SKU prefix %', coalesce(p_prefix, '<null>')
      using errcode = '22023',
            hint    = 'Confirm the category against the live store, then add it to categories and sku_counters. Do not invent a prefix.';
  end if;

  return v_now;
end;
$$;

comment on function public.raise_sku_counter(text, integer) is
  'Raises a SKU counter to at least p_to and returns the resulting value. MONOTONE — never lowers. For npm run seed:counters only; publish allocates with next_sku(). See docs/DECISIONS.md D2, which explains why this does not contradict it.';

-- ---------------------------------------------------------------------------
-- 2. reserve_draft_identity — SKU + handle + title, in one transaction
-- ---------------------------------------------------------------------------
--
-- Idempotent by design. If the draft already carries a reserved_sku, this REUSES
-- it and burns no new number. That is what makes a retry after a failed publish
-- hit the same Shopify handle, so productSet UPDATES the half-made product
-- instead of creating a second one (hard rule 2).
--
-- The title is recomputed rather than stored: the SKU and the handle are the
-- product's identity and must be frozen, but the title is content. If an operator
-- corrects `title_suffix` between a failed attempt and the retry, the retry should
-- publish the corrected title onto the same handle.
create or replace function public.reserve_draft_identity(
  p_draft_id uuid,
  p_actor    text default null
)
returns table (
  draft_id    uuid,
  sku         text,
  sku_number  integer,
  handle      text,
  title       text,
  shopify_tag text,
  reused      boolean
)
language plpgsql
volatile
set search_path = public, pg_temp
as $$
declare
  d          public.product_drafts%rowtype;
  c          public.categories%rowtype;
  v_number   integer;
  v_sku      text;
  v_title    text;
  v_handle   text;
  v_reused   boolean := false;
begin
  -- FOR UPDATE so two concurrent publishes of the SAME draft serialise here and
  -- the second sees the first's reservation instead of allocating a second number.
  select * into d from public.product_drafts where id = p_draft_id for update;
  if not found then
    raise exception 'reserve_draft_identity: no product_draft %', coalesce(p_draft_id::text, '<null>')
      using errcode = '22023';
  end if;

  select * into c from public.categories where id = d.category_id;
  if not found then
    raise exception 'reserve_draft_identity: draft % has no category', p_draft_id
      using errcode = '22023';
  end if;

  -- The invariants that must hold however publish was reached. TypeScript checks
  -- these too and reports all of them at once with better wording — that is for
  -- the operator. These are here so no future caller, backfill or SQL-editor
  -- session can route around them. CLAUDE.md hard rule 8.
  if d.price_paise is null or d.price_paise <= 0 then
    raise exception 'reserve_draft_identity: draft % has no price', p_draft_id
      using errcode = '22023',
            hint    = 'Publish is blocked on an empty or zero price (CLAUDE.md hard rule 8).';
  end if;

  if c.shopify_tag is null then
    raise exception 'reserve_draft_identity: category % (%) has no confirmed Shopify tag', c.name, c.sku_prefix
      using errcode = '22023',
            hint    = 'Read the tag off a live product in this category and set categories.shopify_tag. Do not invent one — collections are tag-driven and a wrong tag drops the product out of its collection silently.';
  end if;

  if d.reserved_sku is not null and d.reserved_handle is not null then
    -- Retry path. Reuse everything; allocate nothing.
    v_reused := true;
    v_sku    := d.reserved_sku;
    v_handle := d.reserved_handle;
    v_number := substring(d.reserved_sku from '[0-9]+$')::integer;
  else
    -- First reservation. next_sku() is the ONLY source of the number (hard rule 1).
    v_number := public.next_sku(c.sku_prefix);
    -- 3 digits to match the live store: AK011, RS221, NK970. Numbers past 999
    -- simply get wider, which the reserved_sku CHECK (^[A-Z]{2,4}[0-9]{3,}$) allows.
    v_sku    := c.sku_prefix || lpad(v_number::text, 3, '0');
  end if;

  -- Title: the category pattern with {n} substituted, plus the optional free-text
  -- suffix. The number in the TITLE is NOT zero-padded — the live store reads
  -- "Rings 221", not "Rings 0221". Only the SKU is padded.
  v_title := replace(c.title_pattern, '{n}', v_number::text);
  if d.title_suffix is not null and btrim(d.title_suffix) <> '' then
    v_title := v_title || ' ' || btrim(d.title_suffix);
  end if;

  if not v_reused then
    -- Handle is derived from the title ONCE and then frozen forever, because it is
    -- the idempotency key for productSet.
    v_handle := btrim(lower(regexp_replace(v_title, '[^a-zA-Z0-9]+', '-', 'g')), '-');
    if v_handle = '' then
      raise exception 'reserve_draft_identity: draft % produced an empty handle from title %', p_draft_id, v_title
        using errcode = '22023';
    end if;
  end if;

  update public.product_drafts
     set reserved_sku    = v_sku,
         reserved_handle = v_handle,
         status          = 'publishing',
         error           = null
   where id = p_draft_id;

  insert into public.events (entity_type, entity_id, event, detail, actor)
  values (
    'product_draft', p_draft_id, 'publish.reserved',
    jsonb_build_object(
      'sku', v_sku, 'sku_number', v_number, 'handle', v_handle, 'title', v_title,
      'category', c.name, 'sku_prefix', c.sku_prefix, 'shopify_tag', c.shopify_tag,
      'reused', v_reused
    ),
    p_actor
  );

  return query select p_draft_id, v_sku, v_number, v_handle, v_title, c.shopify_tag, v_reused;
end;
$$;

comment on function public.reserve_draft_identity(uuid, text) is
  'Allocates (or REUSES) a draft''s SKU and handle and moves it to status=publishing, in one transaction. Reuse is what makes retry-after-failure idempotent: the same handle means productSet updates rather than duplicating. CLAUDE.md hard rules 1, 2 and 8.';

-- ---------------------------------------------------------------------------
-- 3 / 4. Terminal transitions. Both write to events (CLAUDE.md conventions).
-- ---------------------------------------------------------------------------

create or replace function public.mark_draft_published(
  p_draft_id           uuid,
  p_shopify_product_id text,
  p_actor              text default null
)
returns void
language plpgsql
volatile
set search_path = public, pg_temp
as $$
begin
  if p_shopify_product_id is null or btrim(p_shopify_product_id) = '' then
    raise exception 'mark_draft_published: refusing to mark draft % published with no Shopify product id', p_draft_id
      using errcode = '22023';
  end if;

  update public.product_drafts
     set status             = 'published',
         shopify_product_id = p_shopify_product_id,
         published_at       = now(),
         error              = null
   where id = p_draft_id;

  if not found then
    raise exception 'mark_draft_published: no product_draft %', p_draft_id using errcode = '22023';
  end if;

  insert into public.events (entity_type, entity_id, event, detail, actor)
  values ('product_draft', p_draft_id, 'publish.published',
          jsonb_build_object('shopify_product_id', p_shopify_product_id), p_actor);
end;
$$;

comment on function public.mark_draft_published(uuid, text, text) is
  'Terminal success transition. Refuses to record a published draft without the Shopify product id — a published row that cannot name its product is untraceable.';

-- Deliberately does NOT clear reserved_sku or reserved_handle. Keeping them is
-- what makes the retry reuse the same handle and produce ONE product rather than
-- a second one (hard rule 2). The burnt SKU number is the correct cost: gaps in
-- the sequence are expected and harmless; a duplicate SKU is not.
create or replace function public.mark_draft_failed(
  p_draft_id  uuid,
  p_error     text,
  p_retryable boolean default null,
  p_actor     text default null
)
returns void
language plpgsql
volatile
set search_path = public, pg_temp
as $$
begin
  update public.product_drafts
     set status = 'failed',
         error  = left(coalesce(p_error, 'unknown error'), 4000)
   where id = p_draft_id;

  if not found then
    raise exception 'mark_draft_failed: no product_draft %', p_draft_id using errcode = '22023';
  end if;

  insert into public.events (entity_type, entity_id, event, detail, actor)
  values ('product_draft', p_draft_id, 'publish.failed',
          jsonb_build_object('error', left(coalesce(p_error, 'unknown error'), 4000),
                             'retryable', p_retryable), p_actor);
end;
$$;

comment on function public.mark_draft_failed(uuid, text, boolean, text) is
  'Terminal failure transition. KEEPS reserved_sku and reserved_handle so a retry reuses the same handle and productSet updates the same product instead of creating a second one.';

-- ---------------------------------------------------------------------------
-- Publishing is a server-side act. None of this is reachable from a browser.
-- Functions are EXECUTE-able by PUBLIC by default, so it has to be revoked.
-- ---------------------------------------------------------------------------
revoke all on function public.raise_sku_counter(text, integer)          from public, anon, authenticated;
revoke all on function public.reserve_draft_identity(uuid, text)        from public, anon, authenticated;
revoke all on function public.mark_draft_published(uuid, text, text)    from public, anon, authenticated;
revoke all on function public.mark_draft_failed(uuid, text, boolean, text) from public, anon, authenticated;

grant execute on function public.raise_sku_counter(text, integer)          to service_role;
grant execute on function public.reserve_draft_identity(uuid, text)        to service_role;
grant execute on function public.mark_draft_published(uuid, text, text)    to service_role;
grant execute on function public.mark_draft_failed(uuid, text, boolean, text) to service_role;
