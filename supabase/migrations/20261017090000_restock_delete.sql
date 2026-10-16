-- D154: a restock can be deleted. Until now every card in the Restock section led somewhere: the
-- old image to Pending, or a render job for the runner (generate, wrong). A photograph the owner
-- does not want at all (a repeat, a piece handled by hand, an old batch) had no way out, and the
-- section filled up. Delete closes a card without sending anything anywhere.

-- A Claude candidate (D148) keeps its row: the photograph still belongs to its batch. Only the
-- state moves, and the same restock.candidate_decided event is written, so the badge arithmetic of
-- the live feed (posted +1, decided -1) holds.
alter table public.agent_job_photos drop constraint agent_job_photos_restock_state_check;
alter table public.agent_job_photos add constraint agent_job_photos_restock_state_check
  check (restock_state in ('pending', 'use_old', 'generate', 'wrong', 'deleted'));
comment on column public.agent_job_photos.restock_state is
  'D148: null for an ordinary photograph; pending until an operator chooses use_old, generate or wrong, or deletes it (D154).';

-- Several at once: Clear all passes every card the operator saw. A card decided meanwhile in
-- another tab is skipped, not an error. Returns how many were deleted.
create or replace function public.delete_restock_candidates(p_photo_ids uuid[], p_actor text)
returns integer
language plpgsql volatile security invoker set search_path = public, pg_temp
as $$
declare
  v_photo public.agent_job_photos%rowtype;
  v_n     integer := 0;
begin
  if nullif(btrim(coalesce(p_actor, '')), '') is null then
    raise exception 'delete_restock_candidates: p_actor is required' using errcode = '22023';
  end if;
  for v_photo in
    select * from public.agent_job_photos where id = any (coalesce(p_photo_ids, '{}')) and restock_state = 'pending' order by created_at for update
  loop
    update public.agent_job_photos
       set restock_state = 'deleted', restock_decided_by = btrim(p_actor), restock_decided_at = now()
     where id = v_photo.id;
    insert into public.events (entity_type, entity_id, event, detail, actor)
    values ('agent_job', v_photo.job_id, 'restock.candidate_decided',
            jsonb_build_object('photo_id', v_photo.id, 'filename', v_photo.filename, 'choice', 'deleted'), btrim(p_actor));
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;

-- An Identify restock (D112) is a photograph an operator confirmed as an existing SKU. Deleting it
-- is the console's discard: the event first, then the intake row goes, and its decision, image
-- versions and match rows follow by cascade. A restock already applied (stock set, draft made) stays.
create or replace function public.delete_restock_decision(p_intake_file_id uuid, p_actor text)
returns void
language plpgsql volatile security invoker set search_path = public, pg_temp
as $$
declare
  v_file     public.intake_files%rowtype;
  v_decision public.restock_decisions%rowtype;
begin
  if nullif(btrim(coalesce(p_actor, '')), '') is null then
    raise exception 'delete_restock_decision: p_actor is required' using errcode = '22023';
  end if;
  select * into v_file from public.intake_files where id = p_intake_file_id for update;
  if not found or v_file.status <> 'restock' then
    raise exception 'delete_restock_decision: only a photograph waiting in Restock can be deleted' using errcode = '55000',
      hint = 'That photograph already left Restock. Reload the page.';
  end if;
  select * into v_decision from public.restock_decisions where intake_file_id = p_intake_file_id for update;
  if (found and v_decision.status in ('completed', 'draft_created')) or v_file.product_draft_id is not null then
    raise exception 'delete_restock_decision: this restock was already applied' using errcode = '55000',
      hint = 'Stock was set or a draft was made from it; it cannot be deleted here.';
  end if;
  insert into public.events (entity_type, entity_id, event, detail, actor)
  values ('intake_file', p_intake_file_id, 'restock.deleted',
          jsonb_strip_nulls(jsonb_build_object('filename', v_file.filename, 'sku', v_decision.sku, 'decision_id', v_decision.id)), btrim(p_actor));
  delete from public.intake_files where id = p_intake_file_id;
end;
$$;

revoke all on function public.delete_restock_candidates(uuid[], text) from public, anon, authenticated;
revoke all on function public.delete_restock_decision(uuid, text) from public, anon, authenticated;
grant execute on function public.delete_restock_candidates(uuid[], text) to service_role;
grant execute on function public.delete_restock_decision(uuid, text) to service_role;
