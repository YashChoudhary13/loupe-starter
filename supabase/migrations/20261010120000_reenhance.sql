-- D145: Re-enhance. An operator sends a delivered image back to Claude with a note on what is
-- wrong; a redo job carries the original supplier photograph and the note; the new render
-- replaces the old one on the same intake row, so the product draft keeps it.

alter table public.agent_jobs
  add column kind               text not null default 'batch' check (kind in ('batch', 'redo')),
  add column instructions       text,
  add column redo_of_intake_id  uuid references public.intake_files (id) on delete set null;

alter table public.intake_files
  add column agent_source_photo_id uuid references public.agent_job_photos (id) on delete set null,
  add column reenhance_job_id      uuid references public.agent_jobs (id) on delete set null,
  add column reenhance_note        text;

comment on column public.intake_files.agent_source_photo_id is
  'D145: the supplier photograph this delivery was rendered from, so a redo can reuse it.';
comment on column public.intake_files.reenhance_job_id is
  'D145: set while a redo job is queued or running for this image; cleared when the replacement lands or the job fails.';

-- A redo points at the batch's original object without copying it, so one key may now appear twice.
alter table public.agent_job_photos drop constraint agent_job_photos_storage_key_key;
create index agent_job_photos_storage_key_idx on public.agent_job_photos (storage_key);

-- The operator's click. The label is built by the app (`redo <date> <stem>`); a clash gets a counter.
create or replace function public.request_reenhance(
  p_intake_file_id uuid, p_note text, p_actor text, p_label text
)
returns jsonb
language plpgsql volatile security invoker set search_path = public, pg_temp
as $$
declare
  v_file   public.intake_files%rowtype;
  v_photo  public.agent_job_photos%rowtype;
  v_key    text;
  v_name   text;
  v_bytes  integer;
  v_label  text := left(btrim(coalesce(p_label, '')), 80);
  v_note   text := nullif(left(btrim(coalesce(p_note, '')), 500), '');
  v_job    uuid;
  v_n      integer := 1;
begin
  if v_note is null then
    raise exception 'request_reenhance: say what should change' using errcode = '22023';
  end if;
  if length(v_label) < 3 then
    raise exception 'request_reenhance: label is required' using errcode = '22023';
  end if;
  select * into v_file from public.intake_files where id = p_intake_file_id for update;
  if not found then
    raise exception 'request_reenhance: no intake_file %', p_intake_file_id using errcode = 'P0002';
  end if;
  if v_file.status <> 'enhanced' then
    raise exception 'request_reenhance: % is %, not in the console', v_file.filename, v_file.status using errcode = '55000';
  end if;
  if v_file.reenhance_job_id is not null then
    raise exception 'request_reenhance: % is already being re-enhanced', v_file.filename using errcode = '55000',
      hint = 'Wait for the current redo to finish.';
  end if;

  -- The reference: the supplier photograph when known, else the image as it is now.
  if v_file.agent_source_photo_id is not null then
    select * into v_photo from public.agent_job_photos where id = v_file.agent_source_photo_id;
  end if;
  if v_photo.id is not null then
    v_key := v_photo.storage_key; v_name := v_photo.filename; v_bytes := v_photo.bytes;
  else
    select storage_key into v_key from public.image_versions
     where intake_file_id = p_intake_file_id and is_selected order by version_no desc limit 1;
    v_name := v_file.filename; v_bytes := v_file.bytes::integer;
  end if;
  if v_key is null then
    raise exception 'request_reenhance: % has no stored image to work from', v_file.filename using errcode = '55000';
  end if;

  while exists (select 1 from public.agent_jobs where label = v_label) loop
    v_n := v_n + 1;
    v_label := left(btrim(coalesce(p_label, '')), 76) || ' ' || v_n::text;
  end loop;

  insert into public.agent_jobs (label, kind, instructions, redo_of_intake_id, status, created_by, queued_at, photo_count)
  values (v_label, 'redo', v_note, p_intake_file_id, 'queued', btrim(p_actor), now(), 1)
  returning id into v_job;
  insert into public.agent_job_photos (job_id, storage_key, filename, bytes, status)
  values (v_job, v_key, v_name, v_bytes, 'uploaded');
  update public.intake_files set reenhance_job_id = v_job, reenhance_note = v_note where id = p_intake_file_id;

  insert into public.events (entity_type, entity_id, event, detail, actor)
  values ('intake_file', p_intake_file_id, 'intake.reenhance_requested',
          jsonb_build_object('job_id', v_job, 'label', v_label, 'note', v_note, 'reference', v_key), btrim(p_actor));
  insert into public.events (entity_type, entity_id, event, detail, actor)
  values ('agent_job', v_job, 'agent_job.queued', jsonb_build_object('label', v_label, 'photo_count', 1, 'kind', 'redo'), btrim(p_actor));
  return jsonb_build_object('job_id', v_job, 'label', v_label);
