create role anon;create role authenticated;create role service_role;
create type public.app_role as enum ('admin','operator');
create type public.draft_status as enum ('assembling','publishing','published','failed');
create type public.duplicate_review_decision as enum ('dismissed','duplicate');
create type public.error_class as enum ('retryable','permanent');
create type public.image_kind as enum ('original','generated');
create type public.image_redo_status as enum ('queued','processing','completed','failed');
create type public.intake_status as enum ('discovered','enhancing','enhanced','grouped','published','failed','duplicate','skipped','identifying','restock','restocked');
create type public.presentation_class as enum ('pair-upright','flat-curve','standing-three-quarter','angled-band','flat-arc','tray-grid','necklace-pendant','necklace-station','necklace-multistrand','necklace-lariat');
create type public.prompt_kind as enum ('describe','image');
create type public.shopify_reconciliation_status as enum ('running','completed','failed');
create table public.categories (id uuid default gen_random_uuid() not null,
name text not null,
sku_prefix text not null,
title_pattern text not null,
shopify_tag text,
default_weight_g integer,
default_stock integer default 0 not null,
sort_order integer default 0 not null,
active boolean default true not null,
created_at timestamp with time zone default now() not null,
updated_at timestamp with time zone default now() not null,
shopify_taxonomy_category_id text);
create table public.materials (id uuid default gen_random_uuid() not null,
name text not null,
sort_order integer default 0 not null,
active boolean default true not null,
created_at timestamp with time zone default now() not null);
create table public.colours (id uuid default gen_random_uuid() not null,
name text not null,
created_at timestamp with time zone default now() not null,
archived_at timestamp with time zone);
create table public.sku_counters (sku_prefix text not null,
last_number integer default 0 not null,
updated_at timestamp with time zone default now() not null);
create table public.product_drafts (id uuid default gen_random_uuid() not null,
category_id uuid not null,
material_id uuid,
title_suffix text,
price_paise integer,
weight_g integer,
stock integer default 0 not null,
status draft_status default 'assembling'::draft_status not null,
reserved_sku text,
reserved_handle text,
shopify_product_id text,
published_at timestamp with time zone,
created_by text,
error text,
created_at timestamp with time zone default now() not null,
updated_at timestamp with time zone default now() not null,
publish_lease_token uuid,
publish_lease_expires_at timestamp with time zone,
custom_material text,
description_override text,
shopify_first_sent_at timestamp with time zone,
variant_kind text default 'none'::text not null,
supersedes_sku text);
create table public.product_draft_variants (id uuid default gen_random_uuid() not null,
product_draft_id uuid not null,
colour_id uuid,
position integer default 0 not null,
option_value text not null,
stock integer not null);
create table public.intake_files (id uuid default gen_random_uuid() not null,
drive_file_id text not null,
filename text not null,
drive_md5 text,
bytes bigint,
status intake_status default 'discovered'::intake_status not null,
attempts integer default 0 not null,
last_error text,
last_error_code text,
error_class error_class,
lease_expires_at timestamp with time zone,
phash text,
discovered_at timestamp with time zone default now() not null,
enhanced_at timestamp with time zone,
grouped_at timestamp with time zone,
published_at timestamp with time zone,
product_draft_id uuid,
created_at timestamp with time zone default now() not null,
updated_at timestamp with time zone default now() not null,
mime_type text,
next_attempt_at timestamp with time zone default now() not null,
last_error_detail text,
lease_token uuid,
product_description text,
description_model text,
described_at timestamp with time zone,
description_cost_usd numeric(12,6),
description_error text,
description_error_code text,
description_error_detail text,
description_missing_at timestamp with time zone,
presentation_class presentation_class,
presentation_fallback boolean default false not null,
presentation_fallback_reason text,
drive_processed_at timestamp with time zone,
drive_processed_error text,
source text default 'drive'::text not null,
provider_paused_at timestamp with time zone,
provider_pause_code text,
provider_pause_message text,
provider_pause_detail text,
source_storage_key text,
preset_slug text);
create table public.image_versions (id uuid default gen_random_uuid() not null,
intake_file_id uuid not null,
version_no integer not null,
kind image_kind not null,
storage_key text not null,
width integer,
height integer,
prompt_text text,
model text,
cost_usd numeric(12,6),
parent_version_id uuid,
is_selected boolean default false not null,
thumb_key text,
created_at timestamp with time zone default now() not null,
description_injected boolean,
description_missing boolean,
purged_at timestamp with time zone);
create table public.product_draft_images (id uuid default gen_random_uuid() not null,
product_draft_id uuid not null,
image_version_id uuid not null,
position integer default 0 not null,
colour_id uuid,
shopify_media_id text);
create table public.events (id bigint generated by default as identity not null,
entity_type text not null,
entity_id uuid,
event text not null,
detail jsonb default '{}'::jsonb not null,
actor text,
created_at timestamp with time zone default now() not null);
alter table public.categories add constraint categories_default_stock_check CHECK ((default_stock >= 0));
alter table public.categories add constraint categories_default_weight_g_check CHECK (((default_weight_g IS NULL) OR (default_weight_g >= 0)));
alter table public.categories add constraint categories_name_key UNIQUE (name);
alter table public.categories add constraint categories_pkey PRIMARY KEY (id);
alter table public.categories add constraint categories_shopify_tag_check CHECK ((length(btrim(shopify_tag)) > 0));
alter table public.categories add constraint categories_shopify_taxonomy_category_id_check CHECK (((shopify_taxonomy_category_id IS NULL) OR (shopify_taxonomy_category_id ~ '^gid://shopify/TaxonomyCategory/[a-z0-9-]+$'::text)));
alter table public.categories add constraint categories_sku_prefix_check CHECK ((sku_prefix ~ '^[A-Z]{2,4}$'::text));
alter table public.categories add constraint categories_sku_prefix_key UNIQUE (sku_prefix);
alter table public.categories add constraint categories_title_pattern_check CHECK ((title_pattern ~~ '%{n}%'::text));
alter table public.colours add constraint colours_name_check CHECK ((length(btrim(name)) > 0));
alter table public.colours add constraint colours_name_key UNIQUE (name);
alter table public.colours add constraint colours_pkey PRIMARY KEY (id);
alter table public.events add constraint events_entity_type_check CHECK ((length(btrim(entity_type)) > 0));
alter table public.events add constraint events_event_check CHECK ((length(btrim(event)) > 0));
alter table public.events add constraint events_pkey PRIMARY KEY (id);
alter table public.image_versions add constraint image_versions_cost_usd_check CHECK (((cost_usd IS NULL) OR (cost_usd >= (0)::numeric)));
alter table public.image_versions add constraint image_versions_generated_is_attributed CHECK (((kind <> 'generated'::image_kind) OR ((prompt_text IS NOT NULL) AND (model IS NOT NULL) AND (cost_usd IS NOT NULL) AND (description_injected IS NOT NULL) AND (description_missing IS NOT NULL) AND (NOT (description_injected AND description_missing)))));
alter table public.image_versions add constraint image_versions_height_check CHECK (((height IS NULL) OR (height > 0)));
alter table public.image_versions add constraint image_versions_intake_file_id_version_no_key UNIQUE (intake_file_id, version_no);
alter table public.image_versions add constraint image_versions_no_self_parent CHECK ((parent_version_id IS DISTINCT FROM id));
alter table public.image_versions add constraint image_versions_original_is_pristine CHECK (((kind <> 'original'::image_kind) OR ((prompt_text IS NULL) AND (model IS NULL) AND (cost_usd IS NULL) AND (parent_version_id IS NULL) AND (description_injected IS NULL) AND (description_missing IS NULL))));
alter table public.image_versions add constraint image_versions_pkey PRIMARY KEY (id);
alter table public.image_versions add constraint image_versions_storage_key_check CHECK ((length(btrim(storage_key)) > 0));
alter table public.image_versions add constraint image_versions_version_no_check CHECK ((version_no >= 0));
alter table public.image_versions add constraint image_versions_width_check CHECK (((width IS NULL) OR (width > 0)));
alter table public.intake_files add constraint intake_files_attempts_check CHECK ((attempts >= 0));
alter table public.intake_files add constraint intake_files_bytes_check CHECK (((bytes IS NULL) OR (bytes >= 0)));
alter table public.intake_files add constraint intake_files_description_is_complete CHECK ((((product_description IS NULL) AND (description_model IS NULL) AND (described_at IS NULL) AND (description_cost_usd IS NULL)) OR ((length(btrim(product_description)) > 0) AND (length(btrim(description_model)) > 0) AND (described_at IS NOT NULL) AND (description_cost_usd IS NOT NULL) AND (description_cost_usd >= (0)::numeric))));
alter table public.intake_files add constraint intake_files_description_missing_has_no_text CHECK (((description_missing_at IS NULL) OR (product_description IS NULL)));
alter table public.intake_files add constraint intake_files_drive_file_id_key UNIQUE (drive_file_id);
alter table public.intake_files add constraint intake_files_failure_is_explained CHECK (((status <> 'failed'::intake_status) OR ((last_error IS NOT NULL) AND (error_class IS NOT NULL))));
alter table public.intake_files add constraint intake_files_grouped_has_draft CHECK (((status <> ALL (ARRAY['grouped'::intake_status, 'published'::intake_status])) OR (product_draft_id IS NOT NULL)));
alter table public.intake_files add constraint intake_files_phase_3a_lease_pair CHECK (((lease_token IS NULL) = (lease_expires_at IS NULL)));
alter table public.intake_files add constraint intake_files_pkey PRIMARY KEY (id);
alter table public.intake_files add constraint intake_files_presentation_audit_is_consistent CHECK ((((presentation_class IS NULL) AND (NOT presentation_fallback) AND (presentation_fallback_reason IS NULL)) OR ((presentation_class IS NOT NULL) AND (((NOT presentation_fallback) AND (presentation_fallback_reason IS NULL)) OR (presentation_fallback AND (presentation_class = 'flat-curve'::presentation_class) AND (length(btrim(presentation_fallback_reason)) > 0))))));
alter table public.intake_files add constraint intake_files_preset_slug_check CHECK (((preset_slug IS NULL) OR (preset_slug ~ '^[a-z0-9-]{1,64}(--[a-z0-9-]{1,64})?$'::text)));
alter table public.intake_files add constraint intake_files_provider_pause_complete_chk CHECK ((((provider_paused_at IS NULL) AND (provider_pause_code IS NULL) AND (provider_pause_message IS NULL) AND (provider_pause_detail IS NULL)) OR ((provider_paused_at IS NOT NULL) AND (length(btrim(provider_pause_code)) > 0) AND (length(btrim(provider_pause_message)) > 0))));
alter table public.intake_files add constraint intake_files_source_check CHECK ((source = ANY (ARRAY['drive'::text, 'manual'::text, 'upload'::text])));
alter table public.materials add constraint materials_name_key UNIQUE (name);
alter table public.materials add constraint materials_pkey PRIMARY KEY (id);
alter table public.product_draft_images add constraint product_draft_images_pkey PRIMARY KEY (id);
alter table public.product_draft_images add constraint product_draft_images_position_check CHECK (("position" >= 0));
alter table public.product_draft_images add constraint product_draft_images_product_draft_id_image_version_id_key UNIQUE (product_draft_id, image_version_id);
alter table public.product_draft_images add constraint product_draft_images_product_draft_id_position_key UNIQUE (product_draft_id, "position") DEFERRABLE INITIALLY DEFERRED;
alter table public.product_draft_variants add constraint product_draft_variants_option_value_clean CHECK (((option_value = btrim(option_value)) AND ((length(option_value) >= 1) AND (length(option_value) <= 100))));
alter table public.product_draft_variants add constraint product_draft_variants_option_value_key UNIQUE (product_draft_id, option_value);
alter table public.product_draft_variants add constraint product_draft_variants_pkey PRIMARY KEY (id);
alter table public.product_draft_variants add constraint product_draft_variants_position_check CHECK (("position" >= 0));
alter table public.product_draft_variants add constraint product_draft_variants_product_draft_id_colour_id_key UNIQUE (product_draft_id, colour_id);
alter table public.product_draft_variants add constraint product_draft_variants_product_draft_id_position_key UNIQUE (product_draft_id, "position") DEFERRABLE INITIALLY DEFERRED;
alter table public.product_draft_variants add constraint product_draft_variants_stock_nonnegative CHECK ((stock >= 0));
alter table public.product_drafts add constraint product_drafts_custom_material_is_clean CHECK (((custom_material IS NULL) OR ((custom_material = btrim(custom_material)) AND ((length(custom_material) >= 1) AND (length(custom_material) <= 100)))));
alter table public.product_drafts add constraint product_drafts_description_override_is_clean CHECK (((description_override IS NULL) OR ((description_override = btrim(description_override)) AND ((length(description_override) >= 1) AND (length(description_override) <= 5000)))));
alter table public.product_drafts add constraint product_drafts_one_material_source CHECK (((material_id IS NULL) OR (custom_material IS NULL)));
alter table public.product_drafts add constraint product_drafts_pkey PRIMARY KEY (id);
alter table public.product_drafts add constraint product_drafts_price_paise_check CHECK (((price_paise IS NULL) OR (price_paise > 0)));
alter table public.product_drafts add constraint product_drafts_publish_lease_is_paired CHECK ((((publish_lease_token IS NULL) AND (publish_lease_expires_at IS NULL)) OR ((publish_lease_token IS NOT NULL) AND (publish_lease_expires_at IS NOT NULL))));
alter table public.product_drafts add constraint product_drafts_published_is_identified CHECK (((status <> 'published'::draft_status) OR ((reserved_sku IS NOT NULL) AND (reserved_handle IS NOT NULL) AND (published_at IS NOT NULL))));
alter table public.product_drafts add constraint product_drafts_reserved_handle_check CHECK ((length(btrim(reserved_handle)) > 0));
alter table public.product_drafts add constraint product_drafts_reserved_sku_check CHECK ((reserved_sku ~ '^[A-Z]{2,4}[0-9]{3,}$'::text));
alter table public.product_drafts add constraint product_drafts_stock_check CHECK ((stock >= 0));
alter table public.product_drafts add constraint product_drafts_variant_kind_check CHECK ((variant_kind = ANY (ARRAY['none'::text, 'colour'::text, 'number'::text, 'size'::text])));
alter table public.product_drafts add constraint product_drafts_weight_g_check CHECK (((weight_g IS NULL) OR (weight_g >= 0)));
alter table public.sku_counters add constraint sku_counters_last_number_check CHECK ((last_number >= 0));
alter table public.sku_counters add constraint sku_counters_pkey PRIMARY KEY (sku_prefix);
CREATE OR REPLACE FUNCTION public.next_sku(p_prefix text)
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_next integer;
begin
  update public.sku_counters
     set last_number = last_number + 1,
         updated_at  = now()
   where sku_prefix = p_prefix
  returning last_number into v_next;

  if not found then
    raise exception 'next_sku: unknown SKU prefix %', coalesce(p_prefix, '<null>')
      using errcode = '22023',
            hint    = 'Confirm the category against the live store, then add it to categories and sku_counters. Do not invent a prefix.';
  end if;

  return v_next;
