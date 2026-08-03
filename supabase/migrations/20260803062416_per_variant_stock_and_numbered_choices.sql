-- Loupe · per-choice stock and numbered tray choices
--
-- A product now has one of three inventory shapes:
--   none    one Shopify variant, using product_drafts.stock
--   colour  one variant per colour, each with its own stock
--   number  one variant per photographed number, each with its own stock
--
-- Existing colour drafts are migrated without changing what Shopify receives:
-- every old colour row inherits the old shared stock value. The draft-level
-- stock becomes the SUM of its variants and remains the quick validation/read
-- model value; the variant rows are authoritative whenever options exist.

alter table public.product_drafts
  add column variant_kind text not null default 'none'
    check (variant_kind in ('none', 'colour', 'number'));

alter table public.product_draft_variants
  add column option_value text,
  add column stock integer;

update public.product_draft_variants v
   set option_value = c.name,
       stock = d.stock
  from public.colours c,
       public.product_drafts d
 where c.id = v.colour_id
   and d.id = v.product_draft_id;

alter table public.product_draft_variants
  alter column colour_id drop not null,
  alter column option_value set not null,
  alter column stock set not null,
  add constraint product_draft_variants_stock_nonnegative check (stock >= 0),
  add constraint product_draft_variants_option_value_clean check (
    option_value = btrim(option_value)
    and length(option_value) between 1 and 100
  ),
  add constraint product_draft_variants_option_value_key
    unique (product_draft_id, option_value);

update public.product_drafts d
   set variant_kind = 'colour',
       stock = totals.total_stock
  from (
    select product_draft_id, sum(stock)::integer as total_stock
      from public.product_draft_variants
     group by product_draft_id
  ) totals
 where totals.product_draft_id = d.id;

comment on column public.product_drafts.variant_kind is
  'none = one default variant; colour = one Shopify Colour choice per row; number = one Shopify Number choice per row.';
comment on column public.product_drafts.stock is
  'Total available stock. For option products it is derived from product_draft_variants.stock on every save.';
comment on table public.product_draft_variants is
  'Display-ordered Shopify choices with per-choice stock. Colour choices reference the normalised vocabulary; numbered tray choices have colour_id NULL. Every row shares the parent SKU.';
comment on column public.product_draft_variants.option_value is
  'Customer-facing Shopify option value: a normalised colour name or a canonical positive number.';
comment on column public.product_draft_variants.stock is
  'Available inventory for this exact Shopify choice at the primary location.';

-- Extend the one existing save function with the general p_variant_kind text +
-- p_variants jsonb pair. p_colours remains as a deprecated, defaulted input for
-- a rolling deployment: the currently deployed console can keep saving while
-- the new app bundle is being published. There is still only ONE overload.
drop function public.save_product_draft(
  uuid, timestamptz, uuid, uuid, text, integer, integer, integer, text[], jsonb, text, text, text
);

create function public.save_product_draft(
  p_draft_id             uuid,
  p_expected_updated_at  timestamptz,
  p_category_id          uuid,
  p_material_id          uuid,
  p_title_suffix         text,
  p_price_paise          integer,
  p_weight_g             integer,
  p_stock                integer,
  p_colours              text[] default null,
  p_images               jsonb default '[]'::jsonb,
  p_actor                text default null,
  p_custom_material      text default null,
  p_description_override text default null,
  p_variant_kind         text default null,
  p_variants             jsonb default null
)
returns timestamptz
language plpgsql
volatile
set search_path = public, pg_temp
as $$
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

  if v_variant_kind not in ('none', 'colour', 'number') then
    raise exception 'save_product_draft: unknown variant kind %', p_variant_kind
      using errcode = '22023',
            hint = 'Choose one stock mode: One stock, By colour, or Numbered choices.';
  end if;

  if jsonb_typeof(v_variants) <> 'array' then
    raise exception 'save_product_draft: variants must be a JSON array'
      using errcode = '22023';
  end if;
  if jsonb_array_length(v_variants) > 100 then
    raise exception 'save_product_draft: at most 100 choices are supported'
      using errcode = '22023',
            hint = 'Reduce the numbered or colour choices to 100 or fewer.';
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
            hint = 'Enter stock as a whole number for every colour or numbered choice.';
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

  if v_variant_kind = 'colour' then
    insert into public.colours (name)
    select distinct public.normalise_colour_name(e->>'value')
      from jsonb_array_elements(v_variants) e
    on conflict (name) do nothing;
  end if;

  delete from public.product_draft_variants where product_draft_id = p_draft_id;

  if v_variant_kind = 'colour' then
    insert into public.product_draft_variants (
      product_draft_id, colour_id, option_value, stock, position
    )
    select p_draft_id,
           col.id,
           col.name,
           (wanted.entry->>'stock')::integer,
           wanted.ordinality - 1
      from jsonb_array_elements(v_variants) with ordinality as wanted(entry, ordinality)
      join public.colours col
        on col.name = public.normalise_colour_name(wanted.entry->>'value');
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
            'image_count', jsonb_array_length(coalesce(p_images, '[]'::jsonb)),
            'reserved', d.reserved_sku is not null),
          p_actor);

  return v_updated_at;