end;
$$;

-- The redo's render lands: a new generated version, selected, and every draft that showed the old
-- version now shows this one. The row stays enhanced; the "Re-enhancing" mark clears.
create or replace function public.replace_intake_image_from_agent(
  p_intake_file_id uuid, p_storage_key text, p_thumb_key text, p_width integer, p_height integer,
  p_phash text, p_actor text, p_tag text, p_note text, p_job_id uuid, p_sha256 text default null
)
returns jsonb
language plpgsql volatile security invoker set search_path = public, pg_temp
as $$
declare
  v_file    public.intake_files%rowtype;
  v_no      integer;
  v_version uuid;
begin
  if p_tag is not null and p_tag not in ('needs_review', 'ready', 'restock') then
    raise exception 'replace_intake_image_from_agent: tag must be needs_review, ready or restock' using errcode = '22023';
  end if;
  if nullif(btrim(coalesce(p_storage_key, '')), '') is null or nullif(btrim(coalesce(p_thumb_key, '')), '') is null then
    raise exception 'replace_intake_image_from_agent: storage and thumb keys are required' using errcode = '22023';
  end if;
  if p_width is null or p_width <= 0 or p_height is null or p_height <= 0 then
    raise exception 'replace_intake_image_from_agent: dimensions must be positive' using errcode = '22023';
  end if;
  select * into v_file from public.intake_files where id = p_intake_file_id for update;
  if not found then
    raise exception 'replace_intake_image_from_agent: no intake_file %', p_intake_file_id using errcode = 'P0002';
  end if;

  select coalesce(max(version_no), -1) + 1 into v_no from public.image_versions where intake_file_id = p_intake_file_id;
  update public.image_versions set is_selected = false where intake_file_id = p_intake_file_id and is_selected;
  insert into public.image_versions (intake_file_id, version_no, kind, storage_key, thumb_key, width, height, is_selected, prompt_text, model)
  values (p_intake_file_id, v_no, 'generated', btrim(p_storage_key), btrim(p_thumb_key), p_width, p_height, true,
          coalesce(nullif(btrim(coalesce(p_note, '')), ''), 'Re-enhanced by Claude'), 'claude-agent')
  returning id into v_version;
  -- Every draft that carried a version of this photograph now carries the new one, same position.
  update public.product_draft_images pdi
     set image_version_id = v_version
   where pdi.image_version_id in (select id from public.image_versions where intake_file_id = p_intake_file_id and id <> v_version);

  update public.intake_files
     set agent_tag = coalesce(p_tag, agent_tag),
         agent_note = coalesce(nullif(left(btrim(coalesce(p_note, '')), 500), ''), agent_note),
         agent_sha256 = coalesce(p_sha256, agent_sha256),
         phash = coalesce(p_phash, phash),
         reenhance_job_id = null, reenhance_note = null,
         last_error = case when last_error like 'Not enhanced%' then null else last_error end,
         last_error_code = case when last_error like 'Not enhanced%' then null else last_error_code end
   where id = p_intake_file_id;

  insert into public.events (entity_type, entity_id, event, detail, actor)
  values ('intake_file', p_intake_file_id, 'intake.agent_replaced',
          jsonb_strip_nulls(jsonb_build_object('version_no', v_no, 'version_id', v_version, 'job_id', p_job_id, 'tag', p_tag, 'note', nullif(btrim(coalesce(p_note, '')), ''))),
          btrim(p_actor));
  return jsonb_build_object('intake_id', p_intake_file_id, 'version_no', v_no);
