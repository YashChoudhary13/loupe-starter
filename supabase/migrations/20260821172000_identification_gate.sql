-- D110: every photograph is identified against the catalogue before any paid
-- stage. Drive discoveries and raw uploads now land in 'identifying' instead of
-- 'discovered'; claim_intake_file() only claims 'discovered', so the enhancement
-- worker is untouched. An operator's decision in Identify moves the row on:
--
--   new_product / skipped  -> 'discovered' (enhancement starts)
--   restock                -> 'restock'    (stock change pending in Restock)
--
-- request_identification() creates the match_events row and the worker job and
-- is idempotent; decide_identification() records the human decision exactly once.
-- Ready-image uploads (finalize_manual_image_upload) are not gated: they are
-- finished catalogue images, not photographs of stock.

create or replace function public.request_identification(
  p_intake_file_id uuid,
  p_surface        text,
  p_actor          text
)
returns uuid
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
as $$
declare
  v_file     public.intake_files%rowtype;
  v_event_id uuid;
  v_key      text;
begin
  if p_surface not in ('upload', 'drive') then
    raise exception 'request_identification: % is not an intake surface', p_surface
      using errcode = '22023';
  end if;

  select * into v_file from public.intake_files where id = p_intake_file_id for update;
  if not found then
    raise exception 'request_identification: no intake_file %', p_intake_file_id
      using errcode = '22023';
  end if;

  select e.id into v_event_id
    from public.match_events as e
   where e.intake_file_id = p_intake_file_id
     and e.status <> 'decided'
   order by e.created_at desc
   limit 1;
  if v_event_id is not null then
    return v_event_id;
  end if;

  -- The bytes the worker embeds: the browser-uploaded source (D103), else the
  -- Drive file, which the worker fetches THROUGH Loupe (never with Drive
  -- credentials of its own) — see /api/worker/source.
  v_key := coalesce(v_file.source_storage_key, 'drive:' || v_file.drive_file_id);

  insert into public.match_events (surface, intake_file_id, query_storage_key, status)
  values (p_surface, p_intake_file_id, v_key, 'queued')
  returning id into v_event_id;

  insert into public.match_jobs (kind, match_event_id)
  values ('identify', v_event_id);

  insert into public.events (entity_type, entity_id, event, detail, actor)
  values (
    'intake_file',
    p_intake_file_id,
    'match.requested',
    jsonb_build_object('match_event_id', v_event_id, 'surface', p_surface),
    p_actor
  );

  return v_event_id;
end;
$$;

comment on function public.request_identification(uuid, text, text) is
  'Creates the match_events row and identify job for a photograph waiting in Identify. Idempotent: an undecided event is returned as is (D110).';

create or replace function public.decide_identification(
  p_match_event_id uuid,
  p_decision       text,
  p_sku            text,
  p_rank           smallint,
  p_actor          text
)
returns void
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
as $$
declare
  v_event public.match_events%rowtype;
  v_sku   text := nullif(upper(btrim(coalesce(p_sku, ''))), '');
begin
  if p_actor is null or btrim(p_actor) = '' then
    raise exception 'decide_identification: p_actor is required' using errcode = '22023';
  end if;
  if p_decision not in ('new_product', 'restock', 'skipped') then
    raise exception 'decide_identification: % is not a decision for an intake photograph', p_decision
      using errcode = '22023';
  end if;
  if p_decision = 'restock' and v_sku is null then
    raise exception 'decide_identification: a restock names the SKU' using errcode = '22023';
  end if;

  select * into v_event from public.match_events where id = p_match_event_id for update;
  if not found then
    raise exception 'decide_identification: no match_event %', p_match_event_id
      using errcode = '22023';
  end if;
  if v_event.intake_file_id is null then
    raise exception 'decide_identification: event % is not an intake photograph', p_match_event_id
      using errcode = '22023';
  end if;
  if v_event.status = 'decided' then
    raise exception 'decide_identification: already decided' using errcode = '55000',
      hint = 'This photograph was already decided. Reload the page.';
  end if;

  update public.match_events
     set status      = 'decided',
         decision    = p_decision,
         chosen_sku  = case when p_decision = 'restock' then v_sku else null end,
         chosen_rank = case when p_decision = 'restock' then p_rank else null end,
         decided_at  = now(),
         decided_by  = p_actor
   where id = p_match_event_id;

  if p_decision = 'restock' then
    update public.intake_files
       set status = 'restock'
     where id = v_event.intake_file_id
       and status = 'identifying';

    insert into public.restock_decisions (intake_file_id, match_event_id, sku, created_by)
    values (v_event.intake_file_id, p_match_event_id, v_sku, p_actor)
    on conflict (intake_file_id) do nothing;
  else
    -- Back to the front of the enhancement queue, exactly as a fresh discovery.
    update public.intake_files
       set status          = 'discovered',
           next_attempt_at = now()
     where id = v_event.intake_file_id
       and status = 'identifying';
  end if;

  insert into public.events (entity_type, entity_id, event, detail, actor)
  values (
    'intake_file',
    v_event.intake_file_id,
    'match.decided',
    jsonb_strip_nulls(jsonb_build_object(
      'match_event_id', p_match_event_id,
      'decision', p_decision,
      'sku', v_sku,
      'rank', p_rank
    )),
    p_actor
  );
end;
$$;

comment on function public.decide_identification(uuid, text, text, smallint, text) is
  'Records an operator''s decision on a waiting photograph exactly once: new_product or skipped send it to enhancement; restock parks it in the Restock section (D110).';

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
    'identifying',
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

  -- D110: an accepted photograph waits in Identify before any paid stage.
  if v_reason is null then
    perform public.request_identification(v_id, 'drive', p_source);
  end if;

  return query select v_id, true, v_status, v_attempts;
end;
$$;


create or replace function public.finalize_raw_image_upload(
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
    'identifying',
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

  -- D110: the upload waits in Identify before any paid stage.
  perform public.request_identification(v_intake_id, 'upload', p_actor);

  return v_intake_id;
end;
$$;


comment on function public.discover_intake_file(text, text, text, bigint, text, text) is
  'Idempotently inserts a Drive file before work, writes intake.discovered, permanently rejects unsupported MIME types or files over 50 MB (50,000,000 bytes) with attempts=1, and parks an accepted file in identifying (D110). Returns id, whether this call inserted, current status and completed attempts.';

comment on function public.finalize_raw_image_upload(uuid, text, integer, integer, text, text, text) is
  'Turns a verified browser upload into a photograph waiting in Identify, with an optional per-photograph prompt binding (D103, D110).';

revoke execute on function public.request_identification(uuid, text, text) from public, anon, authenticated;
grant  execute on function public.request_identification(uuid, text, text) to service_role;
revoke execute on function public.decide_identification(uuid, text, text, smallint, text) from public, anon, authenticated;
grant  execute on function public.decide_identification(uuid, text, text, smallint, text) to service_role;
revoke execute on function public.finalize_raw_image_upload(uuid, text, integer, integer, text, text, text) from public, anon, authenticated;
grant  execute on function public.finalize_raw_image_upload(uuid, text, integer, integer, text, text, text) to service_role;
