-- Three owner-requested capabilities, 2026-08-01.
--
--   1. R2 retention: purge a photograph's objects 7 days after its product
--      reached Shopify (published OR saved there as a draft).
--   2. Redo with a per-product prompt override, reviewed before it is spent.
--   3. "On hold" (skipped) work that can be resumed or discarded.

-- ---------------------------------------------------------------------------
-- 1. When did this draft first reach Shopify?
-- ---------------------------------------------------------------------------
--
-- Retention needs one timestamp covering BOTH routes into Shopify: publish
-- (mark_draft_published) and the D60 draft stage (record_draft_shopify_product).
-- A trigger is used rather than editing both functions: it catches every path
-- that sets shopify_product_id, including any future one, and cannot drift out
-- of step with them.

alter table public.product_drafts
  add column if not exists shopify_first_sent_at timestamptz;

comment on column public.product_drafts.shopify_first_sent_at is
  'When this draft first existed in Shopify, by any route (publish or the D60 draft stage). Set once and never moved; it is the clock R2 retention counts from.';

create or replace function public.stamp_shopify_first_sent()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  -- Only the null -> non-null transition. Re-publishing the same product must
  -- not restart its retention clock.
  if new.shopify_product_id is not null
     and old.shopify_product_id is null
     and new.shopify_first_sent_at is null
  then
    new.shopify_first_sent_at := now();
  end if;
  return new;
end;
$$;

drop trigger if exists product_drafts_stamp_shopify_first_sent on public.product_drafts;
create trigger product_drafts_stamp_shopify_first_sent
  before update on public.product_drafts
  for each row
  execute function public.stamp_shopify_first_sent();

-- Existing rows predate the trigger. published_at is the honest answer for a
-- published product; anything else with an id gets its last update, which is
-- the most recent moment it can be proven to have existed in Shopify.
update public.product_drafts
   set shopify_first_sent_at = coalesce(published_at, updated_at)
 where shopify_product_id is not null
   and shopify_first_sent_at is null;

-- ---------------------------------------------------------------------------
-- 2. Purged objects stay auditable
-- ---------------------------------------------------------------------------
--
-- The row is NEVER deleted. image_versions carries the model and the exact
-- prompt_text behind every published image (D5) — that is the record which makes
-- style drift diagnosable after the fact, and it must outlive the pixels.
-- Only the bytes go; the row records that they went.

alter table public.image_versions
  add column if not exists purged_at timestamptz;

comment on column public.image_versions.purged_at is
  'When this version''s R2 objects were deleted by retention. The row itself is kept forever: it holds the model and exact prompt_text behind the image (D5). A non-null value means storage_key/thumb_key no longer resolve.';

create index if not exists image_versions_purge_candidates_idx
  on public.image_versions (purged_at)
  where purged_at is null;

-- ---------------------------------------------------------------------------
-- 3. Per-product redo prompt override
-- ---------------------------------------------------------------------------
--
-- A one-off edit for ONE product's redo. It is deliberately not a prompt
-- version: prompts are immutable, versioned and audited (D51), and a per-product
-- tweak must never silently become the catalogue-wide default. The exact bytes
-- actually sent are still recorded on image_versions.prompt_text either way.

alter table public.image_redo_jobs
  add column if not exists prompt_override text;

comment on column public.image_redo_jobs.prompt_override is
  'Operator-edited prompt for THIS redo only. Null means use the live image prompt resolved as normal. Never promoted into the prompts table (D51).';

-- ---------------------------------------------------------------------------
-- 4. Resume work that was put on hold
-- ---------------------------------------------------------------------------

create or replace function public.resume_intake_file(
  p_intake_file_id uuid,
  p_actor          text
)
returns void
language plpgsql
volatile
set search_path = public, pg_temp
as $$
declare
  v_file public.intake_files%rowtype;
begin
  if p_actor is null or btrim(p_actor) = '' then
    raise exception 'resume_intake_file: p_actor is required' using errcode = '22023';
  end if;

  select * into v_file from public.intake_files where id = p_intake_file_id for update;
  if not found then
    raise exception 'resume_intake_file: no intake_file %', p_intake_file_id
      using errcode = '22023';
  end if;

  -- Only work an operator deliberately put down can be picked back up. A
  -- published, grouped or duplicate photograph is further along and resuming it
  -- would contradict a decision that has already had consequences.
  if v_file.status <> 'skipped' then
    raise exception 'resume_intake_file: only work on hold can be resumed, not %', v_file.status
      using errcode = '55000',
            hint    = 'Only a photograph that was put on hold can be returned to the queue.';
  end if;

  -- Back to the front of the queue with a clean retry budget. The hold was a
  -- human decision, not a failure, so it must not inherit spent attempts
  -- (hard rule 4) — otherwise a resumed item could be one error from terminal.
  update public.intake_files
     set status            = 'discovered',
         attempts          = 0,
         next_attempt_at   = now(),
         last_error        = null,
         last_error_code   = null,
         last_error_detail = null,
         error_class       = null,
         lease_expires_at  = null,
         lease_token       = null
   where id = p_intake_file_id;

  insert into public.events (entity_type, entity_id, event, detail, actor)
  values (
    'intake_file',
    p_intake_file_id,
    'intake.resumed',
    jsonb_build_object('previous_status', v_file.status),
    p_actor
  );
