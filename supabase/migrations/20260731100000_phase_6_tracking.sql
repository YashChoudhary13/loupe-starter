-- Loupe · Phase 6 — tracking, duplicate review and Shopify reconciliation

create type public.duplicate_review_decision as enum ('dismissed', 'duplicate');
create type public.shopify_reconciliation_status as enum (
  'running',
  'completed',
  'failed'
);

create table public.duplicate_reviews (
  id                       uuid primary key default gen_random_uuid(),
  left_intake_file_id      uuid not null references public.intake_files (id) on delete cascade,
  right_intake_file_id     uuid not null references public.intake_files (id) on delete cascade,
  decision                 public.duplicate_review_decision not null,
  duplicate_intake_file_id uuid references public.intake_files (id) on delete cascade,
  distance                 smallint not null check (distance between 0 and 64),
  actor                    text not null check (length(btrim(actor)) > 0),
  reviewed_at              timestamptz not null default now(),
  constraint duplicate_reviews_canonical_pair check (
    left_intake_file_id < right_intake_file_id
  ),
  constraint duplicate_reviews_duplicate_target check (
    (decision = 'dismissed' and duplicate_intake_file_id is null)
    or
    (
      decision = 'duplicate'
      and duplicate_intake_file_id in (left_intake_file_id, right_intake_file_id)
    )
  ),
  unique (left_intake_file_id, right_intake_file_id)
);

comment on table public.duplicate_reviews is
  'One durable operator decision per canonical perceptual-hash candidate pair. A warning never blocks publish; only the explicit duplicate decision changes an intake status.';

create index duplicate_reviews_duplicate_target_idx
  on public.duplicate_reviews (duplicate_intake_file_id)
  where duplicate_intake_file_id is not null;

create table public.shopify_reconciliation_runs (
  id               uuid primary key default gen_random_uuid(),
  status           public.shopify_reconciliation_status not null default 'running',
  started_by       text not null check (length(btrim(started_by)) > 0),
  lease_token      uuid,
  lease_expires_at timestamptz,
  started_at       timestamptz not null default now(),
  completed_at     timestamptz,
  total_products   integer not null default 0 check (total_products >= 0),
  matched_products integer not null default 0 check (matched_products >= 0),
  issue_count      integer not null default 0 check (issue_count >= 0),
  error            text,
  created_at       timestamptz not null default now(),
  constraint shopify_reconciliation_terminal_shape check (
    (
      status = 'running'
      and lease_token is not null
      and lease_expires_at is not null
      and completed_at is null
    )
    or
    (
      status in ('completed', 'failed')
      and lease_token is null
      and lease_expires_at is null
      and completed_at is not null
    )
  ),
  constraint shopify_reconciliation_failure_explained check (
    status <> 'failed' or error is not null
  )
);

create unique index shopify_reconciliation_one_active
  on public.shopify_reconciliation_runs ((true))
  where status = 'running';

create index shopify_reconciliation_runs_started_idx
  on public.shopify_reconciliation_runs (started_at desc);

create table public.shopify_reconciliation_issues (
  id                 bigint generated always as identity primary key,
  run_id             uuid not null
    references public.shopify_reconciliation_runs (id) on delete cascade,
  product_draft_id   uuid not null references public.product_drafts (id) on delete cascade,
  shopify_product_id text,
  code               text not null check (length(btrim(code)) > 0),
  field              text not null check (length(btrim(field)) > 0),
  expected           jsonb not null default 'null'::jsonb,
  actual             jsonb not null default 'null'::jsonb,
  message            text not null check (length(btrim(message)) > 0),
  created_at         timestamptz not null default now()
);

create index shopify_reconciliation_issues_run_idx
  on public.shopify_reconciliation_issues (run_id, product_draft_id, field);

-- A source hash is written under the same UUID lease that owns enhancement.
-- Replays may write the identical value; a different value is a correctness
-- failure rather than something that can be silently overwritten.
create or replace function public.store_intake_phash(
  p_intake_file_id uuid,
  p_lease_token    uuid,
  p_phash          text,
  p_source         text
)
returns text
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
as $$
declare
  v_file public.intake_files%rowtype;
  v_hash text := lower(btrim(p_phash));
