-- Loupe · Phase 4 — the operator console's write path
--
-- Everything an operator does to a draft happens inside one of these functions,
-- for the same reason the publish transaction does (docs/DECISIONS.md D18):
-- every supabase-js call is its own transaction, so "claim these three photos,
-- create a draft and record which version each one contributes" cannot be
-- assembled out of three round trips without leaving a state nobody planned for
-- if the middle one fails.
--
-- Three races are closed here, and each one is closed by the database rather
-- than by the console being careful:
--
--   grouping        `WHERE product_draft_id IS NULL` on the claiming UPDATE. Two
--                   concurrent groupings of the same photo: the second blocks on
--                   the row lock, re-evaluates after the first commits, matches
--                   zero rows, and the whole transaction raises. Exactly one wins
--                   and the photo can never belong to two drafts.
--   saving          an optimistic `updated_at` check, so a stale editor cannot
--                   silently overwrite a newer save.
--   double publish  a publish LEASE on the draft, the same UUID compare-and-swap
--                   shape as the intake worker's (hard rule 6). A second Publish
--                   is refused while one is in flight, and a crashed publish
--                   self-heals when the lease expires instead of stranding the
--                   draft forever.

-- ---------------------------------------------------------------------------
-- Columns
-- ---------------------------------------------------------------------------

alter table public.product_draft_images
  add column shopify_media_id text;

comment on column public.product_draft_images.shopify_media_id is
  'The Shopify MediaImage id this draft image became, recorded after a successful publish read-back. It is what makes a re-publish reuse the uploaded file instead of uploading it again — including after a reorder, where position alone would pair the wrong image with the wrong alt text.';

alter table public.product_drafts
  add column publish_lease_token      uuid,
  add column publish_lease_expires_at timestamptz;

alter table public.product_drafts
  add constraint product_drafts_publish_lease_is_paired check (
    (publish_lease_token is null and publish_lease_expires_at is null)
    or (publish_lease_token is not null and publish_lease_expires_at is not null)
  );

comment on column public.product_drafts.publish_lease_token is
  'UUID owned by the in-flight publish. A completion must present the same token, so a publish that wakes up after its lease expired cannot clear the lease of the attempt that replaced it.';

alter table public.intake_files
  add column drive_processed_at    timestamptz,
  add column drive_processed_error text;

comment on column public.intake_files.drive_processed_at is
  'When this file was moved into the Drive /Processed folder. HOUSEKEEPING ONLY — hard rule 3. Nothing reads Drive folder membership to decide processing state, and a NULL here on a published row means the tidy-up is outstanding, not that the product is unpublished.';
comment on column public.intake_files.drive_processed_error is
  'Readable reason the last /Processed move failed. Set alongside a published status on purpose: the product stays published and the housekeeping is retried later.';

-- Surfaces "published but never tidied up" without scanning the table.
create index intake_files_drive_housekeeping_idx
  on public.intake_files (published_at)
  where status = 'published' and drive_processed_at is null;

-- ---------------------------------------------------------------------------
-- 1. create_product_draft — group one or more photographs into a new product
-- ---------------------------------------------------------------------------

create or replace function public.create_product_draft(
  p_category_id      uuid,
  p_intake_file_ids  uuid[],
  p_actor            text default null
)
returns uuid
language plpgsql
volatile
set search_path = public, pg_temp
as $$
declare
  c         public.categories%rowtype;
  v_draft   uuid;
  v_wanted  integer := coalesce(array_length(p_intake_file_ids, 1), 0);
  v_claimed integer;
  v_images  integer;
