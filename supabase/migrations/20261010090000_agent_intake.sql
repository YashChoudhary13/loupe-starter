-- D142: Claude is the enhancer. Finished images arrive through POST /api/agent/images with a tag,
-- a note and, for a restock, the old SKU plus a listing suggestion. The row is an ordinary manual
-- (ready, AI-bypassed) intake so every console path keeps working; the six columns below are the
-- agent's annotations, shown as chips and as a "Use suggestion" panel.

alter table public.intake_files
  add column agent_tag     text check (agent_tag in ('needs_review', 'ready', 'restock')),
  add column agent_note    text,
  add column restock_sku   text,
  add column agent_suggest jsonb,
  add column agent_sha256  text,
  add column agent_batch   text;

comment on column public.intake_files.agent_tag is
  'Claude''s verdict on the finished image: needs_review, ready, or restock of restock_sku (D142).';
comment on column public.intake_files.agent_suggest is
  'Listing suggestion for a restock: price_paise, material, title_suffix, variant_kind, colours, old_handle, old_status, available, committed, on_hand, archive_old (D142). Never applied without an operator click.';
comment on column public.intake_files.agent_sha256 is
  'SHA-256 of the uploaded bytes; a second upload of the same file returns the first row (D142).';

create index intake_files_agent_sha256_idx on public.intake_files (agent_sha256) where agent_sha256 is not null;
create index intake_files_agent_batch_idx  on public.intake_files (agent_batch)  where agent_batch  is not null;

-- An agent-confirmed restock has no Identify event behind it (the match was made outside Loupe),
-- so a restock decision may now stand without one. Every existing path still writes one.
alter table public.restock_decisions alter column match_event_id drop not null;

