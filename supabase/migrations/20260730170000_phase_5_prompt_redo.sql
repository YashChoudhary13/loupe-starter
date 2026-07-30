-- Loupe · Phase 5 — append-only prompt management and crash-safe image redo
--
-- Prompt bodies are immutable versions. A promotion changes only which version
-- is current. Image redo is a separate durable queue: it reuses the cached
-- description/presentation, reserves the next version number before the paid
-- call, and stores the result at a deterministic R2 key.

create function public.validate_prompt_body(
  p_kind public.prompt_kind,
  p_body text
)
returns void
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_description_token constant text := '{{PRODUCT_DESCRIPTION}}';
  v_composition_token constant text := '{{COMPOSITION_DETAIL}}';
  v_product_block constant text := E'PRODUCT\n{{PRODUCT_DESCRIPTION}}\n\n';
  v_description_count integer;
  v_composition_count integer;
begin
  if nullif(btrim(coalesce(p_body, '')), '') is null then
    raise exception 'validate_prompt_body: body is required'
      using errcode = '22023';
  end if;

  if p_kind <> 'image' then
    return;
  end if;

  v_description_count :=
    (length(p_body) - length(replace(p_body, v_description_token, '')))
    / length(v_description_token);
  v_composition_count :=
    (length(p_body) - length(replace(p_body, v_composition_token, '')))
    / length(v_composition_token);

  if v_description_count <> 1 or position(v_product_block in p_body) = 0 then
    raise exception 'validate_prompt_body: image prompt needs exactly one exact PRODUCT block'
      using errcode = '22023',
            hint = E'Include exactly: PRODUCT\\n{{PRODUCT_DESCRIPTION}} followed by one blank line.';
  end if;
  if v_composition_count <> 1 then
    raise exception 'validate_prompt_body: image prompt needs exactly one {{COMPOSITION_DETAIL}} token'
      using errcode = '22023',
            hint = 'Add or remove the composition token so it appears once.';
  end if;
end;
$$;

comment on function public.validate_prompt_body(public.prompt_kind, text) is
  'Shared activation guard. Image prompts require exactly one PRODUCT block and one composition token before they can be saved or promoted.';

create function public.create_prompt_version(
  p_kind public.prompt_kind,
  p_name text,
  p_body text,
  p_model text,
  p_actor text
)
returns uuid
language plpgsql
volatile
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  if nullif(btrim(coalesce(p_actor, '')), '') is null then
    raise exception 'create_prompt_version: actor is required'
      using errcode = '22023';
  end if;
  if nullif(btrim(coalesce(p_name, '')), '') is null then
    raise exception 'create_prompt_version: name is required'
      using errcode = '22023';
  end if;
  if length(btrim(p_name)) > 160 then
    raise exception 'create_prompt_version: name is longer than 160 characters'
      using errcode = '22023';
  end if;
  if length(p_body) > 20000 then
    raise exception 'create_prompt_version: body is longer than 20000 characters'
      using errcode = '22023';
  end if;

  perform public.validate_prompt_body(p_kind, p_body);

  insert into public.prompts (
    name,
    body,
    kind,
    model,
    is_default,
    created_by
  )
  values (
    btrim(p_name),
    p_body,
    p_kind,
    btrim(p_model),
    false,
    btrim(p_actor)
  )
  returning id into v_id;

  insert into public.events (entity_type, entity_id, event, detail, actor)
  values (
    'prompt',
    v_id,
    'prompt.version_created',
    jsonb_build_object(
      'kind', p_kind,
      'model', btrim(p_model),
      'made_current', false
    ),
    btrim(p_actor)
  );

  return v_id;
end;
$$;

comment on function public.create_prompt_version(public.prompt_kind, text, text, text, text) is
  'Creates a non-current immutable prompt version. The live default is untouched.';

create function public.promote_prompt_version(
  p_prompt_id uuid,
  p_actor text
)
returns uuid
language plpgsql
volatile
set search_path = public, pg_temp
as $$
declare
  v_target public.prompts%rowtype;
  v_current public.prompts%rowtype;
  v_promoted_id uuid;