begin
  if v_wanted = 0 then
    raise exception 'create_product_draft: no photographs were supplied'
      using errcode = '22023',
            hint    = 'A product draft is created FROM photographs. Select at least one.';
  end if;

  select * into c from public.categories where id = p_category_id;
  if not found then
    raise exception 'create_product_draft: unknown category %', coalesce(p_category_id::text, '<null>')
      using errcode = '22023';
  end if;

  insert into public.product_drafts (category_id, stock, created_by)
  values (c.id, c.default_stock, p_actor)
  returning id into v_draft;

  -- THE grouping race. `product_draft_id is null` is the whole guard: a second
  -- concurrent request for the same photograph re-evaluates after this commits,
  -- matches nothing, and fails the count check below.
  with claimed as (
    update public.intake_files
       set product_draft_id = v_draft,
           status           = 'grouped',
           grouped_at       = now()
     where id = any(p_intake_file_ids)
       and product_draft_id is null
       and status = 'enhanced'
    returning id
  )
  select count(*) into v_claimed from claimed;

  if v_claimed <> v_wanted then
    raise exception
      'create_product_draft: % of % photographs could not be grouped', v_wanted - v_claimed, v_wanted
      using errcode = '55000',
            hint    = 'Another operator grouped one of these photographs first, or it is not in the enhanced state. Reload the queue and select again — nothing was changed.';
  end if;

  -- Each photograph contributes its currently selected version, falling back to
  -- the newest one it has. The operator can change this per image afterwards.
  insert into public.product_draft_images (product_draft_id, image_version_id, position)
  select v_draft, chosen.id, (row_number() over (order by f.discovered_at, f.id)) - 1
    from public.intake_files f
    join lateral (
      select iv.id
        from public.image_versions iv
       where iv.intake_file_id = f.id
       order by iv.is_selected desc, iv.version_no desc
       limit 1
    ) chosen on true
   where f.product_draft_id = v_draft;

  get diagnostics v_images = row_count;

  insert into public.events (entity_type, entity_id, event, detail, actor)
  values ('product_draft', v_draft, 'draft.created',
          jsonb_build_object(
            'category', c.name, 'sku_prefix', c.sku_prefix,
            'intake_file_ids', to_jsonb(p_intake_file_ids),
            'photograph_count', v_claimed, 'image_count', v_images),
          p_actor);

  insert into public.events (entity_type, entity_id, event, detail, actor)
  select 'intake_file', id, 'intake.grouped',
         jsonb_build_object('product_draft_id', v_draft), p_actor
    from public.intake_files where product_draft_id = v_draft;

  return v_draft;
end;
$$;

comment on function public.create_product_draft(uuid, uuid[], text) is
  'Creates a draft and claims the given photographs for it in ONE transaction. The claim is conditional on product_draft_id being NULL, so concurrent grouping of the same photograph cannot succeed twice — the loser raises 55000 and its whole draft is rolled back.';

-- ---------------------------------------------------------------------------
-- 2. attach_intake_file / detach_intake_file
-- ---------------------------------------------------------------------------

create or replace function public.attach_intake_file(
  p_draft_id       uuid,
  p_intake_file_id uuid,
  p_actor          text default null
)
returns void
language plpgsql
volatile
set search_path = public, pg_temp
as $$
declare
  d          public.product_drafts%rowtype;
  v_claimed  integer;
  v_position integer;
