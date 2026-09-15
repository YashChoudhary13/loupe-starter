-- Sparse colour + size choices. The parent allocator is unchanged.
-- Depends on variant_barcode_scheme: legacy drafts must keep their old identity.
alter table public.product_drafts drop constraint product_drafts_variant_kind_check;
alter table public.product_drafts add constraint product_drafts_variant_kind_check
  check (variant_kind in ('none', 'colour', 'number', 'size', 'colour_size'));
alter table public.product_drafts add constraint product_drafts_combinations_need_codes
  check (variant_kind <> 'colour_size' or sku_scheme = 'variant-v1');

alter table public.product_draft_variants add column size_value text
  check (size_value is null or (size_value = btrim(size_value) and length(size_value) between 1 and 100));
alter table public.product_draft_variants drop constraint product_draft_variants_option_value_key;
alter table public.product_draft_variants drop constraint product_draft_variants_product_draft_id_colour_id_key;
alter table public.product_draft_variants add constraint product_draft_variants_option_pair_key
  unique nulls not distinct (product_draft_id, option_value, size_value);
create unique index product_draft_variants_single_colour_key
  on public.product_draft_variants(product_draft_id, colour_id) where size_value is null;
create unique index product_draft_variants_colour_size_key
  on public.product_draft_variants(product_draft_id, colour_id, lower(regexp_replace(size_value, '\s+', ' ', 'g')))
  where size_value is not null;

create function public.validate_draft_variant_dimensions() returns trigger
language plpgsql set search_path = public, pg_temp as $$
declare v_kind text;
begin
  select variant_kind into v_kind from public.product_drafts where id = new.product_draft_id;
  if v_kind = 'colour_size' then
    if new.size_value is null or new.colour_id is null then
      raise exception 'A colour and size combination requires both colour and size' using errcode = '22023';
    end if;
  elsif new.size_value is not null then
    raise exception 'Size belongs in size_value only for a colour and size combination' using errcode = '22023';
  end if;
  return new;
end $$;
revoke all on function public.validate_draft_variant_dimensions() from public, anon, authenticated;
create trigger product_draft_variants_validate_dimensions before insert or update
  on public.product_draft_variants for each row execute function public.validate_draft_variant_dimensions();

comment on column public.product_draft_variants.size_value is
  'Only colour_size rows use this second dimension. option_value remains the colour; each actual pair has independent stock.';

CREATE OR REPLACE FUNCTION public.save_product_draft(p_draft_id uuid, p_expected_updated_at timestamp with time zone, p_category_id uuid, p_material_id uuid, p_title_suffix text, p_price_paise integer, p_weight_g integer, p_stock integer, p_colours text[] DEFAULT NULL::text[], p_images jsonb DEFAULT '[]'::jsonb, p_actor text DEFAULT NULL::text, p_custom_material text DEFAULT NULL::text, p_description_override text DEFAULT NULL::text, p_variant_kind text DEFAULT NULL::text, p_variants jsonb DEFAULT NULL::jsonb)
 RETURNS timestamp with time zone
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  d                      public.product_drafts%rowtype;
  c                      public.categories%rowtype;
  v_held_prefix          text;
  v_foreign              integer;
  v_updated_at           timestamptz;
  v_custom_material      text;
  v_description_override text;
  v_variant_kind         text;
  v_variants             jsonb;
  v_total_stock          integer;