begin
  if nullif(btrim(coalesce(p_actor, '')), '') is null then
    raise exception 'promote_prompt_version: actor is required'
      using errcode = '22023';
  end if;

  select *
    into v_target
    from public.prompts
   where id = p_prompt_id
   for update;

  if not found then
    raise exception 'promote_prompt_version: prompt % does not exist', p_prompt_id
      using errcode = '22023';
  end if;

  perform public.validate_prompt_body(v_target.kind, v_target.body);

  select *
    into v_current
    from public.prompts
   where kind = v_target.kind
     and is_default
     and archived_at is null
   for update;

  if not found then
    raise exception 'promote_prompt_version: no live % prompt', v_target.kind
      using errcode = '55000';
  end if;

  if v_current.id = v_target.id then
    return v_current.id;
  end if;

  if exists (
    select 1
      from public.intake_files
     where status = 'enhancing'
       and lease_expires_at > now()
  ) or exists (
    select 1
      from public.image_redo_jobs
     where status = 'processing'
       and lease_expires_at > now()
  ) then
    raise exception 'promote_prompt_version: enhancement work is currently in flight'
      using errcode = '55000',
            hint = 'Wait for the current enhancement or redo to finish, then promote again.';
  end if;

  update public.prompts
     set is_default = false,
         archived_at = now()
   where id = v_current.id;

  if v_target.archived_at is null then
    update public.prompts
       set is_default = true
     where id = v_target.id
    returning id into v_promoted_id;
  else
    -- Reactivating archived history creates a fresh current version rather than
    -- rewriting when that historical row was archived.
    insert into public.prompts (name, body, kind, model, is_default, created_by)
    values (
      v_target.name,
      v_target.body,
      v_target.kind,
      v_target.model,
      true,
      btrim(p_actor)
    )
    returning id into v_promoted_id;
  end if;

  insert into public.events (entity_type, entity_id, event, detail, actor)
  values (
    'prompt',
    v_promoted_id,
    'prompt.promoted',
    jsonb_build_object(
      'kind', v_target.kind,
      'source_prompt_id', v_target.id,
      'previous_prompt_id', v_current.id,
      'model', v_target.model
    ),
    btrim(p_actor)
  );

  return v_promoted_id;
end;
$$;

comment on function public.promote_prompt_version(uuid, text) is
  'Atomically promotes one validated version and leaves exactly one live default for its kind. Archived history is copied, never rewritten.';

-- ---------------------------------------------------------------------------
-- Durable redo queue

create type public.image_redo_status as enum (
  'queued',
  'processing',
  'completed',
  'failed'
);

create table public.image_redo_jobs (
  id                    uuid                     primary key default gen_random_uuid(),
  intake_file_id        uuid                     not null references public.intake_files (id) on delete cascade,
  source_version_id     uuid                     not null references public.image_versions (id) on delete restrict,
  version_no            integer                  not null check (version_no >= 2),
  prompt_id             uuid                     not null references public.prompts (id) on delete restrict,
  prompt_text           text                     not null check (length(btrim(prompt_text)) > 0),
  model                 text                     not null check (length(btrim(model)) > 0),
  description_injected  boolean                  not null,
  description_missing   boolean                  not null,
  status                public.image_redo_status not null default 'queued',
  attempts              integer                  not null default 0 check (attempts between 0 and 5),
  next_attempt_at       timestamptz              not null default now(),
  lease_token           uuid,
  lease_expires_at      timestamptz,
  generation_started_at timestamptz,
  image_version_id      uuid                     references public.image_versions (id) on delete restrict,
  cost_usd              numeric(12, 6)           check (cost_usd is null or cost_usd >= 0),
  last_error            text,
  last_error_code       text,
  created_by            text                     not null check (length(btrim(created_by)) > 0),
  created_at            timestamptz              not null default now(),
  updated_at            timestamptz              not null default now(),
  completed_at          timestamptz,

  unique (intake_file_id, version_no),
  constraint image_redo_description_flags check (
    not (description_injected and description_missing)
  ),
  constraint image_redo_lease_pair check (
    (lease_token is null) = (lease_expires_at is null)
  ),
  constraint image_redo_processing_owns_lease check (
    (status = 'processing') = (lease_token is not null)
  ),
  constraint image_redo_completion_is_complete check (
    (status = 'completed') = (
      image_version_id is not null
      and cost_usd is not null
      and completed_at is not null
    )
  )
);

