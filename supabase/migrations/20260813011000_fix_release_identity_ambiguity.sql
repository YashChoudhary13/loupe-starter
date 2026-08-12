-- The 20260813010000 release_draft_identity() named an OUT column sku_prefix,
-- which PL/pgSQL substitutes into every unqualified reference — making the
-- freed_skus insert's conflict target ambiguous (SQLSTATE 42702) and the
-- function unusable. Same class of bug 20260804181000 fixed in
-- promote_prompt_preset. OUT columns are renamed so nothing shadows a table
-- column; behaviour is otherwise identical.

drop function if exists public.release_draft_identity(uuid, text, text);

create function public.release_draft_identity(
  p_draft_id                    uuid,
  p_actor                       text default null,
  p_deleted_shopify_product_id  text default null
)
returns table (released_sku text, released_number integer, released_prefix text)
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
