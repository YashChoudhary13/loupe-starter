-- CASE expressions are resolved before assignment casts. Explicitly type the
-- permanent branch as the error_class enum so successful completion can assign
-- NULL without PostgreSQL first resolving the expression to text.
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
    'error_class       = case when v_status = ''failed'' then ''permanent'' else null end,',
    'error_class       = case
           when v_status = ''failed'' then ''permanent''::public.error_class
           else null
         end,'
  );

  if v_rewritten <> v_definition then
    execute v_rewritten;
  end if;
end
$migration$;
