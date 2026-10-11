-- D148: restocks wait for the owner. A photograph Claude judges to be a piece the shop already
-- sells (or is not sure about) is no longer rendered or sent to Pending. Its phone photograph is
-- marked as a restock candidate with the old listings beside it, and an operator picks one of three
-- in the Restock section: use the old listing image, have a new image rendered, or wrong restock.
-- The candidate lives on the job photo: that row already holds the photograph Loupe stores.

alter table public.agent_job_photos
  add column restock            jsonb,
  add column restock_state      text check (restock_state in ('pending', 'use_old', 'generate', 'wrong')),
  add column restock_decided_by text,
  add column restock_decided_at timestamptz;
create index agent_job_photos_restock_pending_idx on public.agent_job_photos (created_at) where restock_state = 'pending';

comment on column public.agent_job_photos.restock is
  'D148: {kind: old|unsure, note, thumb, candidates: [{sku, handle, title, imageUrl, status, available, pricePaise, createdAt, suggest}]} as posted by the enhancer.';
comment on column public.agent_job_photos.restock_state is
  'D148: null for an ordinary photograph; pending until an operator chooses use_old, generate or wrong.';

-- A render job: one photograph an operator sent on from the Restock section. restock names the old
-- product when the piece is an approved restock, and is null when the operator said "wrong restock".
alter table public.agent_jobs drop constraint agent_jobs_kind_check;
alter table public.agent_jobs add constraint agent_jobs_kind_check check (kind in ('batch', 'redo', 'render'));
alter table public.agent_jobs add column restock jsonb;
comment on column public.agent_jobs.restock is
  'D148: for a render job of an approved restock, {sku, handle, also: [handles], also_archive: [skus]}; null otherwise.';

-- A photograph Claude was given outside Loupe (a zip in a chat) is registered under its batch label,
-- so a delivery can name its source, a restock candidate has a photograph, and Re-enhance works. The
-- job row is created finished: nothing is queued for it.
create or replace function public.agent_register_photo(
  p_label text, p_photo_id uuid, p_storage_key text, p_filename text, p_bytes integer, p_actor text
)
returns jsonb
language plpgsql volatile security invoker set search_path = public, pg_temp
as $$
declare
  v_label text := btrim(coalesce(p_label, ''));
  v_job   public.agent_jobs%rowtype;
  v_photo uuid;
begin
  if length(v_label) not between 3 and 80 then
    raise exception 'agent_register_photo: the batch label must be 3 to 80 characters' using errcode = '22023';
  end if;
  if nullif(btrim(coalesce(p_filename, '')), '') is null or nullif(btrim(coalesce(p_storage_key, '')), '') is null then
    raise exception 'agent_register_photo: filename and storage key are required' using errcode = '22023';
  end if;
  insert into public.agent_jobs (label, status, created_by, finished_at, note)
  values (v_label, 'done', btrim(p_actor), now(), 'Given to Claude directly, outside Loupe.')
  on conflict (label) do nothing;
  select * into v_job from public.agent_jobs where label = v_label for update;
  select id into v_photo from public.agent_job_photos
   where job_id = v_job.id and filename = btrim(p_filename) and status = 'uploaded' order by created_at limit 1;
  if v_photo is not null then
    return jsonb_build_object('photo_id', v_photo, 'duplicate', true);
  end if;
  if v_job.created_by is distinct from btrim(p_actor) then
    raise exception 'agent_register_photo: "%" is a batch an operator sent from Loupe', v_label using errcode = '55000',
      hint = 'That label belongs to a batch sent from the Enhance page. Use another label.';
  end if;
  insert into public.agent_job_photos (id, job_id, storage_key, filename, bytes, status)
  values (p_photo_id, v_job.id, btrim(p_storage_key), btrim(p_filename), p_bytes, 'uploaded');
  update public.agent_jobs set photo_count = (select count(*) from public.agent_job_photos where job_id = v_job.id and status = 'uploaded')
   where id = v_job.id;
  return jsonb_build_object('photo_id', p_photo_id, 'duplicate', false);
end;
$$;

-- The enhancer's post. A repeat while the candidate is still pending refreshes the figures; once an
-- operator has decided, a repeat changes nothing. Returns the state the photograph is in afterwards.
create or replace function public.post_restock_candidate(p_photo_id uuid, p_restock jsonb, p_actor text)
returns text
language plpgsql volatile security invoker set search_path = public, pg_temp
as $$
declare
  v_photo public.agent_job_photos%rowtype;
begin
  if p_restock is null or jsonb_typeof(p_restock) <> 'object' or coalesce(p_restock->>'kind', '') not in ('old', 'unsure') then
    raise exception 'post_restock_candidate: restock must be an object with kind old or unsure' using errcode = '22023';
  end if;
  select * into v_photo from public.agent_job_photos where id = p_photo_id for update;
  if not found then
    raise exception 'post_restock_candidate: no photograph %', p_photo_id using errcode = 'P0002';
  end if;
  if v_photo.restock_state is null then
    update public.agent_job_photos set restock = p_restock, restock_state = 'pending' where id = p_photo_id;
    insert into public.events (entity_type, entity_id, event, detail, actor)
    values ('agent_job', v_photo.job_id, 'restock.candidate_posted',
            jsonb_build_object('photo_id', p_photo_id, 'filename', v_photo.filename, 'kind', p_restock->>'kind'), btrim(p_actor));
    return 'pending';
  end if;
  if v_photo.restock_state = 'pending' then
    update public.agent_job_photos set restock = p_restock where id = p_photo_id;
  end if;
  return v_photo.restock_state;
