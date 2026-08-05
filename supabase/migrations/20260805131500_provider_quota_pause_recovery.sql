-- Provider credit exhaustion is an account condition, not a bad photograph.
-- Keep it out of the retry budget, make it visible on the affected row, and
-- require an operator to resume once credits have been restored. This prevents
-- the minute cron from repeatedly leasing the same work and showing a false
-- "Enhancing" state while every provider request is guaranteed to be refused.

alter table public.intake_files
  add column provider_paused_at timestamptz,
  add column provider_pause_code text,
  add column provider_pause_message text,
  add column provider_pause_detail text;

alter table public.intake_files
  add constraint intake_files_provider_pause_complete_chk check (
    (provider_paused_at is null
      and provider_pause_code is null
      and provider_pause_message is null
      and provider_pause_detail is null)
    or
    (provider_paused_at is not null
      and length(btrim(provider_pause_code)) > 0
      and length(btrim(provider_pause_message)) > 0)
  );

comment on column public.intake_files.provider_paused_at is
  'Set when a provider refuses work for account credit/quota reasons. Paused rows remain discovered but cannot be claimed until an operator resumes them.';
comment on column public.intake_files.provider_pause_code is
  'Stable machine-readable provider quota code shown by Tracking.';
comment on column public.intake_files.provider_pause_message is
  'Operator-safe explanation of the provider quota pause.';
comment on column public.intake_files.provider_pause_detail is
  'Redacted provider detail for the Tracking Details panel; never contains credentials.';

create index intake_files_provider_paused_idx
  on public.intake_files (provider_paused_at desc)
  where provider_paused_at is not null;

-- Same return contract as D29/D31. Only the candidate predicate changes:
-- quota-paused rows are not silently reclaimed every minute.
create or replace function public.claim_intake_file(
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
  description_missing_at        timestamptz
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
      'presentation_fallback_reason', v_file.presentation_fallback_reason
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
    v_file.description_missing_at;
end;
$$;

comment on function public.claim_intake_file(integer) is
  'Claims one due, unpaused intake row with SKIP LOCKED and UUID ownership. Provider-quota-paused rows require an explicit operator resume.';

create or replace function public.pause_intake_for_provider_quota(
  p_intake_file_id uuid,
  p_lease_token uuid,
  p_error text,
  p_error_code text,
  p_error_detail text default null,
  p_stage text default 'image',
  p_source text default 'enhancement-worker'
)
returns table (
  status public.intake_status,
  attempts integer,
  provider_paused_at timestamptz
)
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
as $$
declare
  v_file public.intake_files%rowtype;
  v_message text;
  v_code text;
  v_paused_at timestamptz := now();
begin
  if p_lease_token is null then
    raise exception 'pause_intake_for_provider_quota: p_lease_token is required'
      using errcode = '22023';
  end if;

  v_message := left(
    coalesce(nullif(btrim(p_error), ''), 'The image provider account needs more credits.'),
    4000
  );
  v_code := left(
    coalesce(nullif(btrim(p_error_code), ''), 'provider_quota_exhausted'),
    200
  );

  select f.* into v_file
    from public.intake_files as f
   where f.id = p_intake_file_id
     and f.status = 'enhancing'
     and f.lease_token = p_lease_token
     and f.lease_expires_at > now()
   for update;

  if not found then
    raise exception 'pause_intake_for_provider_quota: lease for intake_file % is no longer current',
      coalesce(p_intake_file_id::text, '<null>')
      using errcode = '55000',
            hint = 'Discard this stale worker result; another worker may now own the row.';
  end if;

  update public.intake_files as f
     set status                  = 'discovered',
         lease_token             = null,
         lease_expires_at        = null,
         next_attempt_at         = v_paused_at,
         provider_paused_at      = v_paused_at,
         provider_pause_code     = v_code,
         provider_pause_message  = v_message,
         provider_pause_detail   = p_error_detail
   where f.id = p_intake_file_id
     and f.lease_token = p_lease_token;

  if not found then
    raise exception 'pause_intake_for_provider_quota: lease for intake_file % changed during pause',
      p_intake_file_id using errcode = '40001';
  end if;

  insert into public.events (entity_type, entity_id, event, detail, actor)
  values (
    'intake_file',
    p_intake_file_id,
    'intake.paused_provider_quota',
    jsonb_strip_nulls(jsonb_build_object(
      'code', v_code,
      'message', v_message,
      'raw_detail', p_error_detail,
      'stage', nullif(btrim(p_stage), ''),
      'attempts_unchanged', v_file.attempts,
      'source', p_source
    )),
    p_source
  );

  return query
  select 'discovered'::public.intake_status, v_file.attempts, v_paused_at;
end;
$$;

comment on function public.pause_intake_for_provider_quota(uuid, uuid, text, text, text, text, text) is
  'Fenced provider-quota pause. Releases the lease immediately, preserves the retry budget, records the cause on the photograph, and prevents automatic reclaim until an operator resumes.';

create or replace function public.resume_provider_paused_intake_file(
  p_intake_file_id uuid,
  p_actor text
)
returns public.intake_status
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
as $$
declare
  v_file public.intake_files%rowtype;
begin
  if p_actor is null or btrim(p_actor) = '' then
    raise exception 'resume_provider_paused_intake_file: p_actor is required'
      using errcode = '22023';
  end if;

  select f.* into v_file
    from public.intake_files as f
   where f.id = p_intake_file_id
   for update;

  if not found then
    raise exception 'resume_provider_paused_intake_file: no intake_file %', p_intake_file_id
      using errcode = 'P0002';
  end if;
  if v_file.provider_paused_at is null then
    raise exception 'resume_provider_paused_intake_file: photograph is not paused for provider credits'
      using errcode = '55000',
            hint = 'Reload Tracking; the photograph may already have resumed.';
  end if;
  if v_file.product_draft_id is not null
     or v_file.status in ('enhanced', 'grouped', 'published', 'duplicate', 'skipped', 'failed')
  then
    raise exception 'resume_provider_paused_intake_file: photograph cannot resume from status %',
      v_file.status using errcode = '55000';
  end if;

  update public.intake_files
     set status                 = 'discovered',
         lease_token            = null,
         lease_expires_at       = null,
         next_attempt_at        = now(),
         provider_paused_at     = null,
         provider_pause_code    = null,
         provider_pause_message = null,
         provider_pause_detail  = null
   where id = p_intake_file_id;

  insert into public.events (entity_type, entity_id, event, detail, actor)
  values (
    'intake_file',
    p_intake_file_id,
    'intake.provider_quota_resumed',
    jsonb_build_object(
      'previous_error_code', v_file.provider_pause_code,
      'paused_at', v_file.provider_paused_at,
      'attempts_unchanged', v_file.attempts
    ),
    btrim(p_actor)
  );

  return 'discovered'::public.intake_status;
end;
$$;

comment on function public.resume_provider_paused_intake_file(uuid, text) is
  'Operator recovery for a provider-credit pause. Clears only the pause marker, preserves completed attempts and cached description state, and makes the photograph due immediately.';
