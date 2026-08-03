-- Loupe · ring-size variants
--
-- Size is a fourth, mutually exclusive stock shape. It reuses the existing
-- ordered product_draft_variants rows: option_value is the customer-facing
-- Shopify Size value and stock is inventory for that exact size.

alter table public.product_drafts
  drop constraint if exists product_drafts_variant_kind_check;

alter table public.product_drafts
  add constraint product_drafts_variant_kind_check
  check (variant_kind in ('none', 'colour', 'number', 'size'));

comment on column public.product_drafts.variant_kind is
  'none = one default variant; colour = Colour choices; number = photographed Number choices; size = ring Size choices.';

comment on table public.product_draft_variants is
  'Display-ordered Shopify choices with per-choice stock. Colour choices reference the normalised vocabulary; numbered and size choices have colour_id NULL. Every row shares the parent SKU.';

comment on column public.product_draft_variants.option_value is
  'Customer-facing Shopify option value: a normalised colour name, a canonical photographed number, or a trimmed ring-size label.';

-- Keep the existing function signature so both the deployed application and
-- the new bundle use one RPC. pg_get_functiondef is safe here because this
-- migration immediately follows the migration that owns the function. Every
-- replacement is guarded: reset/push fails rather than silently installing a
-- half-updated contract if that preceding definition ever changes.
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
    $old$if v_variant_kind not in ('none', 'colour', 'number') then$old$,
    $new$if v_variant_kind not in ('none', 'colour', 'number', 'size') then$new$
  );
  if v_definition = v_before then
    raise exception 'add_size_variants: could not extend the allowed variant kinds';
  end if;

  v_before := v_definition;
  v_definition := replace(
    v_definition,
    $old$hint = 'Choose one stock mode: One stock, By colour, or Numbered choices.';$old$,
    $new$hint = 'Choose one stock mode: One stock, By colour, Numbered choices, or By size.';$new$
  );
  if v_definition = v_before then
    raise exception 'add_size_variants: could not extend the variant-kind hint';
  end if;

  v_before := v_definition;
  v_definition := replace(
    v_definition,
    $old$hint = 'Reduce the numbered or colour choices to 100 or fewer.';$old$,
    $new$hint = 'Reduce the colour, numbered, or size choices to 100 or fewer.';$new$
  );
  if v_definition = v_before then
    raise exception 'add_size_variants: could not extend the choice-limit hint';
  end if;

  v_before := v_definition;
  v_definition := replace(
    v_definition,
    $old$hint = 'Enter stock as a whole number for every colour or numbered choice.';$old$,
    $new$hint = 'Enter stock as a whole number for every colour, numbered, or size choice.';$new$
  );
  if v_definition = v_before then
    raise exception 'add_size_variants: could not extend the stock hint';
  end if;

  v_before := v_definition;
  v_definition := replace(
    v_definition,
    $old$  if v_variant_kind = 'number' then
$old$,
    $new$  if v_variant_kind = 'size' and exists (
    select 1 from jsonb_array_elements(v_variants) e
     group by lower(regexp_replace(btrim(e->>'value'), '\s+', ' ', 'g'))
    having count(*) > 1
  ) then
    raise exception 'save_product_draft: duplicate size choices'
      using errcode = '22023',
            hint = 'Each size should appear once. Similar casing and repeated spaces are treated as the same size.';
  end if;

  if v_variant_kind = 'number' then
$new$
  );
  if v_definition = v_before then
    raise exception 'add_size_variants: could not install size validation';
  end if;

  v_before := v_definition;
  v_definition := replace(
    v_definition,
    $old$  elsif v_variant_kind = 'number' then
$old$,
    $new$  elsif v_variant_kind = 'size' then
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
$new$
  );
  if v_definition = v_before then
    raise exception 'add_size_variants: could not install size persistence';
  end if;

  execute v_definition;
end;
$migration$;

comment on function public.save_product_draft(
  uuid, timestamptz, uuid, uuid, text, integer, integer, integer, text[], jsonb, text, text, text, text, jsonb
) is
  'Persists the whole editor, including independent stock per colour, photographed number, or ring size. p_colours remains a rolling-deploy compatibility input.';