end;
$$;

-- Same signature as D143; a failed redo releases its image's "Re-enhancing" mark. A claim now
-- carries the kind, the note and the image it replaces, so the runner knows what it holds.
create or replace function public.agent_job_finish(
  p_job_id uuid, p_runner text, p_status text, p_note text, p_error text, p_result_count integer
)
returns void
language plpgsql volatile security invoker set search_path = public, pg_temp
as $$
declare
  v_job public.agent_jobs%rowtype;
begin
  if p_status not in ('done', 'failed') then
    raise exception 'agent_job_finish: status must be done or failed' using errcode = '22023';
  end if;
  select * into v_job from public.agent_jobs where id = p_job_id for update;
  if not found then
    raise exception 'agent_job_finish: no job %', p_job_id using errcode = 'P0002';
  end if;
  if v_job.status <> 'running' or v_job.runner is distinct from btrim(p_runner) then
    raise exception 'agent_job_finish: job % is not running under %', p_job_id, p_runner using errcode = '55000';
  end if;
  update public.agent_jobs
     set status = p_status, finished_at = now(), lease_until = null,
         note = nullif(left(btrim(coalesce(p_note, '')), 500), ''),
         error = case when p_status = 'failed' then nullif(left(btrim(coalesce(p_error, '')), 2000), '') else null end,
         result_count = greatest(coalesce(p_result_count, 0), 0)
   where id = p_job_id;
  if v_job.kind = 'redo' and v_job.redo_of_intake_id is not null then
    -- done without a replacement also releases the mark: the runner reported, the image is what it is.
    update public.intake_files set reenhance_job_id = null, reenhance_note = null
     where id = v_job.redo_of_intake_id and reenhance_job_id = p_job_id;
  end if;
  insert into public.events (entity_type, entity_id, event, detail, actor)
  values ('agent_job', p_job_id, 'agent_job.' || p_status,
          jsonb_strip_nulls(jsonb_build_object('label', v_job.label, 'kind', v_job.kind, 'result_count', coalesce(p_result_count, 0),
                                               'note', nullif(btrim(coalesce(p_note, '')), ''))), btrim(p_runner));
end;
$$;

create or replace function public.agent_job_claim(p_runner text, p_lease_seconds integer)
returns jsonb
language plpgsql volatile security invoker set search_path = public, pg_temp
as $$
declare
  v_job public.agent_jobs%rowtype;
  v_lease integer := least(greatest(coalesce(p_lease_seconds, 1800), 60), 14400);
begin
  select * into v_job from public.agent_jobs
   where status = 'queued' or (status = 'running' and lease_until < now())
   order by queued_at nulls last
   limit 1
   for update skip locked;
  if not found then
    return null;
  end if;
  update public.agent_jobs
     set status = 'running', runner = btrim(p_runner), lease_until = now() + make_interval(secs => v_lease),
         started_at = coalesce(started_at, now()), error = null
   where id = v_job.id;
  insert into public.events (entity_type, entity_id, event, detail, actor)
  values ('agent_job', v_job.id, 'agent_job.claimed',
          jsonb_build_object('label', v_job.label, 'kind', v_job.kind, 'lease_seconds', v_lease, 'retaken', v_job.status = 'running'), btrim(p_runner));
  return jsonb_build_object('id', v_job.id, 'label', v_job.label, 'photo_count', v_job.photo_count,
                            'kind', v_job.kind, 'instructions', v_job.instructions, 'redo_of', v_job.redo_of_intake_id);
end;
$$;

revoke all on function public.request_reenhance(uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.replace_intake_image_from_agent(uuid, text, text, integer, integer, text, text, text, text, uuid, text) from public, anon, authenticated;
grant execute on function public.request_reenhance(uuid, text, text, text) to service_role;
grant execute on function public.replace_intake_image_from_agent(uuid, text, text, integer, integer, text, text, text, text, uuid, text) to service_role;