end;
$$;

comment on function public.resume_intake_file(uuid, text) is
  'Returns a photograph that was put on hold to the enhancement queue with a fresh retry budget. Refuses anything not on hold.';

-- ---------------------------------------------------------------------------
-- 5. Discard held work entirely
-- ---------------------------------------------------------------------------
--
-- Deletes the Loupe rows. The caller is responsible for moving the Drive file
-- out of RAW and deleting the R2 objects FIRST — this function is the last
-- step, so a failure earlier leaves the row intact and the operator can retry
-- rather than losing track of a file that is still sitting in the inbox.

create or replace function public.discard_intake_file(
  p_intake_file_id uuid,
  p_actor          text
)
returns void
language plpgsql
volatile
set search_path = public, pg_temp
as $$
declare
  v_file public.intake_files%rowtype;
begin
  if p_actor is null or btrim(p_actor) = '' then
    raise exception 'discard_intake_file: p_actor is required' using errcode = '22023';
  end if;

  select * into v_file from public.intake_files where id = p_intake_file_id for update;
  if not found then
    raise exception 'discard_intake_file: no intake_file %', p_intake_file_id
      using errcode = '22023';
  end if;

  if v_file.status <> 'skipped' then
    raise exception 'discard_intake_file: only work on hold can be discarded, not %', v_file.status
      using errcode = '55000',
            hint    = 'Put the photograph on hold first. Grouped or published work cannot be discarded.';
  end if;

  if v_file.product_draft_id is not null then
    raise exception 'discard_intake_file: % belongs to a product draft', p_intake_file_id
      using errcode = '55000',
            hint    = 'Detach the photograph from its product before discarding it.';
  end if;

  -- Written BEFORE the delete: the row is about to stop existing, and an audit
  -- trail that loses the last thing that happened is not an audit trail. The
  -- event survives because events.entity_id carries no foreign key.
  insert into public.events (entity_type, entity_id, event, detail, actor)
  values (
    'intake_file',
    p_intake_file_id,
    'intake.discarded',
    jsonb_build_object(
      'filename', v_file.filename,
      'drive_file_id', v_file.drive_file_id,
      'drive_md5', v_file.drive_md5
    ),
    p_actor
  );

  -- image_versions is ON DELETE CASCADE from intake_files.
  delete from public.intake_files where id = p_intake_file_id;
end;
$$;

comment on function public.discard_intake_file(uuid, text) is
  'Removes a held photograph and its image_versions from Loupe, after the caller has moved the Drive file out of RAW and deleted its R2 objects. Audits before deleting.';

-- ---------------------------------------------------------------------------
-- 6. Retention candidates
-- ---------------------------------------------------------------------------

create or replace function public.retention_candidates(
  p_days  integer default 7,
  p_limit integer default 200
)
returns table (
  image_version_id uuid,
  intake_file_id   uuid,
  storage_key      text,
  thumb_key        text
)
language sql
stable
set search_path = public, pg_temp
as $$
  select iv.id, iv.intake_file_id, iv.storage_key, iv.thumb_key
    from public.image_versions as iv
    join public.intake_files   as f on f.id = iv.intake_file_id
    join public.product_drafts as d on d.id = f.product_draft_id
   where iv.purged_at is null
     and d.shopify_first_sent_at is not null
     and d.shopify_first_sent_at < now() - make_interval(days => p_days)
   order by d.shopify_first_sent_at
   limit p_limit;
$$;

comment on function public.retention_candidates(integer, integer) is
  'Image versions whose product reached Shopify (published or the D60 draft stage) more than p_days ago and whose R2 objects have not been purged. Shopify serves the published image from its own CDN and Drive /Processed keeps the untouched original, so these bytes are redundant.';

create or replace function public.mark_versions_purged(
  p_image_version_ids uuid[],
  p_actor             text
)
returns integer
language plpgsql
volatile
set search_path = public, pg_temp
as $$
declare
  v_count integer;
begin
  if p_image_version_ids is null or array_length(p_image_version_ids, 1) is null then
    return 0;
  end if;

  update public.image_versions
     set purged_at = now()
   where id = any (p_image_version_ids)
     and purged_at is null;
  get diagnostics v_count = row_count;

  if v_count > 0 then
    insert into public.events (entity_type, entity_id, event, detail, actor)
    values (
      'system',
      null,
      'retention.purged',
      jsonb_build_object('image_versions', v_count),
      p_actor
    );
  end if;

  return v_count;
end;
$$;

comment on function public.mark_versions_purged(uuid[], text) is
  'Marks image_versions rows as having had their R2 objects deleted. The rows are kept: they hold the model and exact prompt behind every image (D5).';

revoke execute on function public.resume_intake_file(uuid, text) from anon, authenticated;
revoke execute on function public.discard_intake_file(uuid, text) from anon, authenticated;
revoke execute on function public.retention_candidates(integer, integer) from anon, authenticated;
revoke execute on function public.mark_versions_purged(uuid[], text) from anon, authenticated;
