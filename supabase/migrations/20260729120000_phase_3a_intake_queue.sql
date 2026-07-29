-- Loupe · Phase 3A — Drive intake queue, bounded retries and sync leases
--
-- The database owns the queue state machine. That keeps discovery idempotent,
-- claiming non-blocking under concurrency, retry timing consistent across every
-- worker, and cursor advancement protected from stale Drive pollers.

-- pg_cron is intentionally installed in pg_catalog, which is the supported
-- Supabase layout. pg_net creates and owns its net schema. Do not hide
-- extension failures: Phase 3
-- cannot schedule or invoke workers without these capabilities.
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net;

-- Supabase's documented pg_cron install grants. The extension keeps its
-- schedule tables and functions in the cron schema even though extnamespace is
-- pg_catalog.
grant usage on schema cron to postgres;
grant all privileges on all tables in schema cron to postgres;

-- ---------------------------------------------------------------------------
-- Intake queue metadata
-- ---------------------------------------------------------------------------

alter table public.intake_files
  add column mime_type text,
  add column next_attempt_at timestamptz not null default now(),
  add column last_error_detail text;

comment on column public.intake_files.mime_type is
  'Drive MIME type captured at discovery. Only image/jpeg, image/png and image/webp enter the enhancement queue.';
comment on column public.intake_files.next_attempt_at is
  'Earliest time a discovered row may be claimed. Initial discovery is due immediately; retry delays are 1m, 5m, 20m and 1h.';
comment on column public.intake_files.last_error_detail is
  'Raw provider or validation detail retained separately from the readable operator-facing last_error.';

-- The worker query filters to discovered rows and consumes the oldest due item.
-- Partial indexing keeps terminal and in-progress rows out of the hot queue index.
create index intake_files_ready_queue_idx
  on public.intake_files (next_attempt_at, discovered_at, id)
  where status = 'discovered';

comment on index public.intake_files_ready_queue_idx is
  'Ready queue for claim_intake_file(): due discovered rows ordered deterministically without scanning completed history.';

-- ---------------------------------------------------------------------------
-- Durable Drive cursor state
-- ---------------------------------------------------------------------------

create table public.sync_state (
  key              text        primary key
                              check (length(btrim(key)) > 0),
  value            text,
  lease_token      uuid,
  lease_expires_at timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  constraint sync_state_lease_pair check (
    (lease_token is null) = (lease_expires_at is null)
  )
);

comment on table public.sync_state is
  'Server-only durable synchronization cursors. A UUID lease makes cursor advancement compare-and-swap: an expired poller cannot overwrite a newer poller''s value.';
comment on column public.sync_state.key is
  'Stable synchronization stream identifier, for example a Drive change-log corpus.';
comment on column public.sync_state.value is
  'Opaque cursor value. NULL means the stream has not completed its initial synchronization.';
comment on column public.sync_state.lease_token is
  'Random claim token. Completion and release must present the current token; stale tokens change nothing.';
comment on column public.sync_state.lease_expires_at is
  'Lease deadline. Completion after this instant is refused even if no replacement poller has claimed yet.';

create trigger sync_state_set_updated_at
  before update on public.sync_state
  for each row execute function public.set_updated_at();

-- Same browser boundary as every other Loupe table: RLS on, zero policies, and
-- explicit table grants only for the server-side service role.
alter table public.sync_state enable row level security;
revoke all on table public.sync_state from public, anon, authenticated;
grant select, insert, update, delete on table public.sync_state to service_role;