create unique index image_redo_one_active_per_intake
  on public.image_redo_jobs (intake_file_id)
  where status in ('queued', 'processing');

create index image_redo_claim_idx
  on public.image_redo_jobs (next_attempt_at, created_at)
  where status in ('queued', 'processing');

create trigger image_redo_jobs_set_updated_at
  before update on public.image_redo_jobs
  for each row execute function public.set_updated_at();

comment on table public.image_redo_jobs is
  'Durable image-only redo queue. The resolved prompt/model and reserved version number are fixed before the paid call; retries recover the deterministic R2 object.';
comment on column public.image_redo_jobs.generation_started_at is
  'Set immediately before dispatching the paid request. If a lease expires with no durable R2 result, Loupe refuses an automatic second paid call because the first outcome is unknown.';

create function public.enqueue_image_redo(
  p_intake_file_id uuid,
  p_prompt_id uuid,
  p_prompt_text text,
  p_description_injected boolean,
  p_description_missing boolean,
  p_actor text
)
returns uuid
language plpgsql
volatile
set search_path = public, pg_temp
as $$
declare
  v_file public.intake_files%rowtype;
  v_prompt public.prompts%rowtype;
  v_source public.image_versions%rowtype;
  v_existing_id uuid;
  v_version_no integer;
  v_id uuid;
begin
  if nullif(btrim(coalesce(p_actor, '')), '') is null then
    raise exception 'enqueue_image_redo: actor is required'
      using errcode = '22023';
  end if;
  if nullif(btrim(coalesce(p_prompt_text, '')), '') is null then
    raise exception 'enqueue_image_redo: resolved prompt is required'
      using errcode = '22023';
  end if;
  if p_description_injected is null or p_description_missing is null
     or (p_description_injected and p_description_missing)
  then
    raise exception 'enqueue_image_redo: invalid description flags'
      using errcode = '22023';
  end if;

  select *
    into v_file
    from public.intake_files
   where id = p_intake_file_id
   for update;

  if not found or v_file.status not in ('enhanced', 'grouped') then
    raise exception 'enqueue_image_redo: intake file is not available for redo'
      using errcode = '55000',
            hint = 'Redo is available after enhancement and before publishing.';
  end if;
  if v_file.presentation_class is null then
    raise exception 'enqueue_image_redo: intake file has no cached presentation class'
      using errcode = '55000';
  end if;
  if v_file.product_description is null and v_file.description_missing_at is null then
    raise exception 'enqueue_image_redo: intake file has no settled description state'
      using errcode = '55000';
  end if;

  select id
    into v_existing_id
    from public.image_redo_jobs
   where intake_file_id = p_intake_file_id
     and status in ('queued', 'processing')
   order by created_at desc
   limit 1;

  if found then
    return v_existing_id;
  end if;

  select *
    into v_prompt
    from public.prompts
   where id = p_prompt_id
     and kind = 'image'
     and is_default
     and archived_at is null
   for share;

  if not found then
    raise exception 'enqueue_image_redo: image prompt is no longer current'
      using errcode = '55000',
            hint = 'Reload and start the redo again with the current prompt.';
  end if;
  perform public.validate_prompt_body(v_prompt.kind, v_prompt.body);

  select *
    into v_source
    from public.image_versions
   where intake_file_id = p_intake_file_id
     and version_no = 0
     and kind = 'original';

  if not found then
    raise exception 'enqueue_image_redo: immutable original version is missing'
      using errcode = '55000';
  end if;

  select coalesce(max(reserved.version_no), 1) + 1
    into v_version_no
    from (
      select version_no
        from public.image_versions
       where intake_file_id = p_intake_file_id
      union all
      select version_no
        from public.image_redo_jobs
       where intake_file_id = p_intake_file_id
    ) reserved;

  insert into public.image_redo_jobs (
    intake_file_id,
    source_version_id,
    version_no,
    prompt_id,
    prompt_text,
    model,
    description_injected,
    description_missing,
    created_by
  )
  values (
    p_intake_file_id,
    v_source.id,
    v_version_no,
    v_prompt.id,
    p_prompt_text,
    v_prompt.model,
    p_description_injected,
    p_description_missing,
    btrim(p_actor)
  )
  returning id into v_id;

  insert into public.events (entity_type, entity_id, event, detail, actor)
  values (
    'image_redo',
    v_id,
    'image.redo_queued',
    jsonb_build_object(
      'intake_file_id', p_intake_file_id,
      'source_version_id', v_source.id,
      'version_no', v_version_no,
      'prompt_id', v_prompt.id,
      'model', v_prompt.model,
      'description_reused', v_file.product_description is not null,
      'presentation_reused', v_file.presentation_class
    ),
    btrim(p_actor)
  );

  return v_id;
