drop extension if exists "pg_net";

set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public._loupe_schema_report()
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
  select jsonb_build_object(
    'tables', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'name', c.relname,
               'rls_enabled', c.relrowsecurity,
               'policy_count', (select count(*) from pg_policy p where p.polrelid = c.oid)
             ) order by c.relname), '[]'::jsonb)
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r'
    ),
    'indexes', (
      select coalesce(jsonb_agg(c.relname order by c.relname), '[]'::jsonb)
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'i'
    ),
    'enums', (
      select coalesce(jsonb_object_agg(t.typname, vals), '{}'::jsonb)
        from pg_type t
        join pg_namespace n on n.oid = t.typnamespace
        join lateral (
          select jsonb_agg(e.enumlabel order by e.enumsortorder) as vals
            from pg_enum e where e.enumtypid = t.oid
        ) v on true
       where n.nspname = 'public' and t.typtype = 'e'
    ),
    'functions', (
      select coalesce(jsonb_agg(p.proname order by p.proname), '[]'::jsonb)
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
    ),
    'columns', (
      select coalesce(jsonb_object_agg(k, v), '{}'::jsonb) from (
        select c.relname || '.' || a.attname as k,
               format_type(a.atttypid, a.atttypmod) as v
          from pg_attribute a
          join pg_class c on c.oid = a.attrelid
          join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relkind = 'r' and a.attnum > 0 and not a.attisdropped
      ) s
    )
  );
$function$
;

CREATE OR REPLACE FUNCTION public.app_users_normalise()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
begin new.email := lower(btrim(new.email)); return new; end;
$function$
;

CREATE OR REPLACE FUNCTION public.colours_normalise()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin new.name := public.normalise_colour_name(new.name); return new; end;
$function$
;

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

CREATE OR REPLACE FUNCTION public.reserve_draft_identity(p_draft_id uuid, p_actor text DEFAULT NULL::text)
 RETURNS TABLE(draft_id uuid, sku text, sku_number integer, handle text, title text, shopify_tag text, reused boolean)
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  d              public.product_drafts%rowtype;
  c              public.categories%rowtype;
  v_number       integer;
  v_sku          text;
  v_title        text;
  v_handle       text;
  v_reused       boolean := false;
  v_held_prefix  text;
begin
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

  if d.price_paise is null or d.price_paise <= 0 then
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

    -- ...but only if the draft is still in the category the identity came from.
    -- Otherwise the retry would publish e.g. SKU NK005 titled "Rings 005" on
    -- handle necklace-005, tagged into the Rings collection, while RS005 stays
    -- unissued for a genuine ring later. Nothing would error.
    if v_held_prefix is distinct from c.sku_prefix then
      raise exception
        'reserve_draft_identity: draft % holds % from the % sequence, but its category is now % (%)',
        p_draft_id, d.reserved_sku, v_held_prefix, c.name, c.sku_prefix
        using errcode = '22023',
              hint    = 'A reserved SKU and handle are frozen — they are the idempotency key for productSet and cannot move between sequences. Create a NEW draft in the correct category. The abandoned number is a gap, and gaps are harmless; a product whose SKU prefix disagrees with its category is not.';
    end if;

    v_reused := true;
    v_sku    := d.reserved_sku;
    v_handle := d.reserved_handle;
    v_number := substring(d.reserved_sku from '[0-9]+$')::integer;
  else
    v_number := public.next_sku(c.sku_prefix);
    v_sku    := c.sku_prefix || public.pad_sku_number(v_number);
  end if;

  -- Re-rendered on every call on purpose, so a corrected title_suffix reaches the
  -- retry. Safe now that the category behind it cannot have changed.
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
      'reused', v_reused
    ),
    p_actor
  );

  return query select p_draft_id, v_sku, v_number, v_handle, v_title, c.shopify_tag, v_reused;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.set_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin new.updated_at := now(); return new; end;
$function$
;

grant delete on table "public"."app_users" to "service_role";

grant insert on table "public"."app_users" to "service_role";

grant select on table "public"."app_users" to "service_role";

grant update on table "public"."app_users" to "service_role";

grant delete on table "public"."categories" to "service_role";

grant insert on table "public"."categories" to "service_role";

grant select on table "public"."categories" to "service_role";

grant update on table "public"."categories" to "service_role";

grant delete on table "public"."colour_usage" to "service_role";

grant insert on table "public"."colour_usage" to "service_role";

grant select on table "public"."colour_usage" to "service_role";

grant update on table "public"."colour_usage" to "service_role";

grant delete on table "public"."colours" to "service_role";

grant insert on table "public"."colours" to "service_role";

grant select on table "public"."colours" to "service_role";

grant update on table "public"."colours" to "service_role";

grant delete on table "public"."events" to "service_role";

grant insert on table "public"."events" to "service_role";

grant select on table "public"."events" to "service_role";

grant update on table "public"."events" to "service_role";

grant delete on table "public"."image_versions" to "service_role";

grant insert on table "public"."image_versions" to "service_role";

grant select on table "public"."image_versions" to "service_role";

grant update on table "public"."image_versions" to "service_role";

grant delete on table "public"."intake_files" to "service_role";

grant insert on table "public"."intake_files" to "service_role";

grant select on table "public"."intake_files" to "service_role";

grant update on table "public"."intake_files" to "service_role";

grant delete on table "public"."materials" to "service_role";

grant insert on table "public"."materials" to "service_role";

grant select on table "public"."materials" to "service_role";

grant update on table "public"."materials" to "service_role";

grant delete on table "public"."product_draft_images" to "service_role";

grant insert on table "public"."product_draft_images" to "service_role";

grant select on table "public"."product_draft_images" to "service_role";

grant update on table "public"."product_draft_images" to "service_role";

grant delete on table "public"."product_draft_variants" to "service_role";

grant insert on table "public"."product_draft_variants" to "service_role";

grant select on table "public"."product_draft_variants" to "service_role";

grant update on table "public"."product_draft_variants" to "service_role";

grant delete on table "public"."product_drafts" to "service_role";

grant insert on table "public"."product_drafts" to "service_role";

grant select on table "public"."product_drafts" to "service_role";

grant update on table "public"."product_drafts" to "service_role";

grant delete on table "public"."prompts" to "service_role";

grant insert on table "public"."prompts" to "service_role";

grant select on table "public"."prompts" to "service_role";

grant update on table "public"."prompts" to "service_role";

grant delete on table "public"."sku_counters" to "service_role";

grant insert on table "public"."sku_counters" to "service_role";

grant select on table "public"."sku_counters" to "service_role";

grant update on table "public"."sku_counters" to "service_role";