-- ---------------------------------------------------------------------------
-- 1. discover_intake_file — insert first, validate second, always idempotent
-- ---------------------------------------------------------------------------

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
  v_max_bytes    constant bigint := 50 * 1024 * 1024;
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
     or p_mime_type <> all (array['image/jpeg', 'image/png', 'image/webp']::text[])
  then
    v_reason := case
      when p_mime_type is null then
        'The file format is missing. Loupe can enhance JPEG, PNG or WebP images. Export it in one of those formats and try again.'
      else
        format(
          'The file format is %s. Loupe can enhance JPEG, PNG or WebP images. Export it in one of those formats and try again.',
          p_mime_type
        )
    end;
    v_code := 'unsupported_mime_type';
    v_raw_detail := jsonb_build_object(
      'mime_type', p_mime_type,
      'allowed', jsonb_build_array('image/jpeg', 'image/png', 'image/webp')
    )::text;
  elsif p_bytes is not null and p_bytes > v_max_bytes then
    v_reason := format(
      'File is %s bytes; the 50 MiB limit is %s bytes.',
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
  'Idempotently inserts a Drive file before work, writes intake.discovered, and permanently rejects unsupported MIME types or files over 50 MiB with attempts=1. Returns id, whether this call inserted, current status and completed attempts.';

-- ---------------------------------------------------------------------------
-- 2. claim_intake_file — one non-blocking, due queue item
-- ---------------------------------------------------------------------------

create or replace function public.claim_intake_file(
  p_lease_seconds integer default 900
)
returns table (
  id               uuid,
  drive_file_id    text,
  filename         text,
  drive_md5        text,
  bytes            bigint,
  mime_type        text,
  status           public.intake_status,
  attempts         integer,
  lease_expires_at timestamptz
)
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
as $$
declare
  v_file public.intake_files%rowtype;
begin
  if p_lease_seconds is null or p_lease_seconds <= 0 then
    raise exception 'claim_intake_file: p_lease_seconds must be positive, got %',
      coalesce(p_lease_seconds::text, '<null>') using errcode = '22023';
  end if;

  -- Multiple workers never wait on the same queue row. A claim changes only the
  -- lease/status; attempts counts completed work and increments only on failure.
  with candidate as (
    select f.id
      from public.intake_files as f
     where f.status = 'discovered'
       and f.next_attempt_at <= now()
     order by f.next_attempt_at, f.discovered_at, f.id
     limit 1
       for update skip locked
  )
  update public.intake_files as f
     set status           = 'enhancing',
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
      'lease_expires_at', v_file.lease_expires_at
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
    v_file.lease_expires_at;
end;
$$;

comment on function public.claim_intake_file(integer) is
  'Claims at most one due discovered intake row using FOR UPDATE SKIP LOCKED. Sets a lease and status=enhancing but deliberately does not increment attempts, because attempts counts completed work and an expired lease must return to discovered unchanged.';

-- ---------------------------------------------------------------------------
-- 3. record_intake_failure — bounded retry transition
-- ---------------------------------------------------------------------------

create or replace function public.record_intake_failure(
  p_intake_file_id uuid,
  p_error          text,
  p_error_code     text,
  p_error_class    public.error_class,
  p_error_detail   text default null,
  p_source         text default null
)
returns table (
  id              uuid,
  status          public.intake_status,
  attempts        integer,
  next_attempt_at timestamptz
)
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
as $$
declare
  v_file         public.intake_files%rowtype;
  v_attempts     integer;
  v_status       public.intake_status;
  v_next_attempt timestamptz;
  v_error        text;
  v_event        text;
begin
  if p_error_class is null then
    raise exception 'record_intake_failure: p_error_class must be retryable or permanent'
      using errcode = '22023';
  end if;

  select f.*
    into v_file
   from public.intake_files as f
   where f.id = p_intake_file_id
     for update;

  if not found then
    raise exception 'record_intake_failure: no intake_file %',
      coalesce(p_intake_file_id::text, '<null>') using errcode = '22023';
  end if;

  if v_file.status <> 'enhancing' then
    raise exception 'record_intake_failure: intake_file % is %, expected enhancing',
      p_intake_file_id, v_file.status
      using errcode = '55000',
            hint = 'Only the worker holding an active intake claim may record its completed attempt.';
  end if;

  v_attempts := v_file.attempts + 1;
  v_error := left(coalesce(nullif(btrim(p_error), ''), 'Unknown intake failure'), 4000);

  if p_error_class = 'permanent' or v_attempts >= 5 then
    v_status := 'failed';
    v_next_attempt := now();
    v_event := 'intake.failed';
  else
    v_status := 'discovered';
    v_next_attempt := now() + case v_attempts
      when 1 then interval '1 minute'
      when 2 then interval '5 minutes'
      when 3 then interval '20 minutes'
      when 4 then interval '1 hour'
    end;
    v_event := 'intake.retry_scheduled';
  end if;

  update public.intake_files as f
     set status            = v_status,
         attempts          = v_attempts,
         last_error        = v_error,
         last_error_code   = p_error_code,
         last_error_detail = p_error_detail,
         error_class       = p_error_class,
         lease_expires_at  = null,
         next_attempt_at   = v_next_attempt
   where f.id = p_intake_file_id;

  insert into public.events (entity_type, entity_id, event, detail, actor)
  values (
    'intake_file',
    p_intake_file_id,
    v_event,
    jsonb_strip_nulls(jsonb_build_object(
      'error', v_error,
      'code', p_error_code,
      'error_class', p_error_class,
      'raw_detail', p_error_detail,
      'attempts', v_attempts,
      'next_attempt_at', case when v_status = 'discovered' then v_next_attempt else null end,
      'retry_budget_exhausted', p_error_class = 'retryable' and v_attempts >= 5,
      'source', p_source
    )),
    p_source
  );

  return query
  select p_intake_file_id, v_status, v_attempts, v_next_attempt;
end;
$$;

comment on function public.record_intake_failure(uuid, text, text, public.error_class, text, text) is
  'Atomically records one completed attempt and its event. Permanent errors fail immediately. Retryable attempts 1–4 return to discovered after 1m, 5m, 20m and 1h; attempt 5 is terminal.';

-- ---------------------------------------------------------------------------
-- 4. sweep_expired_intake_leases — crash recovery
-- ---------------------------------------------------------------------------

create or replace function public.sweep_expired_intake_leases(
  p_source text default 'lease-sweeper'
)
returns integer
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
as $$
declare
  v_count integer;
begin
  -- The updated rows and their events are one statement and one transaction.
  -- SKIP LOCKED lets two sweepers divide work without duplicate events.
  with expired as (
    select f.id, f.lease_expires_at
      from public.intake_files as f
     where f.status = 'enhancing'
       and f.lease_expires_at <= now()
       for update skip locked
  ),
  swept as (
    update public.intake_files as f
       set status            = 'discovered',
           lease_expires_at  = null,
           next_attempt_at   = now()
      from expired as e
     where f.id = e.id
    returning f.id, f.attempts, e.lease_expires_at as expired_at
  ),
  logged as (
    insert into public.events (entity_type, entity_id, event, detail, actor)
    select
      'intake_file',
      s.id,
      'intake.lease_expired',
      jsonb_build_object(
        'attempts_completed', s.attempts,
        'expired_at', s.expired_at,
        'rediscovered_at', now(),
        'source', p_source
      ),
      p_source
      from swept as s
    returning 1
  )
  select count(*)::integer into v_count from logged;

  return v_count;
end;
$$;

comment on function public.sweep_expired_intake_leases(text) is
  'Returns every expired enhancing lease to discovered, clears the lease, makes it due now, preserves completed attempts, and writes exactly one intake.lease_expired event per row. Returns the recovered row count.';

-- ---------------------------------------------------------------------------
-- 5–7. Sync cursor lease compare-and-swap
-- ---------------------------------------------------------------------------

create or replace function public.claim_sync_state(
  p_key           text,
  p_lease_seconds integer default 300
)
returns table (
  key              text,
  value            text,
  lease_token      uuid,
  lease_expires_at timestamptz
)
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
as $$
declare
  v_token uuid := gen_random_uuid();
  v_row public.sync_state%rowtype;
begin
  if p_key is null or btrim(p_key) = '' then
    raise exception 'claim_sync_state: p_key must not be empty'
      using errcode = '22023';
  end if;

  if p_lease_seconds is null or p_lease_seconds <= 0 then
    raise exception 'claim_sync_state: p_lease_seconds must be positive, got %',
      coalesce(p_lease_seconds::text, '<null>') using errcode = '22023';
  end if;

  -- NULL value deliberately represents an unbootstrapped stream. ON CONFLICT
  -- plus the row lock makes first claim safe under concurrent startup.
  insert into public.sync_state (key, value)
  values (p_key, null)
  on conflict on constraint sync_state_pkey do nothing;

  with claimable as (
    select s.key
      from public.sync_state as s
     where s.key = p_key
       and (s.lease_token is null or s.lease_expires_at <= now())
       for update skip locked
  )
  update public.sync_state as s
     set lease_token      = v_token,
         lease_expires_at = now() + make_interval(secs => p_lease_seconds)
    from claimable as c
   where s.key = c.key
  returning s.* into v_row;

  if not found then
    return;
  end if;

  return query
  select v_row.key, v_row.value, v_row.lease_token, v_row.lease_expires_at;
end;
$$;

comment on function public.claim_sync_state(text, integer) is
  'Creates a missing NULL cursor, then leases it only when unleased or expired. Returns zero rows when another poller holds the lease; otherwise returns key, value, UUID token and deadline.';

create or replace function public.complete_sync_state(
  p_key         text,
  p_lease_token uuid,
  p_value       text
)
returns boolean
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
as $$
declare
  v_completed boolean;
begin
  if p_value is null or btrim(p_value) = '' then
    raise exception 'complete_sync_state: p_value must not be empty'
      using errcode = '22023';
  end if;

  update public.sync_state as s
     set value            = p_value,
         lease_token      = null,
         lease_expires_at = null
   where s.key = p_key
     and s.lease_token = p_lease_token
     and s.lease_expires_at > now();

  v_completed := found;
  return v_completed;
end;
$$;

comment on function public.complete_sync_state(text, uuid, text) is
  'Compare-and-swap cursor completion. Only the current, unexpired UUID lease may replace value and clear the lease; false means the caller is stale and changed nothing.';

create or replace function public.release_sync_state(
  p_key         text,
  p_lease_token uuid
)
returns boolean
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
as $$
declare
  v_released boolean;
begin
  update public.sync_state as s
     set lease_token      = null,
         lease_expires_at = null
   where s.key = p_key
     and s.lease_token = p_lease_token;

  v_released := found;
  return v_released;
end;
$$;

comment on function public.release_sync_state(text, uuid) is
  'Releases a sync lease only when its UUID token still matches. A stale worker cannot release a replacement worker''s lease.';

-- ---------------------------------------------------------------------------
-- Machine-readable schema/security report additions
-- ---------------------------------------------------------------------------

create or replace function public._loupe_schema_report()
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog, pg_temp
as $$
  select jsonb_build_object(
    'tables', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'name', c.relname,
               'rls_enabled', c.relrowsecurity,
               'policy_count', (select count(*) from pg_policy p where p.polrelid = c.oid)
             ) order by c.relname), '[]'::jsonb)
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r'
    ),
    'indexes', (
      select coalesce(jsonb_agg(c.relname order by c.relname), '[]'::jsonb)
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
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
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
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
    ),
    'extensions', (
      select coalesce(jsonb_object_agg(e.extname, n.nspname), '{}'::jsonb)
        from pg_extension e
        join pg_namespace n on n.oid = e.extnamespace
    ),
    'function_execute', (
      select coalesce(jsonb_object_agg(
               p.oid::regprocedure::text,
               jsonb_build_object(
                 'anon', has_function_privilege('anon', p.oid, 'execute'),
                 'authenticated', has_function_privilege('authenticated', p.oid, 'execute'),
                 'service_role', has_function_privilege('service_role', p.oid, 'execute')
               )
             ), '{}'::jsonb)
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
    )
  );