end;
$$;

create function public.claim_image_redo(
  p_lease_seconds integer default 300,
  p_job_id uuid default null
)
returns table (
  id uuid,
  intake_file_id uuid,
  source_version_id uuid,
  source_storage_key text,
  version_no integer,
  prompt_id uuid,
  prompt_text text,
  model text,
  description_injected boolean,
  description_missing boolean,
  attempts integer,
  lease_token uuid,
  lease_expires_at timestamptz,
  generation_started_at timestamptz
)
language plpgsql
volatile
set search_path = public, pg_temp
as $$
declare
  v_job public.image_redo_jobs%rowtype;
  v_source_key text;
  v_token uuid := gen_random_uuid();
begin
  if p_lease_seconds is null or p_lease_seconds <= 0 or p_lease_seconds > 900 then
    raise exception 'claim_image_redo: lease must be 1..900 seconds'
      using errcode = '22023';
  end if;

  with candidate as (
    select j.id
      from public.image_redo_jobs j
     where (p_job_id is null or j.id = p_job_id)
       and j.next_attempt_at <= now()
       and (
         j.status = 'queued'
         or (
           j.status = 'processing'
           and j.lease_expires_at <= now()
         )
       )
     order by j.next_attempt_at, j.created_at, j.id
     limit 1
       for update skip locked
  )
  update public.image_redo_jobs j
     set status = 'processing',
         lease_token = v_token,
         lease_expires_at = now() + make_interval(secs => p_lease_seconds)
    from candidate c
   where j.id = c.id
  returning j.* into v_job;

  if not found then
    return;
  end if;

  select storage_key
    into v_source_key
    from public.image_versions iv
   where iv.id = v_job.source_version_id;

  insert into public.events (entity_type, entity_id, event, detail, actor)
  values (
    'image_redo',
    v_job.id,
    case
      when v_job.generation_started_at is null then 'image.redo_claimed'
      else 'image.redo_recovered'
    end,
    jsonb_build_object(
      'intake_file_id', v_job.intake_file_id,
      'version_no', v_job.version_no,
      'lease_token', v_job.lease_token,
      'lease_expires_at', v_job.lease_expires_at,
      'generation_already_started', v_job.generation_started_at is not null
    ),
    'redo-worker'
  );

  return query
  select
    v_job.id,
    v_job.intake_file_id,
    v_job.source_version_id,
    v_source_key,
    v_job.version_no,
    v_job.prompt_id,
    v_job.prompt_text,
    v_job.model,
    v_job.description_injected,
    v_job.description_missing,
    v_job.attempts,
    v_job.lease_token,
    v_job.lease_expires_at,
    v_job.generation_started_at;
end;
$$;

