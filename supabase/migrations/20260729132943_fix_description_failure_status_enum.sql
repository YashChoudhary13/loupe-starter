-- RETURNS TABLE also exposes "status" as a PL/pgSQL text-like variable. Type
-- both CASE branches explicitly so the assignment remains an intake_status.
do $migration$
declare
  v_signature regprocedure :=
    'public.record_description_failure(uuid,uuid,text,text,text,text)'::regprocedure;
  v_definition text;
  v_rewritten text;
begin
  select pg_get_functiondef(v_signature)
    into v_definition;

  v_rewritten := replace(
    v_definition,
    'status                   = case when v_proceed then ''enhancing'' else ''discovered'' end,',
    'status                   = case
           when v_proceed then ''enhancing''::public.intake_status
           else ''discovered''::public.intake_status
         end,'
  );

  if v_rewritten <> v_definition then
    execute v_rewritten;
  end if;
end
$migration$;