$$;

comment on function public._loupe_schema_report() is
  'Test-support introspection: public tables/RLS, indexes, enums, functions, columns, installed extension schemas, and effective function EXECUTE privileges.';

-- Every Phase 3 queue/cursor function is a server-only RPC. PostgreSQL grants
-- EXECUTE to PUBLIC on new functions unless explicitly revoked.
revoke all on function public.discover_intake_file(text, text, text, bigint, text, text)
  from public, anon, authenticated;
revoke all on function public.claim_intake_file(integer)
  from public, anon, authenticated;
revoke all on function public.record_intake_failure(uuid, text, text, public.error_class, text, text)
  from public, anon, authenticated;
revoke all on function public.sweep_expired_intake_leases(text)
  from public, anon, authenticated;
revoke all on function public.claim_sync_state(text, integer)
  from public, anon, authenticated;
revoke all on function public.complete_sync_state(text, uuid, text)
  from public, anon, authenticated;
revoke all on function public.release_sync_state(text, uuid)
  from public, anon, authenticated;

grant execute on function public.discover_intake_file(text, text, text, bigint, text, text)
  to service_role;
grant execute on function public.claim_intake_file(integer)
  to service_role;
grant execute on function public.record_intake_failure(uuid, text, text, public.error_class, text, text)
  to service_role;
grant execute on function public.sweep_expired_intake_leases(text)
  to service_role;
grant execute on function public.claim_sync_state(text, integer)
  to service_role;
grant execute on function public.complete_sync_state(text, uuid, text)
  to service_role;
grant execute on function public.release_sync_state(text, uuid)
  to service_role;

-- Replacing _loupe_schema_report() preserves its ACL on current PostgreSQL, but
-- repeat the boundary explicitly so this migration remains self-documenting.
revoke all on function public._loupe_schema_report() from public, anon, authenticated;
grant execute on function public._loupe_schema_report() to service_role;