begin
  select * into d from public.product_drafts where id = p_draft_id for update;
  if not found then
    raise exception 'save_product_draft: no product_draft %', coalesce(p_draft_id::text, '<null>')
      using errcode = '22023';
  end if;

  if d.status = 'published' then
    raise exception 'save_product_draft: draft % is already published', p_draft_id
      using errcode = '55000',
            hint = 'A published product is changed in Shopify, not by editing the draft it came from.';
  end if;

  if p_expected_updated_at is not null and d.updated_at <> p_expected_updated_at then
    raise exception 'save_product_draft: draft % changed since it was loaded', p_draft_id
      using errcode = '55000',
            hint = 'Somebody (or another tab) saved this draft after you opened it. Reload it before saving again — nothing you typed has been written.';
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
              hint = 'The SKU and handle are frozen — they are the idempotency key for Shopify. Create a NEW draft in the correct category; the abandoned number is a harmless gap.';
    end if;
  end if;

  if p_material_id is not null
     and not exists (select 1 from public.materials where id = p_material_id) then
    raise exception 'save_product_draft: unknown material %', p_material_id
      using errcode = '22023';
  end if;

  v_custom_material := nullif(
    regexp_replace(btrim(coalesce(p_custom_material, '')), '\s+', ' ', 'g'),
    ''
  );
  if p_material_id is not null and v_custom_material is not null then
    raise exception 'save_product_draft: choose a listed material or a custom material, not both'
      using errcode = '22023',
            hint = 'Clear the custom material or choose Custom instead of a listed material.';
  end if;
  if length(v_custom_material) > 100 then
    raise exception 'save_product_draft: custom material is longer than 100 characters'
      using errcode = '22023',
            hint = 'Shorten the custom material name to 100 characters or fewer.';
  end if;

  v_description_override := nullif(btrim(coalesce(p_description_override, '')), '');
  if length(v_description_override) > 5000 then
    raise exception 'save_product_draft: description override is longer than 5000 characters'
      using errcode = '22023',
            hint = 'Shorten the description to 5,000 characters or reset it to the default.';
  end if;

  -- Legacy colour-only callers omit the new fields. Convert their list into
  -- the new rows using the old shared-stock semantics, so applying this
  -- migration does not create a save outage during the app rollout.
  if p_variant_kind is null then
    v_variant_kind := case
      when coalesce(cardinality(p_colours), 0) > 0 then 'colour'
      else 'none'
    end;
    select coalesce(
             jsonb_agg(
               jsonb_build_object(
                 'value', wanted.colour_name,
                 'stock', coalesce(p_stock, 0)
               )
               order by wanted.ordinality
             ),
             '[]'::jsonb
           )
      into v_variants
      from unnest(coalesce(p_colours, array[]::text[]))
           with ordinality as wanted(colour_name, ordinality);
  else
    v_variant_kind := lower(btrim(p_variant_kind));
    v_variants := coalesce(p_variants, '[]'::jsonb);
  end if;

  if v_variant_kind not in ('none', 'colour', 'number', 'size', 'colour_size') then
    raise exception 'save_product_draft: unknown variant kind %', p_variant_kind
      using errcode = '22023',
            hint = 'Choose one stock mode: One stock, By colour, Numbered choices, or By size.';
  end if;

  if jsonb_typeof(v_variants) <> 'array' then
    raise exception 'save_product_draft: variants must be a JSON array'
      using errcode = '22023';
  end if;
  if jsonb_array_length(v_variants) > 100 then
    raise exception 'save_product_draft: at most 100 choices are supported'
      using errcode = '22023',
            hint = 'Reduce the colour, numbered, or size choices to 100 or fewer.';
  end if;
  if v_variant_kind = 'none' and jsonb_array_length(v_variants) > 0 then
    raise exception 'save_product_draft: one-stock products cannot carry option rows'
      using errcode = '22023';
  end if;

  if exists (
    select 1 from jsonb_array_elements(v_variants) e
     where jsonb_typeof(e) <> 'object'
        or nullif(btrim(e->>'value'), '') is null
        or length(btrim(e->>'value')) > 100
  ) then
    raise exception 'save_product_draft: every choice needs a value of 100 characters or fewer'
      using errcode = '22023',
            hint = 'Remove blank choices and shorten any choice name longer than 100 characters.';
  end if;

  if exists (
    select 1 from jsonb_array_elements(v_variants) e
     where coalesce(e->>'stock', '') !~ '^[0-9]+$'
        or length(e->>'stock') > 9
  ) then
    raise exception 'save_product_draft: every choice needs a whole-number stock of zero or more'
      using errcode = '22023',
            hint = 'Enter stock as a whole number for every colour, numbered, or size choice.';
  end if;

  if v_variant_kind = 'colour' and exists (
    select 1 from jsonb_array_elements(v_variants) e
     group by public.normalise_colour_name(e->>'value')
    having count(*) > 1
  ) then
    raise exception 'save_product_draft: duplicate colour choices'
      using errcode = '22023',
            hint = 'Each colour should appear once. Similar casing and repeated spaces are treated as the same colour.';
  end if;

  if v_variant_kind = 'colour_size' then
    if d.sku_scheme <> 'variant-v1' then
      raise exception 'save_product_draft: start a new draft for colour and size combinations with separate barcodes' using errcode = '22023';
    end if;
    if exists (
      select 1 from jsonb_array_elements(v_variants) e
       where nullif(btrim(e->>'sizeValue'), '') is null
          or length(btrim(e->>'sizeValue')) > 100
    ) then
      raise exception 'save_product_draft: every colour needs its selected size' using errcode = '22023';
    end if;
    if exists (
      select 1 from jsonb_array_elements(v_variants) e
       group by public.normalise_colour_name(e->>'value'), lower(regexp_replace(btrim(e->>'sizeValue'), '\s+', ' ', 'g'))
      having count(*) > 1
    ) then
      raise exception 'save_product_draft: duplicate colour and size combination' using errcode = '22023';
    end if;
  elsif exists (
    select 1 from jsonb_array_elements(v_variants) e
     where nullif(btrim(e->>'sizeValue'), '') is not null
  ) then
    raise exception 'save_product_draft: sizes beside colours require Colour + size mode' using errcode = '22023';
  end if;

  if v_variant_kind = 'size' and exists (
    select 1 from jsonb_array_elements(v_variants) e
     group by lower(regexp_replace(btrim(e->>'value'), '\s+', ' ', 'g'))
    having count(*) > 1
  ) then
    raise exception 'save_product_draft: duplicate size choices'
      using errcode = '22023',
            hint = 'Each size should appear once. Similar casing and repeated spaces are treated as the same size.';
  end if;

  if v_variant_kind = 'number' then
    if exists (
      select 1 from jsonb_array_elements(v_variants) e
       where btrim(e->>'value') !~ '^[1-9][0-9]*$'
          or length(btrim(e->>'value')) > 3
    ) then
      raise exception 'save_product_draft: numbered choices must be whole numbers from 1 to 100'
        using errcode = '22023',
              hint = 'Use the numbered-choice count to create choices 1 through 100.';
    end if;
    if exists (
      select 1 from jsonb_array_elements(v_variants) e
       where (btrim(e->>'value'))::integer > 100
    ) then
      raise exception 'save_product_draft: numbered choices must be 100 or less'
        using errcode = '22023',
              hint = 'This console supports up to 100 photographed numbers on one product.';
    end if;
    if exists (
      select 1 from jsonb_array_elements(v_variants) e
       group by (btrim(e->>'value'))::integer
      having count(*) > 1
    ) then
      raise exception 'save_product_draft: duplicate numbered choices'
        using errcode = '22023';
    end if;
  end if;

  if v_variant_kind = 'none' then
    v_total_stock := coalesce(p_stock, 0);
    if v_total_stock < 0 then
      raise exception 'save_product_draft: stock cannot be negative' using errcode = '22023';
    end if;
  else
    select coalesce(sum((e->>'stock')::integer), 0)::integer
      into v_total_stock
      from jsonb_array_elements(v_variants) e;
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
            hint = 'Only versions of photographs grouped into this draft can be published as its images.';
  end if;

  if v_variant_kind not in ('colour', 'colour_size') and exists (
    select 1
      from jsonb_array_elements(coalesce(p_images, '[]'::jsonb)) e
     where nullif(btrim(e->>'colour'), '') is not null
  ) then
    raise exception 'save_product_draft: only colour variants can have colour-specific images'
      using errcode = '22023',
            hint = 'Clear image colour assignments or switch the stock method back to By colour.';
  end if;

  if v_variant_kind in ('colour', 'colour_size') and exists (
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

  if v_variant_kind in ('colour', 'colour_size') and exists (
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
     set category_id          = c.id,
         material_id          = p_material_id,
         custom_material      = v_custom_material,
         description_override = v_description_override,
         title_suffix         = nullif(btrim(coalesce(p_title_suffix, '')), ''),
         price_paise          = p_price_paise,
         weight_g             = p_weight_g,
         stock                = v_total_stock,
         variant_kind         = v_variant_kind
   where id = p_draft_id;

  if v_variant_kind in ('colour', 'colour_size') then
    insert into public.colours (name)
    select distinct public.normalise_colour_name(e->>'value')
      from jsonb_array_elements(v_variants) e
    on conflict (name) do nothing;
  end if;

  delete from public.product_draft_variants where product_draft_id = p_draft_id;

  if v_variant_kind in ('colour', 'colour_size') then
    insert into public.product_draft_variants (
      product_draft_id, colour_id, option_value, size_value, stock, position
    )
    select p_draft_id,
           col.id,
           col.name,
           case when v_variant_kind = 'colour_size' then regexp_replace(btrim(wanted.entry->>'sizeValue'), '\s+', ' ', 'g') else null end,
           (wanted.entry->>'stock')::integer,
           wanted.ordinality - 1
      from jsonb_array_elements(v_variants) with ordinality as wanted(entry, ordinality)
      join public.colours col
        on col.name = public.normalise_colour_name(wanted.entry->>'value');
  elsif v_variant_kind = 'size' then
    insert into public.product_draft_variants (
      product_draft_id, colour_id, option_value, stock, position
    )
    select p_draft_id,
           null,
           regexp_replace(btrim(wanted.entry->>'value'), '\s+', ' ', 'g'),
           (wanted.entry->>'stock')::integer,
           wanted.ordinality - 1
      from jsonb_array_elements(v_variants) with ordinality as wanted(entry, ordinality);
  elsif v_variant_kind = 'number' then
    insert into public.product_draft_variants (
      product_draft_id, colour_id, option_value, stock, position
    )
    select p_draft_id,
           null,
           (btrim(wanted.entry->>'value'))::integer::text,
           (wanted.entry->>'stock')::integer,
           wanted.ordinality - 1
      from jsonb_array_elements(v_variants) with ordinality as wanted(entry, ordinality);
  end if;

  -- D107: an empty p_images means the client had not learned the images yet
  -- (the preview round trip races the first save), never "remove every image".
  -- The group-time defaults survive; removal goes through detach_intake_file.
  if jsonb_array_length(coalesce(p_images, '[]'::jsonb)) > 0 then

  delete from public.product_draft_images pdi
   where pdi.product_draft_id = p_draft_id
     and pdi.image_version_id not in (
       select (e->>'image_version_id')::uuid
         from jsonb_array_elements(coalesce(p_images, '[]'::jsonb)) e
     );

  insert into public.product_draft_images (
    product_draft_id, image_version_id, position, colour_id
  )
  select p_draft_id,
         (image.entry->>'image_version_id')::uuid,
         (image.entry->>'position')::integer,
         colour.id
    from jsonb_array_elements(coalesce(p_images, '[]'::jsonb)) image(entry)
    left join public.colours colour
      on v_variant_kind in ('colour', 'colour_size')
     and colour.name = public.normalise_colour_name(image.entry->>'colour')
  on conflict (product_draft_id, image_version_id) do update
    set position = excluded.position,
        colour_id = excluded.colour_id;

  end if;

  select pd.updated_at into v_updated_at from public.product_drafts pd where pd.id = p_draft_id;

  insert into public.events (entity_type, entity_id, event, detail, actor)
  values ('product_draft', p_draft_id, 'draft.saved',
          jsonb_build_object(
            'category', c.name,
            'material', coalesce(
              v_custom_material,
              (select m.name from public.materials m where m.id = p_material_id)
            ),
            'description_overridden', v_description_override is not null,
            'price_paise', p_price_paise,
            'stock', v_total_stock,
            'weight_g', p_weight_g,
            'variant_kind', v_variant_kind,
            'variants', v_variants,
            'image_count', (select count(*) from public.product_draft_images held
                              where held.product_draft_id = p_draft_id),
            'reserved', d.reserved_sku is not null),
          p_actor);

  return v_updated_at;
end;
$function$
;