create function public.assert_image_redo_lease(
  p_job_id uuid,
  p_lease_token uuid
)
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  select exists (
    select 1
      from public.image_redo_jobs
     where id = p_job_id
       and status = 'processing'
       and lease_token = p_lease_token
       and lease_expires_at > now()
  );
$$;

create function public.mark_image_redo_generation_started(
  p_job_id uuid,
  p_lease_token uuid
)
returns timestamptz
language plpgsql
volatile
set search_path = public, pg_temp
as $$
declare
  v_started timestamptz;
begin
  update public.image_redo_jobs
     set generation_started_at = coalesce(generation_started_at, now())
   where id = p_job_id
     and status = 'processing'
     and lease_token = p_lease_token
     and lease_expires_at > now()
  returning generation_started_at into v_started;

  if not found then
    raise exception 'mark_image_redo_generation_started: lease is no longer current'
      using errcode = '55000';
  end if;

  return v_started;
end;
$$;

create function public.complete_image_redo(
  p_job_id uuid,
  p_lease_token uuid,
  p_storage_key text,
  p_thumb_key text,
  p_width integer,
  p_height integer,
  p_actual_model text,
  p_cost_usd numeric,
  p_max_cost_usd numeric,
  p_source text default 'redo-worker'
)
returns table (
  status public.image_redo_status,
  image_version_id uuid,
  version_no integer,
  cost_usd numeric
)
language plpgsql
volatile
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  v_job public.image_redo_jobs%rowtype;
  v_version public.image_versions%rowtype;
  v_status public.image_redo_status;
begin
  if nullif(btrim(coalesce(p_storage_key, '')), '') is null
     or nullif(btrim(coalesce(p_thumb_key, '')), '') is null
     or nullif(btrim(coalesce(p_actual_model, '')), '') is null
  then
    raise exception 'complete_image_redo: storage keys and model are required'
      using errcode = '22023';
  end if;
  if p_width <= 0 or p_height <= 0 or p_cost_usd < 0 or p_max_cost_usd <= 0 then
    raise exception 'complete_image_redo: invalid dimensions or costs'
      using errcode = '22023';
  end if;

  select *
    into v_job
    from public.image_redo_jobs j
   where j.id = p_job_id
     and j.status = 'processing'
     and j.lease_token = p_lease_token
     and j.lease_expires_at > now()
   for update;

  if not found then
    raise exception 'complete_image_redo: lease is no longer current'
      using errcode = '55000';
  end if;

  v_status := case
    when p_cost_usd > p_max_cost_usd then 'failed'::public.image_redo_status
    else 'completed'::public.image_redo_status
  end;

  insert into public.image_versions (
    intake_file_id,
    version_no,
    kind,
    storage_key,
    thumb_key,
    width,
    height,
    prompt_text,
    model,
    cost_usd,
    parent_version_id,
    is_selected,
    description_injected,
    description_missing
  )
  values (
    v_job.intake_file_id,
    v_job.version_no,
    'generated',
    btrim(p_storage_key),
    btrim(p_thumb_key),
    p_width,
    p_height,
    v_job.prompt_text,
    btrim(p_actual_model),
    p_cost_usd,
    v_job.source_version_id,
    false,
    v_job.description_injected,
    v_job.description_missing
  )
  on conflict on constraint image_versions_intake_file_id_version_no_key do nothing
  returning * into v_version;

  if not found then
    select *
      into v_version
      from public.image_versions iv
     where iv.intake_file_id = v_job.intake_file_id
       and iv.version_no = v_job.version_no;

    if v_version.storage_key <> btrim(p_storage_key)
       or v_version.thumb_key <> btrim(p_thumb_key)
       or v_version.prompt_text <> v_job.prompt_text
       or v_version.model <> btrim(p_actual_model)
       or v_version.cost_usd <> p_cost_usd
       or v_version.parent_version_id <> v_job.source_version_id
    then
      raise exception 'complete_image_redo: immutable version conflicts with job %', p_job_id
        using errcode = '23505';
    end if;
  end if;

  update public.image_redo_jobs
     set status = v_status,
         attempts = least(5, attempts + 1),
         lease_token = null,
         lease_expires_at = null,
         image_version_id = case when v_status = 'completed' then v_version.id else null end,
         cost_usd = case when v_status = 'completed' then p_cost_usd else null end,
         completed_at = case when v_status = 'completed' then now() else null end,
         last_error = case
           when v_status = 'failed' then format(
             'Image redo cost $%s exceeded the $%s per-image ceiling.',
             p_cost_usd,
             p_max_cost_usd
           )
           else null
         end,
         last_error_code = case
           when v_status = 'failed' then 'image_cost_ceiling_exceeded'
           else null
         end
   where id = p_job_id;

  insert into public.events (entity_type, entity_id, event, detail, actor)
  values (
    'image_redo',
    p_job_id,
    case
      when v_status = 'completed' then 'image.redo_completed'
      else 'image.redo_cost_ceiling_failed'
    end,
    jsonb_build_object(
      'intake_file_id', v_job.intake_file_id,
      'image_version_id', v_version.id,
      'version_no', v_job.version_no,
      'prompt_id', v_job.prompt_id,
      'model', btrim(p_actual_model),
      'cost_usd', p_cost_usd,
      'description_injected', v_job.description_injected,
      'description_missing', v_job.description_missing
    ),
    p_source
  );

  return query
  select v_status, v_version.id, v_job.version_no, p_cost_usd;
