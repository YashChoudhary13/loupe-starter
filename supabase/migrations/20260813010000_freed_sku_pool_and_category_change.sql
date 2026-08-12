-- D101: a drafted product's category can now be corrected without wasting the
-- number — the freed SKU returns to a per-prefix pool and the next draft in
-- that category picks it up.
--
-- WHAT DOES NOT CHANGE (hard rule 1): the counter never moves backwards, and
-- next_sku() remains the only place a NEW number is minted. The pool holds
-- numbers the counter already issued whose products provably never went live:
-- releasing requires the draft to be unpublished and its Shopify DRAFT product
-- (if any) to have been deleted first, with the caller passing the exact
-- product id it deleted as proof it looked.
--
-- WHY A POOL AND NOT A DECREMENT: two drafts can free numbers out of order
-- (NK1006 after NK1007), and a decrement would re-issue only the newest and
-- collide the moment the counter caught up. A pool row is deleted exactly once
-- (delete … returning under SKIP LOCKED), so two concurrent reservations
-- cannot both take the same freed number — one takes it, the other falls
-- through to next_sku().

create table public.freed_skus (
  sku_prefix        text        not null references public.categories (sku_prefix),
  sku_number        integer     not null check (sku_number > 0),
  freed_from_draft  uuid,
  freed_by          text,
  freed_at          timestamptz not null default now(),
  primary key (sku_prefix, sku_number)
);

comment on table public.freed_skus is
  'Per-prefix pool of SKU numbers released from corrected drafts (D101). reserve_draft_identity() drains it before calling next_sku(). Rows exist only for numbers whose Shopify DRAFT product was deleted (or never existed).';

alter table public.freed_skus enable row level security;

-- Frees a draft''s reserved identity back to the pool.
--
-- Guards, in order: the draft must exist; it must not be published; it must
-- not hold a live publish lease; it must actually hold an identity; and if it
-- ever reached Shopify, the caller must pass the EXACT product id it just
-- deleted — a mismatch means the caller looked at a different product than
-- the one recorded, and nothing is freed.
create function public.release_draft_identity(
  p_draft_id                    uuid,
  p_actor                       text default null,
  p_deleted_shopify_product_id  text default null
)
returns table (freed_sku text, freed_number integer, sku_prefix text)
language plpgsql
volatile
set search_path = public, pg_temp
as $$
declare
  d          public.product_drafts%rowtype;
  v_prefix   text;
  v_number   integer;
begin
  select * into d from public.product_drafts where id = p_draft_id for update;
  if not found then
    raise exception 'release_draft_identity: no product_draft %', coalesce(p_draft_id::text, '<null>')
      using errcode = '22023';
  end if;

  if d.status = 'published' then
    raise exception 'release_draft_identity: draft % is published', p_draft_id
      using errcode = '55000',
            hint    = 'A published product''s SKU is spent forever. Only unpublished drafts can release their number.';
  end if;

  if d.publish_lease_expires_at is not null and d.publish_lease_expires_at > now() then
    raise exception 'release_draft_identity: draft % has a publish in flight', p_draft_id
      using errcode = '55000',
            hint    = 'Wait for the current publish/draft push to finish, then try again.';
  end if;

  if d.reserved_sku is null then
    raise exception 'release_draft_identity: draft % holds no reserved identity', p_draft_id
      using errcode = '22023';
  end if;

  if d.shopify_product_id is not null
     and d.shopify_product_id is distinct from p_deleted_shopify_product_id then
    raise exception 'release_draft_identity: draft % still has Shopify product %', p_draft_id, d.shopify_product_id
      using errcode = '55000',
            hint    = 'Delete the Shopify draft product first and pass its id as proof. Freeing a number while its product exists would let two products share one SKU.';
  end if;

  v_prefix := substring(d.reserved_sku from '^[A-Z]+');
  v_number := substring(d.reserved_sku from '[0-9]+$')::integer;

  insert into public.freed_skus (sku_prefix, sku_number, freed_from_draft, freed_by)
  values (v_prefix, v_number, p_draft_id, p_actor)
  on conflict (sku_prefix, sku_number) do nothing;

  update public.product_drafts
     set reserved_sku          = null,
         reserved_handle       = null,
         shopify_product_id    = null,
         shopify_first_sent_at = null,
         status                = 'assembling',
         error                 = null
   where id = p_draft_id;

  insert into public.events (entity_type, entity_id, event, detail, actor)
  values (
    'product_draft', p_draft_id, 'draft.identity_released',
    jsonb_build_object(
      'sku', d.reserved_sku, 'handle', d.reserved_handle,
      'sku_prefix', v_prefix, 'sku_number', v_number,
      'deleted_shopify_product_id', p_deleted_shopify_product_id
    ),
    p_actor
  );

  return query select d.reserved_sku, v_number, v_prefix;
