-- D103: raw photographs can be uploaded straight into Loupe (no Google Drive)
-- and each can carry its own prompt choice through the AI pipeline.
--
-- Two additions to intake_files:
--   source_storage_key   where the browser-uploaded source lives in R2. The
--                        worker reads this instead of Drive; everything after
--                        the download (originals/{id} immutable copy, describe,
--                        generate, complete) is byte-for-byte the Drive path.
--   preset_slug          the prompt pair this photograph should be enhanced
--                        with. Null keeps today's behaviour: the live default
--                        pair. The worker resolves the newest revision of the
--                        slug's two halves at claim time (D96 semantics).
--
-- drive_file_id stays NOT NULL via the manual-upload precedent: a synthetic
-- 'upload:{manual_upload_id}' id keeps re-scan idempotency and every existing
-- query shape.

alter table public.intake_files
  drop constraint if exists intake_files_source_check;
alter table public.intake_files
  add constraint intake_files_source_check
  check (source in ('drive', 'manual', 'upload'));

alter table public.intake_files
  add column source_storage_key text,
  add column preset_slug        text check (preset_slug is null or preset_slug ~ '^[a-z0-9-]{1,64}(--[a-z0-9-]{1,64})?$');

comment on column public.intake_files.source_storage_key is
  'R2 key of the browser-uploaded source for source=upload rows (D103). Null for Drive rows, which download from Drive by drive_file_id.';
comment on column public.intake_files.preset_slug is
  'Per-photograph prompt pair (D103). The worker uses the newest describe+image revisions carrying this preset_slug; null means the live default pair.';

alter table public.manual_uploads
  add column target text not null default 'ready'
  check (target in ('ready', 'raw'));