end;
$$;

-- The operator's choice. use_old: the app has already put the old listing image into Pending, this
-- only closes the candidate. generate and wrong: one render job, queued at once, carrying the same
-- stored photograph (no copy, as a redo does).
create or replace function public.decide_restock_candidate(
  p_photo_id uuid, p_state text, p_sku text, p_restock jsonb, p_instructions text, p_label text, p_actor text
)
returns jsonb
language plpgsql volatile security invoker set search_path = public, pg_temp
as $$
declare
  v_photo public.agent_job_photos%rowtype;
  v_label text := left(btrim(coalesce(p_label, '')), 80);
  v_job   uuid;
  v_n     integer := 1;
begin
  if p_state is null or p_state not in ('use_old', 'generate', 'wrong') then
    raise exception 'decide_restock_candidate: choose use_old, generate or wrong' using errcode = '22023';
  end if;
  select * into v_photo from public.agent_job_photos where id = p_photo_id for update;
  if not found then
    raise exception 'decide_restock_candidate: no photograph %', p_photo_id using errcode = 'P0002';
  end if;
  if v_photo.restock_state is distinct from 'pending' then
    raise exception 'decide_restock_candidate: % is %', v_photo.filename, coalesce(v_photo.restock_state, 'not a restock candidate') using errcode = '55000',
      hint = 'That photograph was already decided. Reload Restock.';
  end if;

  if p_state in ('generate', 'wrong') then
    if length(v_label) < 3 then
      raise exception 'decide_restock_candidate: label is required' using errcode = '22023';
    end if;
    while exists (select 1 from public.agent_jobs where label = v_label) loop
      v_n := v_n + 1;
      v_label := left(btrim(coalesce(p_label, '')), 76) || ' ' || v_n::text;
    end loop;
    insert into public.agent_jobs (label, kind, instructions, restock, status, created_by, queued_at, photo_count)
    values (v_label, 'render', nullif(left(btrim(coalesce(p_instructions, '')), 500), ''),
            case when p_state = 'generate' then p_restock end, 'queued', btrim(p_actor), now(), 1)
    returning id into v_job;
    insert into public.agent_job_photos (job_id, storage_key, filename, bytes, status)
    values (v_job, v_photo.storage_key, v_photo.filename, v_photo.bytes, 'uploaded');
    insert into public.events (entity_type, entity_id, event, detail, actor)
    values ('agent_job', v_job, 'agent_job.queued', jsonb_build_object('label', v_label, 'photo_count', 1, 'kind', 'render'), btrim(p_actor));
  end if;

  update public.agent_job_photos
     set restock_state = p_state, restock_decided_by = btrim(p_actor), restock_decided_at = now()
   where id = p_photo_id;
  insert into public.events (entity_type, entity_id, event, detail, actor)
  values ('agent_job', v_photo.job_id, 'restock.candidate_decided',
          jsonb_strip_nulls(jsonb_build_object('photo_id', p_photo_id, 'filename', v_photo.filename, 'choice', p_state,
                                               'sku', nullif(btrim(coalesce(p_sku, '')), ''), 'render_job_id', v_job)), btrim(p_actor));
  return jsonb_strip_nulls(jsonb_build_object('state', p_state, 'job_id', v_job, 'label', case when v_job is not null then v_label end));
end;
$$;

-- The same design is sometimes listed under several SKUs. The restock photograph's suggestion names
-- the other sold-out ones (alsoArchive); publish archives them after the one the draft supersedes.
create or replace function public.supersession_also_skus(p_draft_id uuid, p_sku text)
returns text[]
language sql stable set search_path = public, pg_temp
as $$
  select coalesce((
    select array(select jsonb_array_elements_text(f.agent_suggest->'alsoArchive'))
      from public.intake_files as f
     where f.product_draft_id = p_draft_id and f.restock_sku = btrim(p_sku)
       and jsonb_typeof(f.agent_suggest->'alsoArchive') = 'array'
     order by f.discovered_at limit 1), '{}'::text[]);
$$;

revoke all on function public.agent_register_photo(text, uuid, text, text, integer, text) from public, anon, authenticated;
revoke all on function public.post_restock_candidate(uuid, jsonb, text) from public, anon, authenticated;
revoke all on function public.decide_restock_candidate(uuid, text, text, jsonb, text, text, text) from public, anon, authenticated;
revoke all on function public.supersession_also_skus(uuid, text) from public, anon, authenticated;
grant execute on function public.agent_register_photo(text, uuid, text, text, integer, text) to service_role;
grant execute on function public.post_restock_candidate(uuid, jsonb, text) to service_role;
grant execute on function public.decide_restock_candidate(uuid, text, text, jsonb, text, text, text) to service_role;
grant execute on function public.supersession_also_skus(uuid, text) to service_role;
