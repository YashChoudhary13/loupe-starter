-- Shopify is authoritative for products that Loupe has already saved there as
-- DRAFT. Reconciliation calls this only after a handle read returns no product.
--
-- The deletion is fenced in Postgres so a concurrent Save draft / Publish wins
-- safely: begin_draft_publish() takes the same draft row lock and writes a live
-- lease before touching Shopify. This function refuses that lease and also
-- compares the exact Shopify product id observed by the reconciler, so a stale
-- check cannot delete a draft that has since been recreated.

create or replace function public.delete_shopify_missing_draft(
  p_draft_id                    uuid,
  p_expected_shopify_product_id text,
  p_actor                       text default null
)
returns boolean
language plpgsql
volatile
set search_path = public, pg_temp
as $$
declare
  d public.product_drafts%rowtype;
begin
  if p_expected_shopify_product_id is null
     or btrim(p_expected_shopify_product_id) = '' then
    raise exception
      'delete_shopify_missing_draft: expected Shopify product id is required for draft %',
      p_draft_id
      using errcode = '22023';
  end if;

  select * into d
    from public.product_drafts
   where id = p_draft_id
   for update;

  -- Idempotent and race-safe. A missing row was already reconciled; a changed
  -- id was recreated after the remote read; a live lease means Save/Publish is
  -- currently allowed to finish. Published rows belong to catalogue drift and
  -- are never silently deleted here.
  if not found
     or d.status not in ('assembling', 'failed')
     or d.shopify_product_id is distinct from p_expected_shopify_product_id
     or (
       d.publish_lease_expires_at is not null
       and d.publish_lease_expires_at > now()
     ) then
    return false;
  end if;

  insert into public.events (entity_type, entity_id, event, detail, actor)
  values (
    'product_draft',
    d.id,
    'draft.deleted_after_shopify_delete',
    jsonb_build_object(
      'shopify_product_id', d.shopify_product_id,
      'reserved_sku', d.reserved_sku,
      'reserved_handle', d.reserved_handle,
      'source', 'shopify-reconciliation'
    ),
    p_actor
  );

  insert into public.events (entity_type, entity_id, event, detail, actor)
  select
    'intake_file',
    f.id,
    'intake.ungrouped_after_shopify_delete',
    jsonb_build_object(
      'product_draft_id', d.id,
      'shopify_product_id', d.shopify_product_id,
      'reserved_sku', d.reserved_sku
    ),
    p_actor
  from public.intake_files f
  where f.product_draft_id = d.id;

  -- Preserve the photographs and their generated versions. They return to
  -- Pending and may be grouped into a new product, while the retired SKU is
  -- never reused because the category counter only moves forward.
  update public.intake_files
     set product_draft_id = null,
         status           = 'enhanced',
         grouped_at       = null
   where product_draft_id = d.id;

  -- Variants and image selections cascade. Events intentionally do not: the
  -- audit trail continues to explain why the draft disappeared.
  delete from public.product_drafts where id = d.id;
  return true;
end;
$$;

comment on function public.delete_shopify_missing_draft(uuid, text, text) is
  'Deletes an unpublished Loupe draft only after Shopify reconciliation found its exact saved product id missing. Refuses live publish leases, changed ids and published products; returns source photographs to Pending and never lowers the SKU counter.';

revoke all on function public.delete_shopify_missing_draft(uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.delete_shopify_missing_draft(uuid, text, text)
  to service_role;