begin
  if v_hash !~ '^[0-9a-f]{16}$' then
    raise exception 'store_intake_phash: p_phash must be exactly 16 hexadecimal characters'
      using errcode = '22023';
  end if;

  select f.* into v_file
    from public.intake_files as f
   where f.id = p_intake_file_id
   for update;

  if not found then
    raise exception 'store_intake_phash: no intake_file %', p_intake_file_id
      using errcode = 'P0002';
  end if;
  if v_file.status <> 'enhancing'
     or v_file.lease_token is distinct from p_lease_token
     or v_file.lease_expires_at is null
     or v_file.lease_expires_at <= now()
  then
    raise exception 'store_intake_phash: stale enhancement lease for %', p_intake_file_id
      using errcode = '55000';
  end if;
  if v_file.phash is not null and v_file.phash <> v_hash then
    raise exception 'store_intake_phash: source hash changed for %', p_intake_file_id
      using errcode = '23514';
  end if;

  if v_file.phash is null then
    update public.intake_files
       set phash = v_hash
     where id = p_intake_file_id;

    insert into public.events (entity_type, entity_id, event, detail, actor)
    values (
      'intake_file',
      p_intake_file_id,
      'intake.phash_stored',
      jsonb_build_object('phash', v_hash, 'source', p_source),
      p_source
    );
  end if;

  return v_hash;
end;
$$;