begin
  select * into d from public.product_drafts where id = p_draft_id for update;
  if not found then
    raise exception 'attach_intake_file: no product_draft %', coalesce(p_draft_id::text, '<null>')
      using errcode = '22023';
  end if;
  if d.status = 'published' then
    raise exception 'attach_intake_file: draft % is already published', p_draft_id
      using errcode = '55000',
            hint    = 'A published product is not edited by adding photographs to its draft. Create a new draft, or change the product in Shopify.';
  end if;

  update public.intake_files
     set product_draft_id = p_draft_id,
         status           = 'grouped',
         grouped_at       = now()
   where id = p_intake_file_id
     and product_draft_id is null
     and status = 'enhanced';
  get diagnostics v_claimed = row_count;

  if v_claimed <> 1 then
    raise exception 'attach_intake_file: photograph % could not be grouped', p_intake_file_id
      using errcode = '55000',
            hint    = 'It already belongs to another draft, or it is not enhanced yet. Reload the queue — nothing was changed.';
  end if;

  select coalesce(max(position) + 1, 0) into v_position
    from public.product_draft_images where product_draft_id = p_draft_id;

  insert into public.product_draft_images (product_draft_id, image_version_id, position)
  select p_draft_id, chosen.id, v_position
    from public.intake_files f
    join lateral (
      select iv.id from public.image_versions iv
       where iv.intake_file_id = f.id
       order by iv.is_selected desc, iv.version_no desc
       limit 1
    ) chosen on true
   where f.id = p_intake_file_id
  on conflict (product_draft_id, image_version_id) do nothing;

  insert into public.events (entity_type, entity_id, event, detail, actor)
  values ('intake_file', p_intake_file_id, 'intake.grouped',
          jsonb_build_object('product_draft_id', p_draft_id), p_actor);
end;
$$;

comment on function public.attach_intake_file(uuid, uuid, text) is
  'Adds one already-enhanced photograph to an existing unpublished draft. Same conditional claim as create_product_draft, so it cannot steal a photograph from another draft.';

create or replace function public.detach_intake_file(
  p_draft_id       uuid,
  p_intake_file_id uuid,
  p_actor          text default null
)
returns void
language plpgsql
volatile
set search_path = public, pg_temp
as $$
declare
  d         public.product_drafts%rowtype;
  v_removed integer;
begin
  select * into d from public.product_drafts where id = p_draft_id for update;
  if not found then
    raise exception 'detach_intake_file: no product_draft %', coalesce(p_draft_id::text, '<null>')
      using errcode = '22023';
  end if;

  -- A published draft is the record of what is live in the store. Taking its
  -- photographs back would leave a product whose images trace to nothing.
  if d.status = 'published' then
    raise exception 'detach_intake_file: draft % is published and cannot be dismantled', p_draft_id
      using errcode = '55000',
            hint    = 'Unpublish or delete the product in Shopify first. Loupe will not quietly detach the photographs behind a live listing.';
  end if;

  delete from public.product_draft_images
   where product_draft_id = p_draft_id
     and image_version_id in (
       select id from public.image_versions where intake_file_id = p_intake_file_id
     );

  update public.intake_files
     set product_draft_id = null,
         status           = 'enhanced',
         grouped_at       = null
   where id = p_intake_file_id
     and product_draft_id = p_draft_id;
  get diagnostics v_removed = row_count;

  if v_removed <> 1 then
    raise exception 'detach_intake_file: photograph % does not belong to draft %', p_intake_file_id, p_draft_id
      using errcode = '22023';
  end if;

  -- Positions stay contiguous from 0. The unique index is DEFERRABLE, so the
  -- renumber can pass through colliding values inside this transaction.
  with renumbered as (
    select id, (row_number() over (order by position, id)) - 1 as next_position
      from public.product_draft_images
     where product_draft_id = p_draft_id
  )
  update public.product_draft_images pdi
     set position = renumbered.next_position
    from renumbered
   where pdi.id = renumbered.id
     and pdi.position <> renumbered.next_position;

  insert into public.events (entity_type, entity_id, event, detail, actor)
  values ('intake_file', p_intake_file_id, 'intake.ungrouped',
          jsonb_build_object('product_draft_id', p_draft_id), p_actor);
end;
$$;

comment on function public.detach_intake_file(uuid, uuid, text) is
  'Returns one photograph from an UNPUBLISHED draft to the ungrouped queue, drops its images from the draft and renumbers the rest. Refuses on a published draft.';