end;
$$;

create function public.record_image_redo_failure(
  p_job_id uuid,
  p_lease_token uuid,
  p_error text,
  p_error_code text,
  p_retryable boolean,
  p_source text default 'redo-worker'
)
returns table (
  status public.image_redo_status,
  attempts integer,
  next_attempt_at timestamptz
)
language plpgsql
volatile
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  v_job public.image_redo_jobs%rowtype;
  v_attempts integer;
  v_retry boolean;
  v_next timestamptz;
  v_status public.image_redo_status;
begin
  select *
    into v_job
    from public.image_redo_jobs j
   where j.id = p_job_id
     and j.status = 'processing'
     and j.lease_token = p_lease_token
     and j.lease_expires_at > now()
   for update;

  if not found then
    raise exception 'record_image_redo_failure: lease is no longer current'
      using errcode = '55000';
  end if;

  v_attempts := least(5, v_job.attempts + 1);
  -- Once a paid request was dispatched, an absent result is ambiguous. Never
  -- automatically dispatch a second paid request for the same job.
  v_retry := p_retryable and v_job.generation_started_at is null and v_attempts < 5;
  v_status := case
    when v_retry then 'queued'::public.image_redo_status
    else 'failed'::public.image_redo_status
  end;
  v_next := now() + case v_attempts
    when 1 then interval '1 minute'
    when 2 then interval '5 minutes'
    when 3 then interval '20 minutes'
    else interval '1 hour'
  end;

  update public.image_redo_jobs
     set status = v_status,
         attempts = v_attempts,
         next_attempt_at = v_next,
         lease_token = null,
         lease_expires_at = null,
         last_error = coalesce(nullif(btrim(p_error), ''), 'Image redo failed.'),
         last_error_code = coalesce(nullif(btrim(p_error_code), ''), 'image_redo_failed')
   where id = p_job_id;

  insert into public.events (entity_type, entity_id, event, detail, actor)
  values (
    'image_redo',
    p_job_id,
    case when v_retry then 'image.redo_retry_scheduled' else 'image.redo_failed' end,
    jsonb_build_object(
      'intake_file_id', v_job.intake_file_id,
      'version_no', v_job.version_no,
      'attempts', v_attempts,
      'retryable', v_retry,
      'generation_started', v_job.generation_started_at is not null,
      'error', coalesce(nullif(btrim(p_error), ''), 'Image redo failed.'),
      'code', coalesce(nullif(btrim(p_error_code), ''), 'image_redo_failed')
    ),
    p_source
  );

  return query select v_status, v_attempts, v_next;
end;
$$;