end;
$function$
;
CREATE OR REPLACE FUNCTION public.normalise_colour_name(p_name text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
  select initcap(regexp_replace(btrim(p_name), '\s+', ' ', 'g'));
$function$
;
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

  if v_variant_kind not in ('none', 'colour', 'number', 'size') then
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

  if v_variant_kind <> 'colour' and exists (
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
      on v_variant_kind = 'colour'
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
CREATE OR REPLACE FUNCTION public.set_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
begin new.updated_at := now(); return new; end;
$function$
;
CREATE OR REPLACE FUNCTION public.sync_product_draft_option_stock()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_draft_id uuid := coalesce(new.product_draft_id, old.product_draft_id);
  v_kind     text;
  v_stock    integer;
begin
  select variant_kind into v_kind
    from public.product_drafts
   where id = v_draft_id;

  -- During a switch back to one-stock mode, save_product_draft has already put
  -- the intended simple quantity on the parent before deleting old rows.
  if v_kind is null or v_kind = 'none' then
    return null;
  end if;

  select coalesce(max(stock), 0)::integer into v_stock
    from public.product_draft_variants
   where product_draft_id = v_draft_id;

  update public.product_drafts
     set stock = v_stock
   where id = v_draft_id
     and stock is distinct from v_stock;

  return null;
end;
$function$
;
create trigger product_drafts_set_updated_at before update on product_drafts for each row execute function set_updated_at();
create trigger product_draft_variants_sync_parent_stock after insert or delete or update of stock on product_draft_variants for each row execute function sync_product_draft_option_stock();