-- ---------------------------------------------------------------------------
-- 3. save_product_draft — the whole editor, in one transaction
-- ---------------------------------------------------------------------------
--
-- p_images is [{"image_version_id": uuid, "position": int}, …] in the operator's
-- order. Every version must belong to a photograph currently assigned to this
-- draft: the browser posts ids, and an id that came from somewhere else must not
-- become a published product image.
--
-- p_colours is the display-ordered list of colour NAMES. They go through the
-- normalising trigger (D17), so "rose gold" and "Rose  Gold" reach the same row.

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

  -- Optimistic concurrency. Two editors, or one editor in two tabs: the second
  -- save is refused rather than silently discarding the first.
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

  -- D27. Once an identity is reserved it pins the category, because the SKU came
  -- out of that category's sequence and the handle is frozen.
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

  -- An image the browser named that does not belong to this draft's photographs.
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

  -- Colours → variants. Insert any new names first so the normalising trigger
  -- decides what "the same colour" means, then rebuild this draft's variant set.
  insert into public.colours (name)
  select distinct public.normalise_colour_name(name)
    from unnest(coalesce(p_colours, array[]::text[])) as name
   where btrim(name) <> ''
  on conflict (name) do nothing;

  delete from public.product_draft_variants
   where product_draft_id = p_draft_id
     and colour_id not in (
       select col.id
         from unnest(coalesce(p_colours, array[]::text[])) as name
         join public.colours col on col.name = public.normalise_colour_name(name)
     );

  insert into public.product_draft_variants (product_draft_id, colour_id, position)
  select p_draft_id, col.id, ordinality - 1
    from unnest(coalesce(p_colours, array[]::text[])) with ordinality as t(name, ordinality)
    join public.colours col on col.name = public.normalise_colour_name(t.name)
   where btrim(t.name) <> ''
  on conflict (product_draft_id, colour_id) do update set position = excluded.position;

  -- Images. Upserted rather than replaced, so shopify_media_id survives a
  -- reorder — that id is what stops a re-publish uploading the same file twice.
  delete from public.product_draft_images
   where product_draft_id = p_draft_id
     and image_version_id not in (
       select (e->>'image_version_id')::uuid
         from jsonb_array_elements(coalesce(p_images, '[]'::jsonb)) e
     );

  insert into public.product_draft_images (product_draft_id, image_version_id, position)
  select p_draft_id, (e->>'image_version_id')::uuid, (e->>'position')::integer
    from jsonb_array_elements(coalesce(p_images, '[]'::jsonb)) e
  on conflict (product_draft_id, image_version_id) do update set position = excluded.position;

  select updated_at into v_updated_at from public.product_drafts where id = p_draft_id;

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

-- ---------------------------------------------------------------------------
-- 4. Publish leases — double-submit safety with self-healing
-- ---------------------------------------------------------------------------

create or replace function public.begin_draft_publish(
  p_draft_id      uuid,
  p_lease_seconds integer default 180,
  p_actor         text default null
)
returns uuid
language plpgsql
volatile
set search_path = public, pg_temp
as $$
declare
  d       public.product_drafts%rowtype;
  v_token uuid;
begin
  if p_lease_seconds is null or p_lease_seconds <= 0 or p_lease_seconds > 900 then
    raise exception 'begin_draft_publish: lease must be 1..900 seconds, got %', coalesce(p_lease_seconds::text, '<null>')
      using errcode = '22023';
  end if;

  select * into d from public.product_drafts where id = p_draft_id for update;
  if not found then
    raise exception 'begin_draft_publish: no product_draft %', coalesce(p_draft_id::text, '<null>')
      using errcode = '22023';
  end if;

  -- The double-submit guard. An EXPIRED lease is not an obstacle: a publish that
  -- crashed mid-flight must be retryable, and the retry reuses the same reserved
  -- handle, so it repairs the same Shopify product rather than making a second.
  if d.publish_lease_expires_at is not null and d.publish_lease_expires_at > now() then
    raise exception 'begin_draft_publish: draft % is already being published', p_draft_id
      using errcode = '55000',
            hint    = 'A publish for this product is already running. Wait for it to finish — pressing Publish again cannot create a second product, but it will not speed anything up either.';
  end if;

  v_token := gen_random_uuid();

  update public.product_drafts
     set publish_lease_token      = v_token,
         publish_lease_expires_at = now() + make_interval(secs => p_lease_seconds)
   where id = p_draft_id;

  insert into public.events (entity_type, entity_id, event, detail, actor)
  values ('product_draft', p_draft_id, 'publish.started',
          jsonb_build_object('lease_seconds', p_lease_seconds,
                             'retry', d.reserved_sku is not null), p_actor);

  return v_token;
