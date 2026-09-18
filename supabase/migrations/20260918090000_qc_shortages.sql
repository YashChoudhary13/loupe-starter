-- Accepted shortages: a missing unit the team does not have can be marked short, QC passes without it,
-- and the shortage stays on a durable follow-up list until refunded, couponed or otherwise resolved.
create table public.qc_shortages (
  id uuid primary key default gen_random_uuid(),
  ref bigint generated always as identity unique,
  session_id uuid not null references public.qc_sessions(id),
  event_id uuid not null unique references public.qc_events(id),
  shop_domain text not null,
  order_id text not null check (order_id ~ '^gid://shopify/Order/[0-9]+$'),
  order_name text not null,
  generation integer not null,
  line_id text not null,
  variant_id text,
  sku text,
  title text not null,
  variant_title text,
  quantity integer not null check (quantity >= 0),
  reason text not null,
  reported_by text not null,
  reported_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by text,
  resolution text check (resolution in ('refund','coupon','shipped','other','found','cancelled')),
  resolution_note text,
  check ((resolved_at is null) = (resolution is null)),
  unique (session_id, generation, line_id)
);
create index qc_shortages_open_idx on public.qc_shortages(shop_domain, reported_at desc) where resolved_at is null;
create index qc_shortages_resolved_idx on public.qc_shortages(shop_domain, resolved_at desc) where resolved_at is not null;
alter table public.qc_shortages enable row level security;
revoke all on public.qc_shortages from public, anon, authenticated;
grant select, insert, update on public.qc_shortages to service_role;
comment on table public.qc_shortages is 'Units marked short during order QC; open rows are the refund/coupon follow-up list. No customer information is stored.';

-- The signature gains p_line_id; drop the old overload so PostgREST cannot see two candidates.
drop function public.qc_command(text,text,uuid,text,jsonb,text,timestamptz,uuid,text,text,text,integer,uuid,text,integer);

