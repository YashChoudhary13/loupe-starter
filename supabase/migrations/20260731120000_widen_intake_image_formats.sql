-- Widens Phase 3A intake beyond JPEG/PNG/WebP to also accept GIF and TIFF —
-- confirmed decodable by the deployed sharp/libvips build (cgif 0.5.3, tiff
-- present; checked directly against sharp.format at runtime, 2026-07-31).
--
-- HEIC/HEIF (the default iPhone camera format) is deliberately NOT added here.
-- The same sharp build reports heif input support with fileSuffix ['.avif']
-- only — libheif is present but without the licensed HEVC decoder that real
-- .heic files need, so accepting the MIME type here would trade a clear
-- "unsupported format" rejection at intake for a confusing decode failure
-- later in the enhancement worker. Adding real HEIC support needs a different
-- decode path (e.g. a conversion step or a differently-built image library),
-- which is a deliberate capability change, not this migration.
--
-- D31 already anticipated this: "Widening it later is a deliberate capability
-- change." This is that change, scoped to what is actually verified to work.

comment on column public.intake_files.mime_type is
  'Drive MIME type captured at discovery. image/jpeg, image/png, image/webp, image/gif and image/tiff enter the enhancement queue; HEIC/HEIF is not decodable by the deployed image library and is rejected.';

create or replace function public.discover_intake_file(
  p_drive_file_id text,
  p_filename      text,
  p_drive_md5     text,
  p_bytes         bigint,
  p_mime_type     text,
  p_source        text
)
returns table (
  id       uuid,
  inserted boolean,
  status   public.intake_status,
  attempts integer
)
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
as $$
declare
  v_id           uuid;
  v_inserted     boolean;
  v_status       public.intake_status;
  v_attempts     integer;
  v_reason       text;
  v_code         text;
  v_raw_detail   text;
  -- 50 MB is exactly 50,000,000 bytes (decimal), not 50 MiB — corrected by
  -- 20260729124000_intake_size_limit_decimal_mb.sql. This migration only
  -- widens the MIME allowlist; it must not regress that fix.
  v_max_bytes    constant bigint := 50000000;
  v_allowed      constant text[] := array[
    'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/tiff'
  ];
begin
  if p_drive_file_id is null or btrim(p_drive_file_id) = '' then
    raise exception 'discover_intake_file: p_drive_file_id must not be empty'
      using errcode = '22023';
  end if;

  if p_filename is null or btrim(p_filename) = '' then
    raise exception 'discover_intake_file: p_filename must not be empty for Drive file %',
      p_drive_file_id using errcode = '22023';
  end if;

  -- Hard rule 3 is load-bearing: record the inbox item before validation or any
  -- external work. A replay sees the UNIQUE drive_file_id and changes nothing.
  insert into public.intake_files (
    drive_file_id,
    filename,
    drive_md5,
    bytes,
    mime_type,
    status,
    attempts,
    next_attempt_at
  )
  values (
    p_drive_file_id,
    p_filename,
    p_drive_md5,
    p_bytes,
    p_mime_type,
    'discovered',
    0,
    now()
  )
  on conflict (drive_file_id) do nothing
  returning intake_files.id, intake_files.status, intake_files.attempts
       into v_id, v_status, v_attempts;

  v_inserted := found;

  if not v_inserted then
    select f.id, f.status, f.attempts
      into v_id, v_status, v_attempts
      from public.intake_files as f
     where f.drive_file_id = p_drive_file_id;

    if not found then
      raise exception 'discover_intake_file: conflict for Drive file %, but no row could be read',
        p_drive_file_id using errcode = '40001';
    end if;

    return query select v_id, false, v_status, v_attempts;
    return;
  end if;

  insert into public.events (entity_type, entity_id, event, detail, actor)
  values (
    'intake_file',
    v_id,
    'intake.discovered',
    jsonb_strip_nulls(jsonb_build_object(
      'drive_file_id', p_drive_file_id,
      'filename', p_filename,
      'drive_md5', p_drive_md5,
      'bytes', p_bytes,
      'mime_type', p_mime_type,
      'source', p_source
    )),
    p_source
  );

  -- Unsupported input is a completed permanent attempt, not queue work. It is
  -- therefore failed immediately with attempts=1 and a second transition event.
  if p_mime_type is null
     or p_mime_type <> all (v_allowed)
  then
    v_reason := case
      when p_mime_type is null then
        'The file format is missing. Loupe can enhance JPEG, PNG, WebP, GIF or TIFF images. Export it in one of those formats and try again.'
      else
        format(
          'The file format is %s. Loupe can enhance JPEG, PNG, WebP, GIF or TIFF images. Export it in one of those formats and try again.',
          p_mime_type
        )
    end;
    v_code := 'unsupported_mime_type';
    v_raw_detail := jsonb_build_object(
      'mime_type', p_mime_type,
      'allowed', to_jsonb(v_allowed)
    )::text;
  elsif p_bytes is not null and p_bytes > v_max_bytes then
    v_reason := format(
      'File is %s bytes; the 50 MB limit is %s bytes.',
      p_bytes,
      v_max_bytes
    );
    v_code := 'file_too_large';
    v_raw_detail := jsonb_build_object(
      'bytes', p_bytes,
      'max_bytes', v_max_bytes
    )::text;
  end if;

  if v_reason is not null then
    update public.intake_files as f
       set status            = 'failed',
           attempts          = 1,
           last_error        = v_reason,
           last_error_code   = v_code,
           last_error_detail = v_raw_detail,
           error_class       = 'permanent',
           lease_expires_at  = null,
           next_attempt_at   = now()
     where f.id = v_id
    returning f.status, f.attempts into v_status, v_attempts;

    insert into public.events (entity_type, entity_id, event, detail, actor)
    values (
      'intake_file',
      v_id,
      'intake.rejected',
      jsonb_build_object(
        'reason', v_reason,
        'code', v_code,
        'error_class', 'permanent',
        'raw_detail', v_raw_detail,
        'attempts', v_attempts,
        'source', p_source
      ),
      p_source
    );
  end if;

  return query select v_id, true, v_status, v_attempts;
end;
$$;

comment on function public.discover_intake_file(text, text, text, bigint, text, text) is
  'Idempotently inserts a Drive file before work, writes intake.discovered, and permanently rejects unsupported MIME types or files over 50 MB (50,000,000 bytes) with attempts=1. Returns id, whether this call inserted, current status and completed attempts.';