create or replace function public.retry_intake_file(
  p_intake_file_id uuid,
  p_actor          text
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
    raise exception 'retry_intake_file: p_actor is required' using errcode = '22023';
  end if;

  select f.* into v_file
    from public.intake_files as f
   where f.id = p_intake_file_id
   for update;

  if not found then
    raise exception 'retry_intake_file: no intake_file %', p_intake_file_id
      using errcode = 'P0002';
  end if;
  if v_file.status <> 'failed' or v_file.error_class <> 'retryable' then
    raise exception 'retry_intake_file: only a failed retryable item can be retried'
      using errcode = '55000',
            hint = 'This failure will repeat unchanged. Correct or replace the source file, then skip this row.';
  end if;
  if v_file.product_draft_id is not null then
    raise exception 'retry_intake_file: grouped work must be opened in the console'
      using errcode = '55000';
  end if;

  update public.intake_files
     set status            = 'discovered',
         attempts          = 0,
         last_error        = null,
         last_error_code   = null,
         last_error_detail = null,
         error_class       = null,
         lease_token       = null,
         lease_expires_at  = null,
         next_attempt_at   = now()
   where id = p_intake_file_id;

  insert into public.events (entity_type, entity_id, event, detail, actor)
  values (
    'intake_file',
    p_intake_file_id,
    'intake.retry_requested',
    jsonb_build_object(
      'previous_attempts', v_file.attempts,
      'previous_error_code', v_file.last_error_code
    ),
    p_actor
  );

  return 'discovered'::public.intake_status;
end;
$$;

create or replace function public.skip_intake_file(
  p_intake_file_id uuid,
  p_actor          text
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
    raise exception 'skip_intake_file: p_actor is required' using errcode = '22023';
  end if;

  select f.* into v_file
    from public.intake_files as f
   where f.id = p_intake_file_id
   for update;

  if not found then
    raise exception 'skip_intake_file: no intake_file %', p_intake_file_id
      using errcode = 'P0002';
  end if;
  if v_file.status = 'skipped' then
    return v_file.status;
  end if;
  if v_file.product_draft_id is not null
     or v_file.status in ('grouped', 'published', 'duplicate')
  then
    raise exception 'skip_intake_file: grouped, published or duplicate work cannot be skipped'
      using errcode = '55000',
            hint = 'Open the product in the console; this photograph already belongs to a product or duplicate decision.';
  end if;
  if v_file.status = 'enhancing' then
    raise exception 'skip_intake_file: enhancement is still running'
      using errcode = '55000',
            hint = 'Wait for the current enhancement attempt to finish before skipping it.';
  end if;

  update public.intake_files
     set status           = 'skipped',
         lease_token      = null,
         lease_expires_at = null,
         next_attempt_at  = now()
   where id = p_intake_file_id;

  insert into public.events (entity_type, entity_id, event, detail, actor)
  values (
    'intake_file',
    p_intake_file_id,
    'intake.skipped',
    jsonb_build_object('previous_status', v_file.status),
    p_actor
  );

  return 'skipped'::public.intake_status;
end;
$$;

create or replace function public.review_duplicate_pair(
  p_left_intake_file_id      uuid,
  p_right_intake_file_id     uuid,
  p_decision                 public.duplicate_review_decision,
  p_duplicate_intake_file_id uuid,
  p_distance                 integer,
  p_actor                    text
)
returns uuid
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
as $$
declare
  v_left       uuid := least(p_left_intake_file_id, p_right_intake_file_id);
  v_right      uuid := greatest(p_left_intake_file_id, p_right_intake_file_id);
  v_target     public.intake_files%rowtype;
  v_review_id  uuid;
begin
  if p_left_intake_file_id = p_right_intake_file_id then
    raise exception 'review_duplicate_pair: a file cannot be compared with itself'
      using errcode = '22023';
  end if;
  if p_distance < 0 or p_distance > 64 then
    raise exception 'review_duplicate_pair: distance must be between 0 and 64'
      using errcode = '22023';
  end if;
  if p_actor is null or btrim(p_actor) = '' then
    raise exception 'review_duplicate_pair: p_actor is required' using errcode = '22023';
  end if;
  if not exists (select 1 from public.intake_files where id = v_left)
     or not exists (select 1 from public.intake_files where id = v_right)
  then
    raise exception 'review_duplicate_pair: one or both intake files do not exist'
      using errcode = 'P0002';
  end if;

  if p_decision = 'duplicate' then
    if p_duplicate_intake_file_id not in (v_left, v_right) then
      raise exception 'review_duplicate_pair: duplicate target must belong to the pair'
        using errcode = '22023';
    end if;

    select f.* into v_target
      from public.intake_files as f
     where f.id = p_duplicate_intake_file_id
     for update;

    if v_target.product_draft_id is not null
       or v_target.status not in ('enhanced', 'failed')
    then
      raise exception 'review_duplicate_pair: target is no longer an ungrouped reviewable file'
        using errcode = '55000',
              hint = 'Reload Tracking. Grouped, published or actively processing photographs cannot be marked duplicate.';
    end if;
  elsif p_duplicate_intake_file_id is not null then
    raise exception 'review_duplicate_pair: dismissed pairs have no duplicate target'
      using errcode = '22023';
  end if;

  insert into public.duplicate_reviews (
    left_intake_file_id,
    right_intake_file_id,
    decision,
    duplicate_intake_file_id,
    distance,
    actor
  )
  values (
    v_left,
    v_right,
    p_decision,
    p_duplicate_intake_file_id,
    p_distance,
    p_actor
  )
  on conflict (left_intake_file_id, right_intake_file_id)
  do update set
    decision = excluded.decision,
    duplicate_intake_file_id = excluded.duplicate_intake_file_id,
    distance = excluded.distance,
    actor = excluded.actor,
    reviewed_at = now()
  returning id into v_review_id;

  if p_decision = 'duplicate' then
    update public.intake_files
       set status           = 'duplicate',
           lease_token      = null,
           lease_expires_at = null
     where id = p_duplicate_intake_file_id;
  end if;

  insert into public.events (entity_type, entity_id, event, detail, actor)
  values (
    'duplicate_review',
    v_review_id,
    'duplicate.reviewed',
    jsonb_build_object(
      'left_intake_file_id', v_left,
      'right_intake_file_id', v_right,
      'decision', p_decision,
      'duplicate_intake_file_id', p_duplicate_intake_file_id,
      'distance', p_distance
    ),
    p_actor
  );

  return v_review_id;
end;
$$;

create or replace function public.claim_shopify_reconciliation(
  p_actor         text,
  p_lease_seconds integer default 900
)
returns table (
  run_id      uuid,
  lease_token uuid,
  owned       boolean
)
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
as $$
declare
  v_active public.shopify_reconciliation_runs%rowtype;
  v_id     uuid;
  v_token  uuid;
begin
  if p_actor is null or btrim(p_actor) = '' then
    raise exception 'claim_shopify_reconciliation: p_actor is required'
      using errcode = '22023';
  end if;
  if p_lease_seconds < 30 or p_lease_seconds > 3600 then
    raise exception 'claim_shopify_reconciliation: lease must be 30..3600 seconds'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtext('loupe-shopify-reconciliation'));

  select r.* into v_active
    from public.shopify_reconciliation_runs as r
   where r.status = 'running'
   for update;

  if found and v_active.lease_expires_at > now() then
    return query select v_active.id, null::uuid, false;
    return;
  end if;

  if found then
    update public.shopify_reconciliation_runs
       set status           = 'failed',
           lease_token      = null,
           lease_expires_at = null,
           completed_at     = now(),
           error            = 'The reconciliation worker lease expired before completion.'
     where id = v_active.id;

    insert into public.events (entity_type, entity_id, event, detail, actor)
    values (
      'shopify_reconciliation',
      v_active.id,
      'shopify.reconciliation_failed',
      jsonb_build_object('reason', 'lease_expired'),
      'reconciliation-sweeper'
    );
  end if;

  v_token := gen_random_uuid();
  insert into public.shopify_reconciliation_runs (
    status,
    started_by,
    lease_token,
    lease_expires_at
  )
  values ('running', p_actor, v_token, now() + make_interval(secs => p_lease_seconds))
  returning id into v_id;

  insert into public.events (entity_type, entity_id, event, detail, actor)
  values (
    'shopify_reconciliation',
    v_id,
    'shopify.reconciliation_started',
    jsonb_build_object('lease_seconds', p_lease_seconds),
    p_actor
  );

  return query select v_id, v_token, true;
end;
$$;

create or replace function public.assert_shopify_reconciliation_lease(
  p_run_id      uuid,
  p_lease_token uuid
)
returns boolean
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select exists (
    select 1
      from public.shopify_reconciliation_runs as r
     where r.id = p_run_id
       and r.status = 'running'
       and r.lease_token = p_lease_token
       and r.lease_expires_at > now()
  );
$$;

create or replace function public.complete_shopify_reconciliation(
  p_run_id         uuid,
  p_lease_token    uuid,
  p_total_products integer,
  p_issues         jsonb,
  p_source         text
)
returns table (
  total_products   integer,
  matched_products integer,
  issue_count      integer
)
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
as $$
declare
  v_issue_count integer;
  v_affected    integer;
begin
  if p_total_products < 0 then
    raise exception 'complete_shopify_reconciliation: total must be non-negative'
      using errcode = '22023';
  end if;
  if jsonb_typeof(p_issues) <> 'array' then
    raise exception 'complete_shopify_reconciliation: p_issues must be an array'
      using errcode = '22023';
  end if;
  if not public.assert_shopify_reconciliation_lease(p_run_id, p_lease_token) then
    raise exception 'complete_shopify_reconciliation: stale lease for %', p_run_id
      using errcode = '55000';
  end if;

  insert into public.shopify_reconciliation_issues (
    run_id,
    product_draft_id,
    shopify_product_id,
    code,
    field,
    expected,
    actual,
    message
  )
  select
    p_run_id,
    (item->>'productDraftId')::uuid,
    nullif(item->>'shopifyProductId', ''),
    item->>'code',
    item->>'field',
    coalesce(item->'expected', 'null'::jsonb),
    coalesce(item->'actual', 'null'::jsonb),
    item->>'message'
  from jsonb_array_elements(p_issues) as issue(item);

  get diagnostics v_issue_count = row_count;

  select count(distinct i.product_draft_id)::integer
    into v_affected
    from public.shopify_reconciliation_issues as i
   where i.run_id = p_run_id;

  update public.shopify_reconciliation_runs
     set status           = 'completed',
         lease_token      = null,
         lease_expires_at = null,
         completed_at     = now(),
         total_products   = p_total_products,
         matched_products = greatest(0, p_total_products - v_affected),
         issue_count      = v_issue_count,
         error            = null
   where id = p_run_id;

  insert into public.events (entity_type, entity_id, event, detail, actor)
  values (
    'shopify_reconciliation',
    p_run_id,
    'shopify.reconciliation_completed',
    jsonb_build_object(
      'total_products', p_total_products,
      'matched_products', greatest(0, p_total_products - v_affected),
      'issue_count', v_issue_count
    ),
    p_source
  );

  return query
    select p_total_products, greatest(0, p_total_products - v_affected), v_issue_count;
end;
$$;

create or replace function public.fail_shopify_reconciliation(
  p_run_id      uuid,
  p_lease_token uuid,
  p_error       text,
  p_source      text
)
returns public.shopify_reconciliation_status
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
as $$
begin
  if p_error is null or btrim(p_error) = '' then
    raise exception 'fail_shopify_reconciliation: p_error is required'
      using errcode = '22023';
  end if;
  if not public.assert_shopify_reconciliation_lease(p_run_id, p_lease_token) then
    raise exception 'fail_shopify_reconciliation: stale lease for %', p_run_id
      using errcode = '55000';
  end if;

  update public.shopify_reconciliation_runs
     set status           = 'failed',
         lease_token      = null,
         lease_expires_at = null,
         completed_at     = now(),
         error            = left(p_error, 2000)
   where id = p_run_id;

  insert into public.events (entity_type, entity_id, event, detail, actor)
  values (
    'shopify_reconciliation',
    p_run_id,
    'shopify.reconciliation_failed',
    jsonb_build_object('error', left(p_error, 500)),
    p_source
  );

  return 'failed'::public.shopify_reconciliation_status;
end;
$$;

alter table public.duplicate_reviews enable row level security;
alter table public.shopify_reconciliation_runs enable row level security;
alter table public.shopify_reconciliation_issues enable row level security;

revoke all on table public.duplicate_reviews from public, anon, authenticated;
revoke all on table public.shopify_reconciliation_runs from public, anon, authenticated;
revoke all on table public.shopify_reconciliation_issues from public, anon, authenticated;
grant select, insert, update, delete on table public.duplicate_reviews to service_role;
grant select, insert, update, delete on table public.shopify_reconciliation_runs to service_role;
grant select, insert, update, delete on table public.shopify_reconciliation_issues to service_role;
grant usage, select on sequence public.shopify_reconciliation_issues_id_seq to service_role;

revoke all on function public.store_intake_phash(uuid, uuid, text, text)
  from public, anon, authenticated;
revoke all on function public.retry_intake_file(uuid, text)
  from public, anon, authenticated;
revoke all on function public.skip_intake_file(uuid, text)
  from public, anon, authenticated;
revoke all on function public.review_duplicate_pair(
  uuid, uuid, public.duplicate_review_decision, uuid, integer, text
) from public, anon, authenticated;
revoke all on function public.claim_shopify_reconciliation(text, integer)
  from public, anon, authenticated;
revoke all on function public.assert_shopify_reconciliation_lease(uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.complete_shopify_reconciliation(uuid, uuid, integer, jsonb, text)
  from public, anon, authenticated;
revoke all on function public.fail_shopify_reconciliation(uuid, uuid, text, text)
  from public, anon, authenticated;

grant execute on function public.store_intake_phash(uuid, uuid, text, text) to service_role;
grant execute on function public.retry_intake_file(uuid, text) to service_role;
grant execute on function public.skip_intake_file(uuid, text) to service_role;
grant execute on function public.review_duplicate_pair(
  uuid, uuid, public.duplicate_review_decision, uuid, integer, text
) to service_role;
grant execute on function public.claim_shopify_reconciliation(text, integer) to service_role;
grant execute on function public.assert_shopify_reconciliation_lease(uuid, uuid) to service_role;
grant execute on function public.complete_shopify_reconciliation(uuid, uuid, integer, jsonb, text)
  to service_role;
grant execute on function public.fail_shopify_reconciliation(uuid, uuid, text, text)
  to service_role;

comment on function public.claim_shopify_reconciliation(text, integer) is
  'Single-run leased admission for daily/manual Shopify read-only reconciliation. An overlap receives the active run id but no ownership token.';
