-- Loupe · Shopify-native colour swatches and per-colour variant images
--
-- `product_draft_images.colour_id` was designed in Phase 1 but the console save
-- RPC never persisted it. This migration activates that existing relationship,
-- validates that one image is assigned to at most one selected colour, and adds
-- the Shopify Standard Product Taxonomy category required by the native
-- `shopify.color-pattern` option.

alter table public.categories
  add column shopify_taxonomy_category_id text
    check (
      shopify_taxonomy_category_id is null
      or shopify_taxonomy_category_id ~ '^gid://shopify/TaxonomyCategory/[a-z0-9-]+$'
    );

comment on column public.categories.shopify_taxonomy_category_id is
  'Confirmed Shopify Standard Product Taxonomy category GID. Required for native category-linked Color swatches; NULL blocks that integration rather than guessing a category.';

-- Shopify Product Taxonomy 2026-08. These are function-based mappings, not
-- collection tags: the existing Qimati categories are unambiguous product
-- classes and the IDs below are Shopify's published canonical categories.
update public.categories
   set shopify_taxonomy_category_id = case sku_prefix
     when 'NK'  then 'gid://shopify/TaxonomyCategory/aa-6-8'     -- Necklaces
     when 'ER'  then 'gid://shopify/TaxonomyCategory/aa-6-6'     -- Earrings
     when 'BK'  then 'gid://shopify/TaxonomyCategory/aa-6-3'     -- Bracelets
     when 'CB'  then 'gid://shopify/TaxonomyCategory/aa-6-3'     -- Bracelets
     when 'RS'  then 'gid://shopify/TaxonomyCategory/aa-6-9'     -- Rings
     when 'AK'  then 'gid://shopify/TaxonomyCategory/aa-6-1'     -- Anklets
     when 'NP'  then 'gid://shopify/TaxonomyCategory/aa-6-2'     -- Body Jewelry
     when 'WH'  then 'gid://shopify/TaxonomyCategory/aa-6-11'    -- Watches
     when 'HC'  then 'gid://shopify/TaxonomyCategory/aa-6-3'     -- Bracelets
     when 'INJ' then 'gid://shopify/TaxonomyCategory/aa-6-7'     -- Jewelry Sets
     when 'HA'  then 'gid://shopify/TaxonomyCategory/aa-2-14-13' -- Hair Bands
     else shopify_taxonomy_category_id
   end;

-- Keep the rolling-deploy-compatible RPC signature. Each guarded replacement
-- fails closed if the preceding save function ever changes shape.
do $migration$
declare
  v_definition text;
  v_before     text;
begin
  select pg_get_functiondef(
    'public.save_product_draft(uuid,timestamptz,uuid,uuid,text,integer,integer,integer,text[],jsonb,text,text,text,text,jsonb)'::regprocedure
  ) into v_definition;

  v_before := v_definition;
  v_definition := replace(
    v_definition,
    $old$  update public.product_drafts
$old$,
    $new$  if v_variant_kind <> 'colour' and exists (
    select 1
      from jsonb_array_elements(coalesce(p_images, '[]'::jsonb)) e
     where nullif(btrim(e->>'colour'), '') is not null
  ) then
    raise exception 'save_product_draft: only colour variants can have colour-specific images'
      using errcode = '22023',
            hint = 'Clear image colour assignments or switch the stock method back to By colour.';
  end if;

  if v_variant_kind = 'colour' and exists (
    select 1
      from jsonb_array_elements(coalesce(p_images, '[]'::jsonb)) image
     where nullif(btrim(image->>'colour'), '') is not null
       and not exists (
         select 1
           from jsonb_array_elements(v_variants) variant
          where public.normalise_colour_name(variant->>'value') =
                public.normalise_colour_name(image->>'colour')
       )
  ) then
    raise exception 'save_product_draft: an image points to a colour that is not selected'
      using errcode = '22023',
            hint = 'Choose one of this draft''s colour variants for every colour-specific image.';
  end if;

  if v_variant_kind = 'colour' and exists (
    select 1
      from jsonb_array_elements(coalesce(p_images, '[]'::jsonb)) image
     where nullif(btrim(image->>'colour'), '') is not null
     group by public.normalise_colour_name(image->>'colour')
    having count(*) > 1
  ) then
    raise exception 'save_product_draft: more than one image points to the same colour'
      using errcode = '22023',
            hint = 'Shopify supports one featured image per variant. Assign each colour to at most one image.';
  end if;

  update public.product_drafts
$new$
  );
  if v_definition = v_before then
    raise exception 'shopify_native_colour_swatches: could not install image-colour validation';
  end if;

  v_before := v_definition;
  v_definition := replace(
    v_definition,
    $old$  insert into public.product_draft_images (product_draft_id, image_version_id, position)
  select p_draft_id, (e->>'image_version_id')::uuid, (e->>'position')::integer
    from jsonb_array_elements(coalesce(p_images, '[]'::jsonb)) e
  on conflict (product_draft_id, image_version_id) do update set position = excluded.position;
$old$,
    $new$  insert into public.product_draft_images (
    product_draft_id, image_version_id, position, colour_id
  )
  select p_draft_id,
         (image.entry->>'image_version_id')::uuid,
         (image.entry->>'position')::integer,
         colour.id
    from jsonb_array_elements(coalesce(p_images, '[]'::jsonb)) image(entry)
    left join public.colours colour
      on v_variant_kind = 'colour'
     and colour.name = public.normalise_colour_name(image.entry->>'colour')
  on conflict (product_draft_id, image_version_id) do update
    set position = excluded.position,
        colour_id = excluded.colour_id;
$new$
  );
  if v_definition = v_before then
    raise exception 'shopify_native_colour_swatches: could not install image-colour persistence';
  end if;

  execute v_definition;
end;
$migration$;

comment on function public.save_product_draft(
  uuid, timestamptz, uuid, uuid, text, integer, integer, integer, text[], jsonb, text, text, text, text, jsonb
) is
  'Persists the whole editor, including independent option stock and optional one-image-per-colour Shopify variant assignments. p_colours remains a rolling-deploy compatibility input.';