end;
$$;

comment on function public.begin_draft_publish(uuid, integer, text) is
  'Takes the publish lease for a draft and returns its UUID. Raises 55000 while another publish holds an unexpired lease — that is the double-submit guard. An expired lease is reclaimable so a crashed publish self-heals (hard rule 6).';

create or replace function public.end_draft_publish(
  p_draft_id   uuid,
  p_lease_token uuid
)
returns boolean
language plpgsql
volatile
set search_path = public, pg_temp
as $$
declare
  v_released integer;
begin
  update public.product_drafts
     set publish_lease_token      = null,
         publish_lease_expires_at = null
   where id = p_draft_id
     and publish_lease_token = p_lease_token;
  get diagnostics v_released = row_count;
  return v_released = 1;
end;
$$;

comment on function public.end_draft_publish(uuid, uuid) is
  'Releases a publish lease, but ONLY for the holder of the token. Returns false for a stale caller, so a publish that woke up after its lease expired cannot unlock the attempt that replaced it.';

-- ---------------------------------------------------------------------------
-- 5. record_shopify_media — remember which Shopify file each draft image became
-- ---------------------------------------------------------------------------

create or replace function public.record_shopify_media(
  p_draft_id uuid,
  p_media    jsonb,
  p_actor    text default null
)
returns integer
language plpgsql
volatile
set search_path = public, pg_temp
as $$
declare
  v_updated integer;
begin
  update public.product_draft_images pdi
     set shopify_media_id = m.media_id
    from (
      select (e->>'image_version_id')::uuid as image_version_id,
             nullif(btrim(e->>'media_id'), '') as media_id
        from jsonb_array_elements(coalesce(p_media, '[]'::jsonb)) e
    ) m
   where pdi.product_draft_id  = p_draft_id
     and pdi.image_version_id  = m.image_version_id
     and pdi.shopify_media_id is distinct from m.media_id;
  get diagnostics v_updated = row_count;

  if v_updated > 0 then
    insert into public.events (entity_type, entity_id, event, detail, actor)
    values ('product_draft', p_draft_id, 'publish.media_recorded',
            jsonb_build_object('recorded', v_updated, 'media', coalesce(p_media, '[]'::jsonb)), p_actor);
  end if;

  return v_updated;
end;
$$;

comment on function public.record_shopify_media(uuid, jsonb, text) is
  'Stores the Shopify media id each draft image became, read back from the store after publish. Without it a retry re-uploads every file and the product ends up with duplicate images.';

-- ---------------------------------------------------------------------------
-- 6. record_drive_housekeeping — /Processed is tidy-up, never state
-- ---------------------------------------------------------------------------

create or replace function public.record_drive_housekeeping(
  p_intake_file_id uuid,
  p_ok             boolean,
  p_error          text default null,
  p_actor          text default null
)
returns void
language plpgsql
volatile
set search_path = public, pg_temp
as $$
begin
  -- Deliberately touches neither status nor published_at. Hard rule 3: the Drive
  -- folder is an inbox, not a state machine, and a failed move must never walk a
  -- published photograph back to `enhanced`.
  if p_ok then
    update public.intake_files
       set drive_processed_at    = coalesce(drive_processed_at, now()),
           drive_processed_error = null
     where id = p_intake_file_id;
  else
    update public.intake_files
       set drive_processed_error = left(coalesce(p_error, 'unknown error'), 2000)
     where id = p_intake_file_id;
  end if;

  if not found then
    raise exception 'record_drive_housekeeping: no intake_file %', coalesce(p_intake_file_id::text, '<null>')
      using errcode = '22023';
  end if;

  insert into public.events (entity_type, entity_id, event, detail, actor)
  values ('intake_file', p_intake_file_id,
          case when p_ok then 'drive.processed' else 'drive.processed_failed' end,
          case when p_ok then '{}'::jsonb
               else jsonb_build_object('error', left(coalesce(p_error, 'unknown error'), 2000)) end,
          p_actor);