-- The agent finalise: the manual finalise (same verification, same intake row, same selected
-- original) plus the annotations and one event. Idempotent on the file's SHA-256.
create or replace function public.finalize_agent_image_upload(
  p_upload_id   uuid,
  p_thumb_key   text,
  p_width       integer,
  p_height      integer,
  p_phash       text,
  p_actor       text,
  p_tag         text,
  p_note        text,
  p_restock_sku text,
  p_suggest     jsonb,
  p_sha256      text,
  p_batch       text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
as $$
declare
  v_existing public.intake_files%rowtype;
  v_intake_id uuid;
begin
  if p_tag is null or p_tag not in ('needs_review', 'ready', 'restock') then
    raise exception 'finalize_agent_image_upload: tag must be needs_review, ready or restock'
      using errcode = '22023';
  end if;
  if p_tag = 'restock' and nullif(btrim(coalesce(p_restock_sku, '')), '') is null then
    raise exception 'finalize_agent_image_upload: a restock needs the old SKU'
      using errcode = '22023';
  end if;
  if p_sha256 is null or p_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'finalize_agent_image_upload: sha256 must be 64 lowercase hexadecimal characters'
      using errcode = '22023';
  end if;

  select * into v_existing from public.intake_files where agent_sha256 = p_sha256 limit 1;
  if found then
    update public.manual_uploads
       set status = 'completed', intake_file_id = v_existing.id, completed_at = coalesce(completed_at, now())
     where id = p_upload_id and status = 'pending';
    return jsonb_build_object('intake_id', v_existing.id, 'status', v_existing.status, 'duplicate', true);
  end if;

  v_intake_id := public.finalize_manual_image_upload(p_upload_id, p_thumb_key, p_width, p_height, p_phash, p_actor);

  update public.intake_files
     set agent_tag     = p_tag,
         agent_note    = nullif(left(btrim(coalesce(p_note, '')), 500), ''),
         restock_sku   = nullif(btrim(coalesce(p_restock_sku, '')), ''),
         agent_suggest = p_suggest,
         agent_sha256  = p_sha256,
         agent_batch   = nullif(left(btrim(coalesce(p_batch, '')), 80), '')
   where id = v_intake_id;

  insert into public.events (entity_type, entity_id, event, detail, actor)
  values ('intake_file', v_intake_id, 'intake.agent_uploaded',
          jsonb_strip_nulls(jsonb_build_object(
            'tag', p_tag, 'note', nullif(btrim(coalesce(p_note, '')), ''), 'restock_sku', nullif(btrim(coalesce(p_restock_sku, '')), ''),
            'batch', nullif(btrim(coalesce(p_batch, '')), ''), 'sha256', p_sha256, 'ai_bypassed', true)),
          btrim(p_actor));

  return jsonb_build_object('intake_id', v_intake_id, 'status', 'enhanced', 'duplicate', false);
end;
$$;
comment on function public.finalize_agent_image_upload(uuid, text, integer, integer, text, text, text, text, text, jsonb, text, text) is
  'D142: finalize_manual_image_upload plus the agent''s tag, note, restock SKU and suggestion; a repeated SHA-256 returns the existing row.';
revoke all on function public.finalize_agent_image_upload(uuid, text, integer, integer, text, text, text, text, text, jsonb, text, text) from public, anon, authenticated;
grant execute on function public.finalize_agent_image_upload(uuid, text, integer, integer, text, text, text, text, text, jsonb, text, text) to service_role;

-- The operator's click on "Use suggestion" with archive_old: records the supersession the same way
-- Restock does (a new_sku_archive_old decision), so publish archives the old product and zeroes its
-- stock through pending_supersession / record_supersession unchanged. p_enable false withdraws it
-- while the draft is still unpublished.
create or replace function public.set_agent_supersession(
  p_draft_id uuid,
  p_sku      text,
  p_enable   boolean,
  p_actor    text
)
returns void
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
as $$
declare
  v_draft public.product_drafts%rowtype;
  v_file  public.intake_files%rowtype;
begin
  select * into v_draft from public.product_drafts where id = p_draft_id for update;
  if not found then
    raise exception 'set_agent_supersession: no draft %', p_draft_id using errcode = 'P0002';
  end if;
  if v_draft.status not in ('assembling', 'failed') then
    raise exception 'set_agent_supersession: the draft is %', v_draft.status using errcode = '55000',
      hint = 'The old listing can only be marked before this product is published.';
  end if;
  select * into v_file from public.intake_files
   where product_draft_id = p_draft_id and restock_sku = btrim(p_sku)
   order by discovered_at limit 1;
  if not found then
    raise exception 'set_agent_supersession: no photograph in this draft was tagged as a restock of %', p_sku using errcode = '22023';
  end if;

  if coalesce(p_enable, false) then
    insert into public.restock_decisions (intake_file_id, sku, path, new_draft_id, wants_new_image, status, created_by)
    values (v_file.id, btrim(p_sku), 'new_sku_archive_old', p_draft_id, false, 'draft_created', btrim(p_actor))
    on conflict (intake_file_id) do update
       set sku = excluded.sku, path = 'new_sku_archive_old', new_draft_id = excluded.new_draft_id,
           status = 'draft_created', last_error = null
     where public.restock_decisions.status <> 'completed';
    update public.product_drafts set supersedes_sku = btrim(p_sku) where id = p_draft_id;
  else
    delete from public.restock_decisions
     where intake_file_id = v_file.id and match_event_id is null and status <> 'completed';
    update public.product_drafts set supersedes_sku = null where id = p_draft_id;
  end if;

  insert into public.events (entity_type, entity_id, event, detail, actor)
  values ('product_draft', p_draft_id, 'restock.agent_supersession',
          jsonb_build_object('old_sku', btrim(p_sku), 'enabled', coalesce(p_enable, false), 'intake_file_id', v_file.id),
          btrim(p_actor));
end;
$$;
comment on function public.set_agent_supersession(uuid, text, boolean, text) is
  'D142: mark (or unmark) that this draft replaces an old product the agent identified; publish then archives the old one through the existing supersession.';
revoke all on function public.set_agent_supersession(uuid, text, boolean, text) from public, anon, authenticated;
grant execute on function public.set_agent_supersession(uuid, text, boolean, text) to service_role;