comment on column public.manual_uploads.target is
  '''ready'' finalises straight to enhanced (the D-series manual flow); ''raw'' finalises to discovered so the AI pipeline runs (D103).';

-- Finalises a browser upload as RAW pipeline work: row lands in 'discovered'
-- with its prompt binding, and the enhancement worker takes it from there.
create function public.finalize_raw_image_upload(
  p_upload_id   uuid,
  p_thumb_key   text,
  p_width       integer,
  p_height      integer,
  p_phash       text,
  p_preset_slug text default null,
  p_actor       text default null
)
returns uuid
language plpgsql
volatile
set search_path = public, pg_temp
as $$
declare
  v_upload    public.manual_uploads%rowtype;
  v_intake_id uuid;
begin
  if p_thumb_key is null or btrim(p_thumb_key) = '' then
    raise exception 'finalize_raw_image_upload: p_thumb_key is required' using errcode = '22023';
  end if;
  if p_width is null or p_width <= 0 or p_height is null or p_height <= 0 then
    raise exception 'finalize_raw_image_upload: invalid dimensions %x%', p_width, p_height
      using errcode = '22023';
  end if;

  select * into v_upload from public.manual_uploads where id = p_upload_id for update;
  if not found then
    raise exception 'finalize_raw_image_upload: no upload %', p_upload_id using errcode = '22023';
  end if;
  if v_upload.target <> 'raw' then
    raise exception 'finalize_raw_image_upload: upload % is a % upload', p_upload_id, v_upload.target
      using errcode = '22023';
  end if;
  if v_upload.status = 'completed' then
    return v_upload.intake_file_id;
  end if;
  if v_upload.status <> 'pending' then
    raise exception 'finalize_raw_image_upload: upload % is %', p_upload_id, v_upload.status
      using errcode = '55000',
            hint = 'Choose the image again to start a fresh upload.';
  end if;

  insert into public.intake_files (
    drive_file_id, filename, bytes, mime_type,
    source, source_storage_key, preset_slug,
    status, attempts, next_attempt_at, phash
  )
  values (
    'upload:' || v_upload.id::text,
    v_upload.filename,
    v_upload.bytes,
    v_upload.mime_type,
    'upload',
    v_upload.storage_key,
    nullif(btrim(coalesce(p_preset_slug, '')), ''),
    'discovered',
    0,
    now(),
    p_phash
  )
  returning id into v_intake_id;

  update public.manual_uploads
     set status = 'completed', intake_file_id = v_intake_id
   where id = p_upload_id;

  insert into public.events (entity_type, entity_id, event, detail, actor)
  values (
    'intake_file', v_intake_id, 'intake.discovered',
    jsonb_build_object(
      'source', 'upload', 'filename', v_upload.filename, 'bytes', v_upload.bytes,
      'preset_slug', nullif(btrim(coalesce(p_preset_slug, '')), ''),
      'manual_upload_id', v_upload.id
    ),
    p_actor
  );

  return v_intake_id;
end;
$$;

comment on function public.finalize_raw_image_upload(uuid, text, integer, integer, text, text, text) is
  'Turns a verified browser upload into discovered pipeline work with an optional per-photograph prompt binding (D103).';

revoke execute on function public.finalize_raw_image_upload(uuid, text, integer, integer, text, text, text) from public, anon, authenticated;
grant execute on function public.finalize_raw_image_upload(uuid, text, integer, integer, text, text, text) to service_role;

-- claim_intake_file gains the two new columns. Additive at the end, so the
-- currently deployed worker keeps reading the fields it knows.
drop function if exists public.claim_intake_file(integer);

create function public.claim_intake_file(
  p_lease_seconds integer default 900
)
returns table (
  id                            uuid,
  drive_file_id                 text,
  filename                      text,
  drive_md5                     text,
  bytes                         bigint,
  mime_type                     text,
  status                        public.intake_status,
  attempts                      integer,
  lease_token                   uuid,
  lease_expires_at              timestamptz,
  product_description           text,
  presentation_class            public.presentation_class,
  presentation_fallback         boolean,
  presentation_fallback_reason  text,
  description_model             text,
  described_at                  timestamptz,
  description_cost_usd          numeric,
  description_missing_at        timestamptz,
  source_storage_key            text,
  preset_slug                   text
)
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
as $$
declare
  v_file public.intake_files%rowtype;
  v_lease_token uuid := gen_random_uuid();
begin
  if p_lease_seconds is null or p_lease_seconds <= 0 then
    raise exception 'claim_intake_file: p_lease_seconds must be positive, got %',
      coalesce(p_lease_seconds::text, '<null>') using errcode = '22023';
  end if;

  with candidate as (
    select f.id
      from public.intake_files as f
     where f.status = 'discovered'
       and f.next_attempt_at <= now()
       and f.provider_paused_at is null
     order by f.next_attempt_at, f.discovered_at, f.id
     limit 1
       for update skip locked
  )
  update public.intake_files as f
     set status           = 'enhancing',
         lease_token      = v_lease_token,
         lease_expires_at = now() + make_interval(secs => p_lease_seconds)
    from candidate as c
   where f.id = c.id
  returning f.* into v_file;

  if not found then
    return;
  end if;

  insert into public.events (entity_type, entity_id, event, detail)
  values (
    'intake_file',
    v_file.id,
    'intake.claimed',
    jsonb_build_object(
      'attempts_completed', v_file.attempts,
      'lease_token', v_file.lease_token,
      'lease_expires_at', v_file.lease_expires_at,
      'description_cached', v_file.product_description is not null,
      'description_missing', v_file.description_missing_at is not null,
      'presentation_class', v_file.presentation_class,
      'presentation_fallback', v_file.presentation_fallback,
      'presentation_fallback_reason', v_file.presentation_fallback_reason,
      'preset_slug', v_file.preset_slug
    )
  );

  return query
  select
    v_file.id,
    v_file.drive_file_id,
    v_file.filename,
    v_file.drive_md5,
    v_file.bytes,
    v_file.mime_type,
    v_file.status,
    v_file.attempts,
    v_file.lease_token,
    v_file.lease_expires_at,
    v_file.product_description,
    v_file.presentation_class,
    v_file.presentation_fallback,
    v_file.presentation_fallback_reason,
    v_file.description_model,
    v_file.described_at,
    v_file.description_cost_usd,
    v_file.description_missing_at,
    v_file.source_storage_key,
    v_file.preset_slug;
end;
$$;

comment on function public.claim_intake_file(integer) is
  'Claims one due, unpaused intake row with SKIP LOCKED and UUID ownership. Returns the source pointer and prompt binding for upload-sourced work (D103).';

revoke execute on function public.claim_intake_file(integer) from public, anon, authenticated;
grant execute on function public.claim_intake_file(integer) to service_role;
