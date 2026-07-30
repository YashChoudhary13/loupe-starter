-- Loupe · Phase 4 — forward fix: `name` was ambiguous in save_product_draft
--
-- `unnest(p_colours) as name` names the *table alias* `name`, and the joined
-- `public.colours` has a *column* called `name`, so
-- `public.normalise_colour_name(name)` had two candidates and `plpgsql_check`
-- reported 42702 on the delete.
--
-- It is the same class of defect Phase 3B hit three times: PL/pgSQL ambiguity is
-- invisible to a migration file that parses fine and to any test that mocks the
-- database. Every colour list here is aliased explicitly instead.

create or replace function public.save_product_draft(
  p_draft_id            uuid,
  p_expected_updated_at timestamptz,
  p_category_id         uuid,
  p_material_id         uuid,
  p_title_suffix        text,
  p_price_paise         integer,
  p_weight_g            integer,
  p_stock               integer,
  p_colours             text[],
  p_images              jsonb,
  p_actor               text default null
)
returns timestamptz
language plpgsql
volatile
set search_path = public, pg_temp
as $$
declare
  d             public.product_drafts%rowtype;
  c             public.categories%rowtype;
  v_held_prefix text;
  v_foreign     integer;
  v_updated_at  timestamptz;
begin
  select * into d from public.product_drafts where id = p_draft_id for update;
  if not found then
    raise exception 'save_product_draft: no product_draft %', coalesce(p_draft_id::text, '<null>')
      using errcode = '22023';
  end if;

  if d.status = 'published' then
    raise exception 'save_product_draft: draft % is already published', p_draft_id
      using errcode = '55000',
            hint    = 'A published product is changed in Shopify, not by editing the draft it came from.';
  end if;

  if p_expected_updated_at is not null and d.updated_at <> p_expected_updated_at then
    raise exception 'save_product_draft: draft % changed since it was loaded', p_draft_id
      using errcode = '55000',
            hint    = 'Somebody (or another tab) saved this draft after you opened it. Reload it before saving again — nothing you typed has been written.';
  end if;

  select * into c from public.categories where id = p_category_id;
  if not found then
    raise exception 'save_product_draft: unknown category %', coalesce(p_category_id::text, '<null>')
      using errcode = '22023';
  end if;

  if d.reserved_sku is not null then
    v_held_prefix := substring(d.reserved_sku from '^[A-Z]+');
    if v_held_prefix is distinct from c.sku_prefix then
      raise exception
        'save_product_draft: draft % holds % from the % sequence and cannot move to % (%)',
        p_draft_id, d.reserved_sku, v_held_prefix, c.name, c.sku_prefix
        using errcode = '22023',
              hint    = 'The SKU and handle are frozen — they are the idempotency key for Shopify. Create a NEW draft in the correct category; the abandoned number is a harmless gap.';
    end if;
  end if;

  if p_material_id is not null
     and not exists (select 1 from public.materials where id = p_material_id) then
    raise exception 'save_product_draft: unknown material %', p_material_id
      using errcode = '22023';
  end if;

  select count(*) into v_foreign
    from jsonb_array_elements(coalesce(p_images, '[]'::jsonb)) e
   where not exists (
     select 1
       from public.image_versions iv
       join public.intake_files f on f.id = iv.intake_file_id
      where iv.id = (e->>'image_version_id')::uuid
        and f.product_draft_id = p_draft_id
   );
  if v_foreign > 0 then
    raise exception 'save_product_draft: % image version(s) do not belong to draft %', v_foreign, p_draft_id
      using errcode = '22023',
            hint    = 'Only versions of photographs grouped into this draft can be published as its images.';
  end if;

  update public.product_drafts
     set category_id  = c.id,
         material_id  = p_material_id,
         title_suffix = nullif(btrim(coalesce(p_title_suffix, '')), ''),
         price_paise  = p_price_paise,
         weight_g     = p_weight_g,
         stock        = coalesce(p_stock, 0)
   where id = p_draft_id;

  insert into public.colours (name)
  select distinct public.normalise_colour_name(wanted.colour_name)
    from unnest(coalesce(p_colours, array[]::text[])) as wanted(colour_name)
   where btrim(wanted.colour_name) <> ''
  on conflict (name) do nothing;

  delete from public.product_draft_variants pdv
   where pdv.product_draft_id = p_draft_id
     and pdv.colour_id not in (
       select col.id
         from unnest(coalesce(p_colours, array[]::text[])) as wanted(colour_name)
         join public.colours col on col.name = public.normalise_colour_name(wanted.colour_name)
     );

  insert into public.product_draft_variants (product_draft_id, colour_id, position)
  select p_draft_id, col.id, wanted.ordinality - 1
    from unnest(coalesce(p_colours, array[]::text[])) with ordinality as wanted(colour_name, ordinality)
    join public.colours col on col.name = public.normalise_colour_name(wanted.colour_name)
   where btrim(wanted.colour_name) <> ''
  on conflict (product_draft_id, colour_id) do update set position = excluded.position;

  delete from public.product_draft_images pdi
   where pdi.product_draft_id = p_draft_id
     and pdi.image_version_id not in (
       select (e->>'image_version_id')::uuid
         from jsonb_array_elements(coalesce(p_images, '[]'::jsonb)) e
     );

  insert into public.product_draft_images (product_draft_id, image_version_id, position)
  select p_draft_id, (e->>'image_version_id')::uuid, (e->>'position')::integer
    from jsonb_array_elements(coalesce(p_images, '[]'::jsonb)) e
  on conflict (product_draft_id, image_version_id) do update set position = excluded.position;

  select pd.updated_at into v_updated_at from public.product_drafts pd where pd.id = p_draft_id;

  insert into public.events (entity_type, entity_id, event, detail, actor)
  values ('product_draft', p_draft_id, 'draft.saved',
          jsonb_build_object(
            'category', c.name,
            'price_paise', p_price_paise,
            'stock', coalesce(p_stock, 0),
            'weight_g', p_weight_g,
            'colours', to_jsonb(coalesce(p_colours, array[]::text[])),
            'image_count', jsonb_array_length(coalesce(p_images, '[]'::jsonb)),
            'reserved', d.reserved_sku is not null),
          p_actor);

  return v_updated_at;
end;
$$;

comment on function public.save_product_draft(uuid, timestamptz, uuid, uuid, text, integer, integer, integer, text[], jsonb, text) is
  'Persists the whole editor — fields, colours, image selection and order — in one transaction. Reserves NO SKU and moves no counter. Refuses a stale save (55000) and refuses a category change once an identity is reserved (D27).';

revoke all on function public.save_product_draft(uuid, timestamptz, uuid, uuid, text, integer, integer, integer, text[], jsonb, text)
  from public, anon, authenticated;
grant execute on function public.save_product_draft(uuid, timestamptz, uuid, uuid, text, integer, integer, integer, text[], jsonb, text)
  to service_role;
