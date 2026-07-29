-- A successful but over-budget description is a configuration fault, not a
-- transient provider failure. Degrade immediately so one bad reasoning setting
-- cannot spend the same overage five times. Because that failure already counts
-- the current processing attempt, image completion must not increment it again.

create or replace function public.record_description_failure(
  p_intake_file_id uuid,
  p_lease_token uuid,
  p_error text,
  p_error_code text,
  p_error_detail text default null,
  p_source text default 'enhancement-worker'
)
returns table (
  id uuid,
  status public.intake_status,
  attempts integer,
  next_attempt_at timestamptz,
  proceed_without_description boolean
)
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
as $$
declare
  v_file public.intake_files%rowtype;
  v_attempts integer;
  v_error text;
  v_next_attempt timestamptz;
  v_cost_ceiling boolean;
  v_proceed boolean;
begin
  select f.*
    into v_file
    from public.intake_files as f
   where f.id = p_intake_file_id
     and f.status = 'enhancing'
     and f.lease_token = p_lease_token
     and f.lease_expires_at > now()
     for update;

  if not found then
    raise exception 'record_description_failure: lease for intake_file % is no longer current',
      coalesce(p_intake_file_id::text, '<null>')
      using errcode = '55000',
            hint = 'Discard this stale worker result; another worker may now own the row.';
  end if;

  v_attempts := least(5, v_file.attempts + 1);
  v_error := left(
    coalesce(nullif(btrim(p_error), ''), 'The jewellery description could not be generated.'),
    4000
  );
  v_cost_ceiling := p_error_code = 'description_cost_ceiling_exceeded';
  v_proceed := v_cost_ceiling or v_attempts >= 5;
  v_next_attempt := case
    when v_proceed then now()
    when v_attempts = 1 then now() + interval '1 minute'
    when v_attempts = 2 then now() + interval '5 minutes'
    when v_attempts = 3 then now() + interval '20 minutes'
    when v_attempts = 4 then now() + interval '1 hour'
  end;

  update public.intake_files as f
     set status                   = case
           when v_proceed then 'enhancing'::public.intake_status
           else 'discovered'::public.intake_status
         end,
         attempts                 = v_attempts,
         next_attempt_at          = v_next_attempt,
         lease_token              = case when v_proceed then f.lease_token else null end,
         lease_expires_at         = case when v_proceed then f.lease_expires_at else null end,
         description_error        = v_error,
         description_error_code   = p_error_code,
         description_error_detail = p_error_detail,
         description_missing_at   = case when v_proceed then now() else null end,
         last_error                = case when v_proceed then f.last_error else v_error end,
         last_error_code           = case when v_proceed then f.last_error_code else p_error_code end,
         last_error_detail         = case when v_proceed then f.last_error_detail else p_error_detail end,
         error_class               = case
           when v_proceed then f.error_class
           else 'retryable'::public.error_class
         end
   where f.id = p_intake_file_id
     and f.lease_token = p_lease_token
  returning f.* into v_file;

  insert into public.events (entity_type, entity_id, event, detail, actor)
  values (
    'intake_file',
    p_intake_file_id,
    case when v_proceed then 'description.missing' else 'description.retry_scheduled' end,
    jsonb_strip_nulls(jsonb_build_object(
      'error', v_error,
      'code', p_error_code,
      'raw_detail', p_error_detail,
      'attempts', v_attempts,
      'next_attempt_at', case when not v_proceed then v_next_attempt else null end,
      'proceed_without_description', v_proceed,
      'cost_ceiling_exceeded', v_cost_ceiling
    )),
    p_source
  );

  return query
  select
    v_file.id,
    v_file.status,
    v_file.attempts,
    v_file.next_attempt_at,
    v_proceed;
end;
$$;

comment on function public.record_description_failure(uuid, uuid, text, text, text, text) is
  'Fenced describe failure path. Transient attempts 1–4 use 1m/5m/20m/1h backoff; attempt 5 or a description cost ceiling breach records missing and keeps the lease so image generation degrades without another paid describe call.';

do $migration$
declare
  v_signature regprocedure :=
    'public.complete_intake_enhancement(uuid,uuid,text,integer,integer,text,text,integer,integer,text,text,numeric,numeric,boolean,boolean,text)'::regprocedure;
  v_definition text;
  v_rewritten text;
begin
  select pg_get_functiondef(v_signature)
    into v_definition;

  v_rewritten := replace(
    v_definition,
    'when v_file.description_missing_at is not null and v_file.attempts >= 5',
    'when v_file.description_missing_at is not null'
  );

  if v_rewritten = v_definition then
    raise exception 'description-missing attempt assignment did not match the expected completion body';
  end if;

  execute v_rewritten;
end
$migration$;