create function public.qc_command(
  p_shop_domain text,
  p_order_id text,
  p_actor_id uuid,
  p_action text,
  p_snapshot jsonb,
  p_fingerprint text,
  p_checked_at timestamptz,
  p_request_id uuid default null,
  p_code text default null,
  p_variant_id text default null,
  p_rejection text default null,
  p_expected_version integer default null,
  p_undo_event_id uuid default null,
  p_reason text default null,
  p_expected_generation integer default null,
  p_line_id text default null
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  s public.qc_sessions%rowtype;
  e public.qc_events%rowtype;
  target public.qc_events%rowtype;
  actor text;
  cmd jsonb;
  line jsonb;
  target_line text;
  current_count integer;
  short_open integer;
  short_total integer;
  outcome text;
  message text;
  detail jsonb := '{}'::jsonb;
  undo_id uuid;
  new_session boolean := false;
begin
  select coalesce(nullif(name,''), email) into actor from public.app_users where id = p_actor_id and active;
  if actor is null then raise exception 'An active Loupe operator is required.' using errcode = '42501'; end if;
  if p_action not in ('sync','scan','complete','reset','undo','clear_extra','short') then raise exception 'Unknown QC action.'; end if;
  if p_checked_at is null or p_checked_at < clock_timestamp() - interval '30 seconds' or p_checked_at > clock_timestamp() + interval '5 seconds' then
    raise exception 'The Shopify check expired. Refresh this order and retry.';
  end if;
  if p_shop_domain is null or p_shop_domain !~ '^[a-zA-Z0-9-]+\.myshopify\.com$'
    or p_order_id is null or p_order_id !~ '^gid://shopify/Order/[0-9]+$'
    or p_fingerprint is null or p_fingerprint !~ '^[0-9a-f]{64}$'
    or p_snapshot is null or p_snapshot->>'id' is distinct from p_order_id
    or jsonb_typeof(p_snapshot->'lines') is distinct from 'array'
    or jsonb_array_length(p_snapshot->'lines') > 10000
  then raise exception 'Invalid Shopify order snapshot.'; end if;
  if exists (select 1 from jsonb_array_elements(p_snapshot->'lines') v where v->>'id' is null
      or v->>'required' is null or (v->>'required') !~ '^[1-9][0-9]{0,6}$')
    or (select count(*) from jsonb_array_elements(p_snapshot->'lines')) <>
       (select count(distinct v->>'id') from jsonb_array_elements(p_snapshot->'lines') v)
  then raise exception 'Invalid or repeated order quantities.'; end if;
  if p_action <> 'sync' and p_request_id is null then raise exception 'A request ID is required.'; end if;
  if p_action = 'scan' and (p_code is null or length(p_code) not between 1 and 64 or p_code ~ '[^!-~]') then
    raise exception 'Scan a valid barcode or SKU.';
  end if;
  if p_action = 'clear_extra' and p_undo_event_id is null then raise exception 'Choose an extra item to confirm it was removed.'; end if;
  if p_action = 'short' and (p_line_id is null or p_line_id !~ '^gid://shopify/LineItem/[0-9]+$') then raise exception 'Choose an order line to mark short.'; end if;
  if p_action in ('reset','undo','short') and (p_reason is null or length(trim(p_reason)) not between 3 and 240) then
    raise exception 'Record a short reason before changing saved QC counts.';
  end if;

  insert into public.qc_sessions(shop_domain,order_id,fingerprint,snapshot,checked_at,created_by)
  values(p_shop_domain,p_order_id,p_fingerprint,p_snapshot,p_checked_at,p_actor_id)
  on conflict (shop_domain,order_id) do nothing returning * into s;
  new_session := found;
  select * into strict s from public.qc_sessions where shop_domain=p_shop_domain and order_id=p_order_id for update;
  if new_session then
    insert into public.qc_events(session_id,generation,action,outcome,message,actor_id,actor_name)
    values(s.id,s.generation,'open','opened','Opened QC for all remaining shipping units.',p_actor_id,actor);
  end if;
  if s.fingerprint <> p_fingerprint and s.status <> 'stale' then
    update public.qc_sessions set status='stale',version=version+1,completed_at=null,completed_by=null,updated_at=clock_timestamp()
    where id=s.id returning * into s;
    insert into public.qc_events(session_id,generation,action,outcome,message,actor_id,actor_name,detail)
    values(s.id,s.generation,'invalidate','stale','The Shopify items, quantities or codes changed. Recount from a fresh checklist.',p_actor_id,actor,
      jsonb_build_object('new_snapshot',p_snapshot,'new_fingerprint',p_fingerprint));
  elsif s.status <> 'stale' then
    update public.qc_sessions set checked_at=greatest(checked_at,p_checked_at) where id=s.id returning * into s;
  end if;
  if p_action='sync' then return jsonb_build_object('session',to_jsonb(s)); end if;

  cmd := jsonb_build_object('action',p_action,'actor',p_actor_id,'code',p_code,'version',p_expected_version,'undo',p_undo_event_id,'reason',p_reason,'generation',p_expected_generation,'line',p_line_id);
  select * into e from public.qc_events where session_id=s.id and request_id=p_request_id;
  if found then
    if e.command is distinct from cmd then raise exception 'This request ID was already used for a different action.'; end if;
    return jsonb_build_object('session',to_jsonb(s),'event',to_jsonb(e),'replayed',true);
  end if;

  if p_action = 'scan' and p_expected_generation is distinct from s.generation then
    outcome := 'conflict'; message := 'This scan belongs to an older checklist. Review the current checklist before scanning this unit again.';
  elsif p_action <> 'scan' and p_expected_version is distinct from s.version then
    outcome := 'conflict'; message := 'Another QC action changed this order. Review the current counts and try again.';
  elsif p_action='reset' then
    if p_snapshot->>'blockedReason' is not null then
      outcome := 'blocked'; message := p_snapshot->>'blockedReason';
    else
      detail := jsonb_build_object('previous_snapshot',s.snapshot,'previous_counts',s.counts,'reason',p_reason,'generation',p_expected_generation);
      -- Shortages belong to the checklist that recorded them; a fresh checklist starts with none.
      update public.qc_shortages set resolved_at=clock_timestamp(),resolved_by=actor,resolution='cancelled',resolution_note='Checklist restarted: '||p_reason
      where session_id=s.id and generation=s.generation and resolved_at is null;
      update public.qc_sessions set snapshot=p_snapshot,fingerprint=p_fingerprint,counts='{}'::jsonb,status='checking',
        generation=generation+1,version=version+1,checked_at=p_checked_at,completed_at=null,completed_by=null,updated_at=clock_timestamp()
      where id=s.id returning * into s;
      outcome := 'reset'; message := 'Started a fresh checklist. Scan every unit again.';
    end if;
  elsif s.status='stale' then
    outcome := 'stale'; message := 'The Shopify order changed. Start a fresh checklist and recount all units.';
  elsif p_snapshot->>'blockedReason' is not null then
    outcome := 'blocked'; message := p_snapshot->>'blockedReason';
  elsif p_action='scan' then
    if p_rejection is not null then
      outcome := 'rejected'; message := left(p_rejection,500);
    elsif p_variant_id is null then
      outcome := 'rejected'; message := 'This code does not identify a saved Shopify variant.';
    elsif s.status='passed' then
      outcome := 'extra'; message := 'QC has already passed. Recorded as extra — confirm it was removed.';
    else
      select v into line from jsonb_array_elements(s.snapshot->'lines') v
      where v->>'variantId'=p_variant_id and coalesce((s.counts->>(v->>'id'))::integer,0) < (v->>'required')::integer
      order by v->>'id' limit 1;
      if line is null then
        if exists (select 1 from jsonb_array_elements(s.snapshot->'lines') v where v->>'variantId'=p_variant_id) then
          outcome := 'extra'; message := 'Recorded extra unit of this variant. Confirm it was removed at the end of QC.';
        else outcome := 'wrong'; message := 'This variant is not on this order. Recorded as extra. Confirm it was removed at the end of QC.'; end if;
      else
        target_line := line->>'id';
        current_count := coalesce((s.counts->>target_line)::integer,0);
        update public.qc_sessions set counts=jsonb_set(counts,array[target_line],to_jsonb(current_count+1),true),
          version=version+1,updated_at=clock_timestamp() where id=s.id returning * into s;
        outcome := 'accepted'; message := 'Checked 1 unit: ' || (line->>'title') || coalesce(' · '||(line->>'variantTitle'),'');
        -- A unit that was marked short and then turns up is no longer short.
        update public.qc_shortages set quantity=quantity-1 where session_id=s.id and generation=s.generation and line_id=target_line and resolved_at is null and quantity>0;
        update public.qc_shortages set resolved_at=clock_timestamp(),resolved_by=actor,resolution='found',resolution_note='Scanned after being marked short.'
        where session_id=s.id and generation=s.generation and line_id=target_line and resolved_at is null and quantity=0;
        if found then message := message || ' Found: the shortage on this line is closed.'; detail := jsonb_build_object('shortage','found'); end if;
      end if;
    end if;
  elsif p_action='short' then
    select v into line from jsonb_array_elements(s.snapshot->'lines') v where v->>'id'=p_line_id;
    select coalesce(sum(quantity),0)::integer into short_open from public.qc_shortages where session_id=s.id and generation=s.generation and line_id=p_line_id and resolved_at is null;
    if line is null then
      outcome := 'rejected'; message := 'That line is not on this checklist. Refresh the order.';
    elsif s.status='passed' then
      outcome := 'rejected'; message := 'QC has already passed. Recount to change what was short.';
    elsif short_open > 0 then
      outcome := 'rejected'; message := 'This line is already marked short. Undo it from the history if that was wrong.';
    elsif (line->>'required')::integer - coalesce((s.counts->>p_line_id)::integer,0) <= 0 then
      outcome := 'rejected'; message := 'Nothing is short on this line: every unit is checked.';
    else
      target_line := p_line_id;
      short_total := (line->>'required')::integer - coalesce((s.counts->>p_line_id)::integer,0);
      detail := jsonb_build_object('quantity',short_total,'reason',p_reason);
      update public.qc_sessions set version=version+1,updated_at=clock_timestamp() where id=s.id returning * into s;
      outcome := 'short'; message := 'Marked ' || short_total || ' short: ' || (line->>'title') || coalesce(' · '||(line->>'variantTitle'),'') || '. QC can pass without it; it stays on the shortage list until refunded or couponed.';
    end if;
  elsif p_action='clear_extra' then
    select * into target from public.qc_events where id=p_undo_event_id and session_id=s.id;
    if target.id is null or target.generation <> s.generation or target.outcome not in ('extra','wrong')
      or exists(select 1 from public.qc_events where session_id=s.id and undo_of=target.id) then
      outcome := 'rejected'; message := 'Choose an extra item from this checklist to confirm it was removed.';
    else
      undo_id := target.id;
      update public.qc_sessions set version=version+1,updated_at=clock_timestamp() where id=s.id returning * into s;
      outcome := 'removed'; message := 'Confirmed extra item was removed from this order.';
    end if;
  elsif p_action='undo' then
    select * into target from public.qc_events where id=p_undo_event_id and session_id=s.id;
    if target.id is not null and target.outcome='short' and target.generation=s.generation
      and not exists(select 1 from public.qc_events where session_id=s.id and undo_of=target.id)
      and exists(select 1 from public.qc_shortages where event_id=target.id and resolved_at is null) then
      target_line := target.line_id; undo_id := target.id;
      detail := jsonb_build_object('reason',p_reason,'generation',p_expected_generation,'shortage','cancelled');
      update public.qc_shortages set resolved_at=clock_timestamp(),resolved_by=actor,resolution='cancelled',resolution_note=p_reason where event_id=target.id;
      update public.qc_sessions set status='checking',version=version+1,completed_at=null,completed_by=null,updated_at=clock_timestamp()
      where id=s.id returning * into s;
      outcome := 'undone'; message := 'Removed the shortage. Those units must be scanned before QC can pass.';
    elsif target.id is null or target.outcome <> 'accepted' or target.generation <> s.generation or target.actor_id <> p_actor_id
      or exists(select 1 from public.qc_events where session_id=s.id and undo_of=target.id)
      or coalesce((s.counts->>target.line_id)::integer,0) <= 0 then
      outcome := 'rejected'; message := 'Only your own counted scans in this checklist can be undone once. Refresh the history.';
    else
      target_line := target.line_id; undo_id := target.id;
      detail := jsonb_build_object('reason',p_reason,'generation',p_expected_generation);
      current_count := (s.counts->>target_line)::integer;
      update public.qc_sessions set counts=jsonb_set(counts,array[target_line],to_jsonb(current_count-1)),
        status='checking',version=version+1,completed_at=null,completed_by=null,updated_at=clock_timestamp()
      where id=s.id returning * into s;
      outcome := 'undone'; message := 'Removed one counted unit. QC must be completed again.';
    end if;
  elsif p_action='complete' then
    select coalesce(sum(quantity),0)::integer into short_total from public.qc_shortages where session_id=s.id and generation=s.generation and resolved_at is null;
    if jsonb_array_length(s.snapshot->'lines')=0 or exists (select 1 from jsonb_array_elements(s.snapshot->'lines') v
      where coalesce((s.counts->>(v->>'id'))::integer,0)
        + coalesce((select sum(quantity) from public.qc_shortages x where x.session_id=s.id and x.generation=s.generation and x.line_id=v->>'id' and x.resolved_at is null),0)
        <> (v->>'required')::integer) then
      outcome := 'incomplete'; message := 'Items are still missing. Scan every remaining unit, or mark what you do not have as short, before completing QC.';
    elsif exists (
      select 1 from public.qc_events extra
      where extra.session_id=s.id and extra.generation=s.generation and extra.outcome in ('extra','wrong')
        and not exists (select 1 from public.qc_events cleared where cleared.session_id=s.id and cleared.undo_of=extra.id and cleared.outcome='removed')
    ) then
      outcome := 'extras'; message := 'Confirm every extra item was removed, then complete QC.';
    else
      update public.qc_sessions set status='passed',version=version+1,completed_at=clock_timestamp(),completed_by=p_actor_id,
        checked_at=p_checked_at,updated_at=clock_timestamp() where id=s.id returning * into s;
      detail := jsonb_build_object('short',short_total);
      outcome := 'passed';
      message := case when short_total > 0
        then 'QC passed with ' || short_total || ' unit(s) short. Those units are on the shortage list for refund or coupon. Shopify fulfillment is unchanged.'
        else 'QC passed for all remaining shipping units. Shopify fulfillment is unchanged.' end;
    end if;
  end if;
  insert into public.qc_events(session_id,request_id,command,generation,action,outcome,message,code,line_id,variant_id,actor_id,actor_name,undo_of,detail)
  values(s.id,p_request_id,cmd,s.generation,p_action,outcome,message,p_code,target_line,coalesce(p_variant_id,line->>'variantId'),p_actor_id,actor,undo_id,detail)
  returning * into e;
  if outcome='short' then
    insert into public.qc_shortages(session_id,event_id,shop_domain,order_id,order_name,generation,line_id,variant_id,sku,title,variant_title,quantity,reason,reported_by)
    values(s.id,e.id,s.shop_domain,s.order_id,coalesce(s.snapshot->>'name',s.order_id),s.generation,p_line_id,line->>'variantId',coalesce(line->>'barcode',line->>'sku'),line->>'title',line->>'variantTitle',short_total,trim(p_reason),actor);
  end if;
  return jsonb_build_object('session',to_jsonb(s),'event',to_jsonb(e),'replayed',false);
end;
$$;
revoke all on function public.qc_command(text,text,uuid,text,jsonb,text,timestamptz,uuid,text,text,text,integer,uuid,text,integer,text) from public, anon, authenticated;
grant execute on function public.qc_command(text,text,uuid,text,jsonb,text,timestamptz,uuid,text,text,text,integer,uuid,text,integer,text) to service_role;
