-- Loupe · Console-managed categories and the first Waist Chain sequence
--
-- A category is not just a label. It owns an SKU prefix, an atomic counter,
-- a title pattern, an exact Shopify collection tag, and a Shopify taxonomy
-- category. Creating only the category row leaves next_sku() unable to allocate;
-- creating those rows in separate browser requests can leave that half-state
-- behind after a crash. This function establishes the complete boundary in one
-- transaction and is callable only through Loupe's service role.

create or replace function public.create_console_category(
  p_name                         text,
  p_sku_prefix                   text,
  p_title_pattern                text,
  p_shopify_tag                  text,
  p_shopify_taxonomy_category_id text,
  p_actor                        text default null
)
returns uuid
language plpgsql
volatile
set search_path = public, pg_temp
as $$
declare
  v_name           text := btrim(coalesce(p_name, ''));
  v_prefix         text := upper(btrim(coalesce(p_sku_prefix, '')));
  v_title_pattern  text := btrim(coalesce(p_title_pattern, ''));
  v_shopify_tag    text := btrim(coalesce(p_shopify_tag, ''));
  v_taxonomy_id    text := btrim(coalesce(p_shopify_taxonomy_category_id, ''));
  v_sort_order     integer;
  v_category_id    uuid;
begin
  if length(v_name) < 2 or length(v_name) > 80 then
    raise exception 'create_console_category: category name must be 2 to 80 characters'
      using errcode = '22023',
            hint = 'Use the customer-facing category name, for example Waist Chains.';
  end if;

  if v_prefix !~ '^[A-Z]{2,4}$' then
    raise exception 'create_console_category: invalid SKU prefix %', coalesce(nullif(v_prefix, ''), '<empty>')
      using errcode = '22023',
            hint = 'SKU letters must be 2 to 4 uppercase letters, for example WC.';
  end if;

  if length(v_title_pattern) < 5 or length(v_title_pattern) > 100
     or (length(v_title_pattern) - length(replace(v_title_pattern, '{n}', ''))) / 3 <> 1 then
    raise exception 'create_console_category: title pattern must contain {n} exactly once'
      using errcode = '22023',
            hint = 'Use a pattern such as Waist Chain {n}. Loupe replaces {n} with 001, 002, and so on.';
  end if;

  if length(v_shopify_tag) < 1 or length(v_shopify_tag) > 100 then
    raise exception 'create_console_category: Shopify collection tag must be 1 to 100 characters'
      using errcode = '22023',
            hint = 'Enter the exact tag that the Shopify collection uses, including its casing.';
  end if;

  if v_taxonomy_id !~ '^gid://shopify/TaxonomyCategory/[a-z0-9-]+$' then
    raise exception 'create_console_category: invalid Shopify taxonomy category'
      using errcode = '22023',
            hint = 'Search Shopify product categories in the console and choose one of the results.';
  end if;

  -- Serialises sort placement only. Unique(name) and unique(sku_prefix) are the
  -- actual duplicate guards, while the counter remains independent per prefix.
  perform pg_advisory_xact_lock(hashtextextended('loupe:create-console-category', 0));
  select coalesce(max(sort_order), 0) + 10 into v_sort_order from public.categories;

  insert into public.categories (
    name,
    sku_prefix,
    title_pattern,
    shopify_tag,
    shopify_taxonomy_category_id,
    default_weight_g,
    default_stock,
    sort_order,
    active
  ) values (
    v_name,
    v_prefix,
    v_title_pattern,
    v_shopify_tag,
    v_taxonomy_id,
    0,
    0,
    v_sort_order,
    true
  ) returning id into v_category_id;

  insert into public.sku_counters (sku_prefix, last_number)
  values (v_prefix, 0);

  insert into public.events (entity_type, entity_id, event, detail, actor)
  values (
    'category',
    v_category_id,
    'category.created',
    jsonb_build_object(
      'name', v_name,
      'sku_prefix', v_prefix,
      'title_pattern', v_title_pattern,
      'shopify_tag', v_shopify_tag,
      'shopify_taxonomy_category_id', v_taxonomy_id,
      'first_sku', v_prefix || '001'
    ),
    p_actor
  );

  return v_category_id;
exception
  when unique_violation then
    raise exception 'create_console_category: that category name or SKU prefix already exists'
      using errcode = '23505',
            hint = 'Choose a different category name and SKU letters. Existing SKU sequences cannot be reused.';
end;
$$;

comment on function public.create_console_category(text, text, text, text, text, text) is
  'Atomically creates one active category, its zeroed independent SKU counter, and an audit event. Exact tag and taxonomy are required; numbers are never allocated here.';

revoke all on function public.create_console_category(text, text, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.create_console_category(text, text, text, text, text, text)
  to service_role;

-- Business-requested first use of the new rule. The live Shopify catalogue has
-- no Waist Chain products or collection yet, so there is no historical maximum
-- to preserve. WC therefore starts at zero and the first saved identity is WC001.
insert into public.categories (
  name,
  sku_prefix,
  title_pattern,
  shopify_tag,
  shopify_taxonomy_category_id,
  default_weight_g,
  default_stock,
  sort_order,
  active
) values (
  'Waist Chains',
  'WC',
  'Waist Chain {n}',
  'Waist Chain',
  'gid://shopify/TaxonomyCategory/aa-6-2', -- Body Jewelry
  0,
  0,
  120,
  true
)
on conflict (sku_prefix) do nothing;

insert into public.sku_counters (sku_prefix, last_number)
values ('WC', 0)
on conflict (sku_prefix) do nothing;

insert into public.events (entity_type, event, detail, actor)
select
  'system',
  'seed.category_wc',
  jsonb_build_object(
    'name', 'Waist Chains',
    'sku_prefix', 'WC',
    'title_pattern', 'Waist Chain {n}',
    'shopify_tag', 'Waist Chain',
    'shopify_taxonomy_category_id', 'gid://shopify/TaxonomyCategory/aa-6-2',
    'first_sku', 'WC001'
  ),
  'migration:20260804200000'
where not exists (
  select 1
    from public.events
   where entity_type = 'system'
     and event = 'seed.category_wc'
);