end;
$$;

comment on function public.release_draft_identity(uuid, text, text) is
  'Returns a drafted (never published) product''s SKU number to the freed_skus pool and clears its frozen identity, so the draft can re-reserve under a corrected category (D101). Requires proof of Shopify draft deletion when one was recorded.';

revoke execute on function public.release_draft_identity(uuid, text, text) from public, anon, authenticated;
grant execute on function public.release_draft_identity(uuid, text, text) to service_role;

-- reserve_draft_identity: identical to the 20260731130000 deployment except
-- the first-reservation branch drains the pool before minting a new number.
create or replace function public.reserve_draft_identity(
  p_draft_id uuid,
  p_actor    text default null,
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
  v_from_pool    boolean := false;
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

    if v_held_prefix is distinct from c.sku_prefix then
      raise exception
        'reserve_draft_identity: draft % holds % from the % sequence, but its category is now % (%)',
        p_draft_id, d.reserved_sku, v_held_prefix, c.name, c.sku_prefix
        using errcode = '22023',
              hint    = 'A reserved SKU and handle are frozen — they are the idempotency key for productSet. Use "Change category" in the console, which deletes the Shopify draft and frees this number first (D101).';
    end if;

    v_reused := true;
    v_sku    := d.reserved_sku;
    v_handle := d.reserved_handle;
    v_number := substring(d.reserved_sku from '[0-9]+$')::integer;
  else
    -- First reservation: drain the freed pool before minting (D101). The
    -- delete-returning under SKIP LOCKED gives each concurrent caller a
    -- different pool row, or none — never the same one twice.
    delete from public.freed_skus f
     where f.sku_prefix = c.sku_prefix
       and f.sku_number = (
         select p.sku_number
           from public.freed_skus p
          where p.sku_prefix = c.sku_prefix
          order by p.sku_number
            for update skip locked
          limit 1
       )
    returning f.sku_number into v_number;

    if v_number is not null then
      v_from_pool := true;
    else
      -- next_sku() is the ONLY source of a NEW number (hard rule 1).
      v_number := public.next_sku(c.sku_prefix);
    end if;
    v_sku := c.sku_prefix || public.pad_sku_number(v_number);
  end if;

  v_title := replace(c.title_pattern, '{n}', public.pad_sku_number(v_number));
  if d.title_suffix is not null and btrim(d.title_suffix) <> '' then
    v_title := v_title || ' ' || btrim(d.title_suffix);
  end if;

  if not v_reused then
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
      'reused', v_reused, 'from_pool', v_from_pool
    ),
    p_actor
  );

  return query select p_draft_id, v_sku, v_number, v_handle, v_title, c.shopify_tag, v_reused;
end;
$$;

comment on function public.reserve_draft_identity(uuid, text, boolean) is
  'Reserves or reuses a draft SKU/handle inside one transaction. Drains the freed_skus pool before next_sku() (D101). p_require_publishable=false is used only by the Shopify DRAFT path (D60) and relaxes ONLY the price guard.';
