-- Loupe · Phase 2 · 18 — the title number is zero-padded too, and lpad's
--                        truncation is fixed before it can bite
--
-- TWO CHANGES. The second one is a latent bug in what Phase 2 shipped an hour ago.
--
-- 1. THE TITLE NUMBER IS NOW PADDED, confirmed against live data:
--
--        87  → "Anklets 087 (Single Piece)"      4 → "Nose Pin 004"
--       221  → "Rings 221"                     970 → "Necklace 970"
--
--    D20 previously assumed the title was unpadded, on the strength of one live
--    handle. That assumption is now retired — the live store pads to three.
--
--    This changes the derived HANDLE for numbers under 100:
--    `anklets-87-single-piece` becomes `anklets-087-single-piece`. Only for NEW
--    reservations. Handles already stored in product_drafts.reserved_handle are
--    frozen and reused verbatim, because the handle is the idempotency key for
--    productSet (hard rule 2) — re-deriving one would create a second product.
--
-- 2. `lpad(text, 3, '0')` TRUNCATES. This is the part that matters.
--
--       lpad('87',   3, '0')  →  '087'   ✓ what we wanted
--       lpad('1000', 3, '0')  →  '100'   ✗ SILENTLY LOSES A DIGIT
--
--    Postgres lpad() pads OR truncates to exactly the requested length; it is not
--    "pad to a minimum of". The Phase 2 SKU line used it directly, so the 1000th
--    necklace would have been issued SKU **NK100** — colliding with the necklace
--    that already holds NK100, silently, in a project whose entire premise is that
--    RS221 must never happen again. The UNIQUE index on reserved_sku would have
--    caught it at 23:00 on whichever evening it happened, which is not the same as
--    not doing it.
--
--    TypeScript's String.padStart() never truncates, so the two implementations
--    also disagreed above 999 — and the test that compares them only ever ran
--    two-digit counters through the database.
--
--    Fixed by giving both a single named implementation. `greatest(3, length(…))`
--    makes the length a MINIMUM, which is what "%03d" means and what lpad does not.

create or replace function public.pad_sku_number(p_number integer)
returns text
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
  -- greatest() is load-bearing: without it this truncates at four digits.
  select lpad(p_number::text, greatest(3, length(p_number::text)), '0');
$$;

comment on function public.pad_sku_number(integer) is
  'Zero-pads a SKU number to a MINIMUM of three digits: 4 → 004, 87 → 087, 221 → 221, 1000 → 1000. Mirrors padSkuNumber() in src/lib/publish/identity.ts, which tests/publish-identity.test.ts asserts. Never use bare lpad(n, 3, ''0'') for this — it truncates above 999.';

-- ---------------------------------------------------------------------------
-- reserve_draft_identity, unchanged except that BOTH the SKU and the title now
-- go through pad_sku_number().
-- ---------------------------------------------------------------------------
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
  -- these too and reports all of them at once with better wording. These are here
  -- so no future caller, backfill or SQL-editor session can route around them.
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
    -- Retry path. Reuse everything; allocate nothing. The handle in particular is
    -- reused verbatim rather than re-derived — see the padding note above.
    v_reused := true;
    v_sku    := d.reserved_sku;
    v_handle := d.reserved_handle;
    v_number := substring(d.reserved_sku from '[0-9]+$')::integer;
  else
    -- First reservation. next_sku() is the ONLY source of the number (hard rule 1).
    v_number := public.next_sku(c.sku_prefix);
    v_sku    := c.sku_prefix || public.pad_sku_number(v_number);
  end if;

  -- Title: the category pattern with {n} substituted by the PADDED number
  -- ("Anklets 087 (Single Piece)"), plus the optional free-text suffix.
  v_title := replace(c.title_pattern, '{n}', public.pad_sku_number(v_number));
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
  'Allocates (or REUSES) a draft''s SKU and handle and moves it to status=publishing, in one transaction. Reuse is what makes retry-after-failure idempotent: the same handle means productSet updates rather than duplicating. SKU and title numbers are both padded by pad_sku_number(). CLAUDE.md hard rules 1, 2 and 8.';

revoke all on function public.pad_sku_number(integer) from public, anon, authenticated;
grant execute on function public.pad_sku_number(integer) to service_role;
