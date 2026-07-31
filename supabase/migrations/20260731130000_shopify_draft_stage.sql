-- D60 supersedes D7: "Save draft" now creates a real Shopify product with
-- status DRAFT, so the SKU and handle must be reservable BEFORE a price exists.
--
-- Only the price guard becomes conditional. A draft still requires a category
-- and a confirmed Shopify tag (D23) — an untagged product drops out of its
-- collection silently whether it is draft or active — and the D27 category pin
-- is unchanged. Publish still calls this with the default, so hard rule 8 and
-- every other invariant are exactly as strict as before on the live path.
--
-- The old two-argument function is dropped rather than left beside this one:
-- adding a parameter creates an OVERLOAD, and two versions of the function that
-- allocates SKU numbers is precisely the ambiguity this project cannot afford.

drop function if exists public.reserve_draft_identity(uuid, text);

create or replace function public.reserve_draft_identity(
  p_draft_id uuid,
  p_actor    text default null,
  -- FALSE only for "save to Shopify as a DRAFT" (D60). A draft product is
  -- deliberately allowed to have no price yet; that is what makes it a draft.
  -- Publish never passes false, so hard rule 8 is untouched on the live path.
  p_require_publishable boolean default true
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
  if p_require_publishable and (d.price_paise is null or d.price_paise <= 0) then
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


comment on function public.reserve_draft_identity(uuid, text, boolean) is
  'Reserves or reuses a draft SKU/handle inside one transaction. p_require_publishable=false is used only by the Shopify DRAFT path (D60) and relaxes ONLY the price guard; category, confirmed Shopify tag and the D27 category pin still apply.';

-- Records the Shopify product id for a draft WITHOUT marking it published.
-- mark_draft_published() means "this is live in the catalogue" and also
-- publishes the intake rows and counts colour usage; a Shopify draft is none of
-- those things, so it deliberately does not reuse that function.
create or replace function public.record_draft_shopify_product(
  p_draft_id           uuid,
  p_shopify_product_id text,
  p_actor              text default null
)
returns void
language plpgsql
volatile
set search_path = public, pg_temp
as $$
declare
  d public.product_drafts%rowtype;
begin
  if p_shopify_product_id is null or btrim(p_shopify_product_id) = '' then
    raise exception 'record_draft_shopify_product: refusing to record an empty product id for draft %',
      p_draft_id using errcode = '22023';
  end if;

  select * into d from public.product_drafts where id = p_draft_id for update;
  if not found then
    raise exception 'record_draft_shopify_product: no product_draft %', p_draft_id
      using errcode = '22023';
  end if;

  -- A published draft is further along than this. Never walk it backwards.
  if d.status = 'published' then
    raise exception 'record_draft_shopify_product: draft % is already published', p_draft_id
      using errcode = '55000',
            hint    = 'A published product cannot be turned back into a Shopify draft.';
  end if;

  -- reserve_draft_identity() moves the draft to 'publishing', which is correct
  -- for a publish in flight but wrong once a DRAFT has landed in Shopify: the
  -- product is not being published, it is waiting for the operator to finish
  -- it. Left as 'publishing' the draft is uneditable in the console and
  -- Tracking calls it stalled after an hour. Return it to 'assembling'.
  update public.product_drafts
     set shopify_product_id = p_shopify_product_id,
         status             = 'assembling'
   where id = p_draft_id;
  -- The lease is deliberately NOT cleared here. end_draft_publish() is the
  -- fenced release and runs immediately after; clearing ownership from inside
  -- this function would open a window for a concurrent publish (D46).

  insert into public.events (entity_type, entity_id, event, detail, actor)
  values (
    'product_draft',
    p_draft_id,
    'draft.sent_to_shopify',
    jsonb_build_object(
      'shopify_product_id', p_shopify_product_id,
      'shopify_status', 'DRAFT'
    ),
    p_actor
  );
end;
$$;

comment on function public.record_draft_shopify_product(uuid, text, text) is
  'Records the Shopify product id for a draft saved to Shopify as DRAFT (D60). Deliberately does NOT mark the draft published, publish its intake rows or count colour usage.';

revoke execute on function public.record_draft_shopify_product(uuid, text, text) from anon, authenticated;