-- Model changes and prompt promotion must not invalidate a claimed redo's
-- crash-recovery metadata.
create or replace function public.select_prompt_model(
  p_kind public.prompt_kind,
  p_model text,
  p_actor text
)
returns uuid
language plpgsql
volatile
set search_path = public, pg_temp
as $$
declare
  current_prompt public.prompts%rowtype;
  next_id uuid;
begin
  if nullif(btrim(coalesce(p_actor, '')), '') is null then
    raise exception 'select_prompt_model: actor is required'
      using errcode = '22023';
  end if;

  select *
    into current_prompt
    from public.prompts
   where kind = p_kind
     and is_default
     and archived_at is null
   for update;

  if not found then
    raise exception 'select_prompt_model: no live % prompt', p_kind
      using errcode = '55000';
  end if;
  if current_prompt.model = p_model then
    return current_prompt.id;
  end if;

  if exists (
    select 1
      from public.intake_files
     where status = 'enhancing'
       and lease_expires_at > now()
  ) or exists (
    select 1
      from public.image_redo_jobs
     where status = 'processing'
       and lease_expires_at > now()
  ) then
    raise exception 'select_prompt_model: enhancement work is currently in flight'
      using errcode = '55000',
            hint = 'Wait for the current enhancement or redo to finish, then choose the model again.';
  end if;

  update public.prompts
     set is_default = false,
         archived_at = now()
   where id = current_prompt.id;

  insert into public.prompts (name, body, kind, model, is_default, created_by)
  values (
    current_prompt.name,
    current_prompt.body,
    current_prompt.kind,
    p_model,
    true,
    btrim(p_actor)
  )
  returning id into next_id;

  insert into public.events (entity_type, entity_id, event, detail, actor)
  values (
    'prompt',
    next_id,
    'prompt.model_selected',
    jsonb_build_object(
      'kind', p_kind,
      'previous_prompt_id', current_prompt.id,
      'previous_model', current_prompt.model,
      'model', p_model
    ),
    btrim(p_actor)
  );

  return next_id;
end;
$$;

alter table public.image_redo_jobs enable row level security;

revoke all on table public.image_redo_jobs from public, anon, authenticated;
grant select, insert, update, delete on table public.image_redo_jobs to service_role;

revoke all on function public.validate_prompt_body(public.prompt_kind, text)
  from public, anon, authenticated;
revoke all on function public.create_prompt_version(public.prompt_kind, text, text, text, text)
  from public, anon, authenticated;
revoke all on function public.promote_prompt_version(uuid, text)
  from public, anon, authenticated;
revoke all on function public.enqueue_image_redo(uuid, uuid, text, boolean, boolean, text)
  from public, anon, authenticated;
revoke all on function public.claim_image_redo(integer, uuid)
  from public, anon, authenticated;
revoke all on function public.assert_image_redo_lease(uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.mark_image_redo_generation_started(uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.complete_image_redo(uuid, uuid, text, text, integer, integer, text, numeric, numeric, text)
  from public, anon, authenticated;
revoke all on function public.record_image_redo_failure(uuid, uuid, text, text, boolean, text)
  from public, anon, authenticated;

grant execute on function public.validate_prompt_body(public.prompt_kind, text)
  to service_role;
grant execute on function public.create_prompt_version(public.prompt_kind, text, text, text, text)
  to service_role;
grant execute on function public.promote_prompt_version(uuid, text)
  to service_role;
grant execute on function public.enqueue_image_redo(uuid, uuid, text, boolean, boolean, text)
  to service_role;
grant execute on function public.claim_image_redo(integer, uuid)
  to service_role;
grant execute on function public.assert_image_redo_lease(uuid, uuid)
  to service_role;
grant execute on function public.mark_image_redo_generation_started(uuid, uuid)
  to service_role;
grant execute on function public.complete_image_redo(uuid, uuid, text, text, integer, integer, text, numeric, numeric, text)
  to service_role;
grant execute on function public.record_image_redo_failure(uuid, uuid, text, text, boolean, text)
  to service_role;
