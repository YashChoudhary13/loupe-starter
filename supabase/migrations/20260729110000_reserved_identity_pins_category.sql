-- Loupe · Phase 2 · 19 — a reserved identity pins its category
--
-- THE GAP THIS CLOSES
--
--   reserve_draft_identity() freezes reserved_sku and reserved_handle on the first
--   attempt and reuses them verbatim on every retry — that is hard rule 2, and it is
--   what makes productSet update the half-made product instead of making a second one.
--
--   But the TITLE and the TAG are re-read from the draft's CURRENT category on every
--   call, deliberately, so that correcting a title_suffix between a failed attempt and
--   its retry publishes the correction.
--
--   Those two facts combine badly if the CATEGORY itself changes in between:
--
--     1. draft reserved as Necklaces  → NK005 · "Necklace 005" · necklace-005
--     2. publish fails
--     3. operator notices it is actually a ring and switches the category
--     4. retry → SKU **NK005**, title **"Rings 005"**, tag **Rings**,
--                handle **necklace-005**
--
--   The result is a product that reads as a ring, is tagged into the Rings collection,
--   lives at /products/necklace-005, and carries a SKU allocated from the NECKLACE
--   sequence. Meanwhile RS005 is still unissued, so a genuine ring gets it later and
--   the two are impossible to tell apart from the SKU. Nothing errors.
--
--   That is the exact class of damage hard rule 1 exists to prevent, and D1 already
--   names misclassification as high-cost precisely because a wrong category corrupts a
--   sequence rather than just one row.
--
-- WHY REFUSE RATHER THAN RE-DERIVE
--
--   Re-deriving the SKU would allocate a second number for one product and orphan the
--   first. Re-deriving the handle would break hard rule 2 outright — productSet would
--   create a second Shopify product on the next attempt.
--
--   So the identity stays frozen and the *category* becomes the thing that cannot move.
--   The operator's route is a new draft, which gets a clean identity from the right
--   sequence. The abandoned NK005 is a gap, and gaps are explicitly harmless here —
--   RS218, RS220 and RS222 are already missing from the live store and nothing depends
--   on them. A product whose SKU prefix disagrees with its category is not harmless.
--
-- This is a guard against a state Phase 2 cannot itself produce — nothing here edits
-- category_id. It is added now because the function that must enforce it is being
-- written now, and because the console that WILL let an operator change a category is
-- Phase 4/5, by which time this file will not be the one anybody is reading.

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
  d              public.product_drafts%rowtype;
  c              public.categories%rowtype;
  v_number       integer;
  v_sku          text;
  v_title        text;
  v_handle       text;
  v_reused       boolean := false;
  v_held_prefix  text;
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
    -- Retry path. Reuse everything; allocate nothing.
    v_held_prefix := substring(d.reserved_sku from '^[A-Z]+');

    -- …but only if the draft is still in the category the identity came from.
    if v_held_prefix is distinct from c.sku_prefix then
      raise exception
        'reserve_draft_identity: draft % holds % from the % sequence, but its category is now % (%)',
        p_draft_id, d.reserved_sku, v_held_prefix, c.name, c.sku_prefix
        using errcode = '22023',
              hint    = 'A reserved SKU and handle are frozen — they are the idempotency key for productSet and cannot move between sequences. Create a NEW draft in the correct category. The abandoned number is a gap, and gaps are harmless; a product whose SKU prefix disagrees with its category is not.';
    end if;

    v_reused := true;
    v_sku    := d.reserved_sku;
    v_handle := d.reserved_handle;
    v_number := substring(d.reserved_sku from '[0-9]+$')::integer;
  else
    -- First reservation. next_sku() is the ONLY source of the number (hard rule 1).
    v_number := public.next_sku(c.sku_prefix);
    v_sku    := c.sku_prefix || public.pad_sku_number(v_number);
  end if;

  -- Title: pattern with {n} substituted by the PADDED number, e.g.
  -- "Anklets 087 (Single Piece)", "Nose Pin 004", "Rings 221", "Necklace 970".
  -- Re-rendered on every call on purpose, so a corrected title_suffix reaches the
  -- retry. Safe now that the category behind it cannot have changed.
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
  'Allocates (or REUSES) a draft''s SKU and handle and moves it to status=publishing, in one transaction. Reuse is what makes retry-after-failure idempotent. A reserved identity PINS its category: retrying after the category changed raises rather than publishing a product whose SKU prefix disagrees with its tag. SKU and title numbers are padded by pad_sku_number(). CLAUDE.md hard rules 1, 2 and 8.';
