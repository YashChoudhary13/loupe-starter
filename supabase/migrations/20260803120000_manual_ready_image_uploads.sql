-- Manual ready-image intake.
--
-- A photographer may already have a catalogue-ready image. It must be able to
-- enter Loupe without being placed in Drive /RAW and without consuming either
-- AI call. The browser uploads the immutable source directly to R2; this table
-- keeps that two-step upload durable, and finalize_manual_image_upload() makes
-- the visible intake row + selected original version one atomic transition.

alter table public.intake_files
  add column source text not null default 'drive';

alter table public.intake_files
  add constraint intake_files_source_is_known
  check (source in ('drive', 'manual'));

comment on column public.intake_files.source is
  'Where the photograph entered Loupe. drive follows RAW/enhancement/housekeeping; manual is already catalogue-ready, bypasses AI, and never enters Drive housekeeping.';

create table public.manual_uploads (
  id             uuid primary key default gen_random_uuid(),
  filename       text not null check (length(btrim(filename)) between 1 and 255),
  mime_type      text not null check (mime_type in ('image/jpeg', 'image/png', 'image/webp')),
  bytes          bigint not null check (bytes between 1 and 50000000),
  storage_key    text not null unique check (length(btrim(storage_key)) > 0),
  status         text not null default 'pending' check (status in ('pending', 'completed', 'failed')),
  error          text,
  created_by     text not null check (length(btrim(created_by)) > 0),
  intake_file_id uuid references public.intake_files (id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  completed_at   timestamptz,

  constraint manual_uploads_completion_is_consistent check (
    (status = 'pending' and intake_file_id is null and completed_at is null and error is null)
    or (status = 'completed' and intake_file_id is not null and completed_at is not null and error is null)
    or (status = 'failed' and intake_file_id is null and completed_at is null and error is not null)
  )
);

create index manual_uploads_pending_created_at_idx
  on public.manual_uploads (created_at)
  where status = 'pending';

create trigger manual_uploads_set_updated_at
  before update on public.manual_uploads
  for each row execute function public.set_updated_at();

comment on table public.manual_uploads is
  'Durable direct-to-R2 upload handshakes for catalogue-ready images. A completed row maps one-to-one to an enhanced intake row whose selected version is the untouched original.';

alter table public.manual_uploads enable row level security;
revoke all on table public.manual_uploads from public, anon, authenticated;
grant select, insert, update, delete on table public.manual_uploads to service_role;

create or replace function public.finalize_manual_image_upload(
  p_upload_id uuid,
  p_thumb_key text,
  p_width integer,
  p_height integer,
  p_phash text,
  p_actor text
)
returns uuid
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
as $$
declare
  v_upload public.manual_uploads%rowtype;
  v_intake_id uuid;
begin
  if p_upload_id is null then
    raise exception 'finalize_manual_image_upload: upload id is required'
      using errcode = '22023';
  end if;
  if nullif(btrim(coalesce(p_thumb_key, '')), '') is null then
    raise exception 'finalize_manual_image_upload: thumbnail key is required'
      using errcode = '22023';
  end if;
  if p_width is null or p_width <= 0 or p_height is null or p_height <= 0 then
    raise exception 'finalize_manual_image_upload: dimensions must be positive'
      using errcode = '22023';
  end if;
  if p_phash is null or p_phash !~ '^[0-9a-f]{16}$' then
    raise exception 'finalize_manual_image_upload: pHash must be 16 lowercase hexadecimal characters'
      using errcode = '22023';
  end if;
  if nullif(btrim(coalesce(p_actor, '')), '') is null then
    raise exception 'finalize_manual_image_upload: actor is required'
      using errcode = '22023';
  end if;

  select *
    into v_upload
    from public.manual_uploads
   where id = p_upload_id
   for update;

  if not found then
    raise exception 'finalize_manual_image_upload: no manual upload %', p_upload_id
      using errcode = 'P0002';
  end if;
  if v_upload.created_by <> btrim(p_actor) then
    raise exception 'finalize_manual_image_upload: upload % belongs to another operator', p_upload_id
      using errcode = '42501';
  end if;
  if v_upload.status = 'completed' then
    return v_upload.intake_file_id;
  end if;
  if v_upload.status <> 'pending' then
    raise exception 'finalize_manual_image_upload: upload % is %', p_upload_id, v_upload.status
      using errcode = '55000',
            hint = 'Choose the image again to start a fresh upload.';
  end if;

  insert into public.intake_files (
    drive_file_id,
    filename,
    bytes,
    mime_type,
    source,
    status,
    attempts,
    next_attempt_at,
    phash,
    enhanced_at
  )
  values (
    'manual:' || v_upload.id::text,
    v_upload.filename,
    v_upload.bytes,
    v_upload.mime_type,
    'manual',
    'enhanced',
    0,
    now(),
    p_phash,
    now()
  )
  returning id into v_intake_id;

  insert into public.image_versions (
    intake_file_id,
    version_no,
    kind,
    storage_key,
    thumb_key,
    width,
    height,
    is_selected
  )
  values (
    v_intake_id,
    0,
    'original',
    v_upload.storage_key,
    btrim(p_thumb_key),
    p_width,
    p_height,
    true
  );

  update public.manual_uploads
     set status = 'completed',
         intake_file_id = v_intake_id,
         completed_at = now(),
         error = null
   where id = v_upload.id;

  insert into public.events (entity_type, entity_id, event, detail, actor)
  values (
    'intake_file',
    v_intake_id,
    'intake.manual_uploaded',
    jsonb_build_object(
      'manual_upload_id', v_upload.id,
      'filename', v_upload.filename,
      'bytes', v_upload.bytes,
      'mime_type', v_upload.mime_type,
      'storage_key', v_upload.storage_key,
      'thumb_key', btrim(p_thumb_key),
      'width', p_width,
      'height', p_height,
      'phash', p_phash,
      'ai_bypassed', true
    ),
    btrim(p_actor)
  );

  return v_intake_id;
end;
$$;

comment on function public.finalize_manual_image_upload(uuid, text, integer, integer, text, text) is
  'Idempotently turns a verified direct R2 upload into one enhanced intake row and one selected pristine original version. No description or image model is called.';

revoke all on function public.finalize_manual_image_upload(uuid, text, integer, integer, text, text)
  from public, anon, authenticated;
grant execute on function public.finalize_manual_image_upload(uuid, text, integer, integer, text, text)
  to service_role;