end;
$$;

comment on function public.save_product_draft(
  uuid, timestamptz, uuid, uuid, text, integer, integer, integer, text[], jsonb, text, text, text, text, jsonb
) is
  'Persists the whole editor, including per-colour or per-number stock, in one transaction. p_colours is a rolling-deploy compatibility input and is ignored when p_variant_kind is supplied.';

revoke all on function public.save_product_draft(
  uuid, timestamptz, uuid, uuid, text, integer, integer, integer, text[], jsonb, text, text, text, text, jsonb
) from public, anon, authenticated;
grant execute on function public.save_product_draft(
  uuid, timestamptz, uuid, uuid, text, integer, integer, integer, text[], jsonb, text, text, text, text, jsonb
) to service_role;

-- Numbered rows deliberately have no colour_id, so colour ranking must ignore
-- them. Replacing the function also keeps its first-publish idempotency guard.
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
declare
  v_was_published boolean;
  v_intake        integer;
begin
  if p_shopify_product_id is null or btrim(p_shopify_product_id) = '' then
    raise exception 'mark_draft_published: refusing to mark draft % published with no Shopify product id', p_draft_id
      using errcode = '22023';
  end if;

  select status = 'published' into v_was_published
    from public.product_drafts where id = p_draft_id;

  update public.product_drafts
     set status             = 'published',
         shopify_product_id = p_shopify_product_id,
         published_at       = coalesce(published_at, now()),
         error              = null
   where id = p_draft_id;

  if not found then
    raise exception 'mark_draft_published: no product_draft %', p_draft_id using errcode = '22023';
  end if;

  update public.intake_files
     set status       = 'published',
         published_at = coalesce(published_at, now())
   where product_draft_id = p_draft_id
     and status <> 'published';
  get diagnostics v_intake = row_count;

  if not coalesce(v_was_published, false) then
    insert into public.colour_usage (colour_id, category_id, usage_count, last_used_at)
    select v.colour_id, d.category_id, 1, now()
      from public.product_draft_variants v
      join public.product_drafts d on d.id = v.product_draft_id
     where v.product_draft_id = p_draft_id
       and v.colour_id is not null
    on conflict (colour_id, category_id) do update
      set usage_count  = public.colour_usage.usage_count + 1,
          last_used_at = now();
  end if;

  insert into public.events (entity_type, entity_id, event, detail, actor)
  values ('product_draft', p_draft_id, 'publish.published',
          jsonb_build_object('shopify_product_id', p_shopify_product_id,
                             'intake_files_published', coalesce(v_intake, 0),
                             'repeat', coalesce(v_was_published, false)), p_actor);

  insert into public.events (entity_type, entity_id, event, detail, actor)
  select 'intake_file', id, 'intake.published',
         jsonb_build_object('product_draft_id', p_draft_id,
                            'shopify_product_id', p_shopify_product_id), p_actor
    from public.intake_files
   where product_draft_id = p_draft_id
     and not coalesce(v_was_published, false);
end;
$$;

comment on function public.mark_draft_published(uuid, text, text) is
  'Terminal success transition. Marks the draft and intake rows published, and counts only colour variants in the per-category suggestion ranking.';