end;
$$;

comment on function public.record_drive_housekeeping(uuid, boolean, text, text) is
  'Records the outcome of moving a source photograph into Drive /Processed. Never changes intake status — the move is housekeeping and its failure leaves the product published.';

-- ---------------------------------------------------------------------------
-- 7. mark_draft_published — now also finishes the intake rows and colour usage
-- ---------------------------------------------------------------------------
--
-- Extended rather than forked. publishProduct() already calls exactly this
-- function at exactly the right moment, and "the draft is published" and "its
-- photographs are published" are one fact; splitting them across two round trips
-- would create a window where the product exists and its photographs still look
-- like unprocessed work.

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

  -- Colour vocabulary ranking is per category (CLAUDE.md · Colours). Counted on
  -- publish, not on save, so a colour typed and then removed never influences
  -- what the next operator is offered. Guarded on the first publish so a repair
  -- retry does not inflate the ranking.
  if not coalesce(v_was_published, false) then
    insert into public.colour_usage (colour_id, category_id, usage_count, last_used_at)
    select v.colour_id, d.category_id, 1, now()
      from public.product_draft_variants v
      join public.product_drafts d on d.id = v.product_draft_id
     where v.product_draft_id = p_draft_id
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
  'Terminal success transition. Marks the draft AND its intake rows published and counts colour usage for the category, in one transaction. Refuses to record a published draft without the Shopify product id. Re-running it on an already-published draft is safe and does not re-count colours.';

-- ---------------------------------------------------------------------------
-- Server-side only. Same posture as every other write path here (D11).
-- ---------------------------------------------------------------------------

revoke all on function public.create_product_draft(uuid, uuid[], text)          from public, anon, authenticated;
revoke all on function public.attach_intake_file(uuid, uuid, text)              from public, anon, authenticated;
revoke all on function public.detach_intake_file(uuid, uuid, text)              from public, anon, authenticated;
revoke all on function public.save_product_draft(uuid, timestamptz, uuid, uuid, text, integer, integer, integer, text[], jsonb, text)
                                                                                from public, anon, authenticated;
revoke all on function public.begin_draft_publish(uuid, integer, text)          from public, anon, authenticated;
revoke all on function public.end_draft_publish(uuid, uuid)                     from public, anon, authenticated;
revoke all on function public.record_shopify_media(uuid, jsonb, text)           from public, anon, authenticated;
revoke all on function public.record_drive_housekeeping(uuid, boolean, text, text) from public, anon, authenticated;

grant execute on function public.create_product_draft(uuid, uuid[], text)          to service_role;
grant execute on function public.attach_intake_file(uuid, uuid, text)              to service_role;
grant execute on function public.detach_intake_file(uuid, uuid, text)              to service_role;
grant execute on function public.save_product_draft(uuid, timestamptz, uuid, uuid, text, integer, integer, integer, text[], jsonb, text)
                                                                                   to service_role;
grant execute on function public.begin_draft_publish(uuid, integer, text)          to service_role;
grant execute on function public.end_draft_publish(uuid, uuid)                     to service_role;
grant execute on function public.record_shopify_media(uuid, jsonb, text)           to service_role;
grant execute on function public.record_drive_housekeeping(uuid, boolean, text, text) to service_role;
