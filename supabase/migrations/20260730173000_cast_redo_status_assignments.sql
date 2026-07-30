-- plpgsql_check correctly flags an implicit text-to-enum assignment even
-- though PostgreSQL executes it. Make both assignments explicit so database
-- lint stays clean.

do $migration$
declare
  v_definition text;
begin
  select pg_get_functiondef(
    'public.complete_image_redo(uuid,uuid,text,text,integer,integer,text,numeric,numeric,text)'::regprocedure
  )
  into v_definition;

  v_definition := replace(
    v_definition,
$old$when p_cost_usd > p_max_cost_usd then 'failed'
    else 'completed'$old$,
$new$when p_cost_usd > p_max_cost_usd then 'failed'::public.image_redo_status
    else 'completed'::public.image_redo_status$new$
  );
  if position('failed''::public.image_redo_status' in v_definition) = 0 then
    raise exception 'Could not patch complete_image_redo enum assignment';
  end if;
  execute v_definition;

  select pg_get_functiondef(
    'public.record_image_redo_failure(uuid,uuid,text,text,boolean,text)'::regprocedure
  )
  into v_definition;

  v_definition := replace(
    v_definition,
$old$v_status := case when v_retry then 'queued' else 'failed' end;$old$,
$new$v_status := case
    when v_retry then 'queued'::public.image_redo_status
    else 'failed'::public.image_redo_status
  end;$new$
  );
  if position('queued''::public.image_redo_status' in v_definition) = 0 then
    raise exception 'Could not patch record_image_redo_failure enum assignment';
  end if;
  execute v_definition;
end
$migration$;
