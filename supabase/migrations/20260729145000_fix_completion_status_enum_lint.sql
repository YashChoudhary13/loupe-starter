-- plpgsql_check does not apply assignment casts while analysing CASE branches.
-- Type both outcomes explicitly so the live completion function is lint-clean.
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
    'v_status := case when p_cost_usd > p_max_cost_usd then ''failed'' else ''enhanced'' end;',
    'v_status := case
    when p_cost_usd > p_max_cost_usd then ''failed''::public.intake_status
    else ''enhanced''::public.intake_status
  end;'
  );

  if v_rewritten = v_definition then
    raise exception 'completion status assignment did not match the expected function body';
  end if;

  execute v_rewritten;
end
$migration$;
