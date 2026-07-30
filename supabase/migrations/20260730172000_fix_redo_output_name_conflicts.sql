-- The deployed functions predate the source-level PL/pgSQL conflict directive.
-- Insert it into their existing definitions without changing signatures or
-- behaviour. Fresh databases already get the directive from 20260730170000.

do $migration$
declare
  v_function regprocedure;
  v_definition text;
begin
  foreach v_function in array array[
    'public.complete_image_redo(uuid,uuid,text,text,integer,integer,text,numeric,numeric,text)'::regprocedure,
    'public.record_image_redo_failure(uuid,uuid,text,text,boolean,text)'::regprocedure
  ]
  loop
    select pg_get_functiondef(v_function) into v_definition;
    if position('#variable_conflict use_column' in v_definition) = 0 then
      v_definition := replace(
        v_definition,
        E'AS $function$\n',
        E'AS $function$\n#variable_conflict use_column\n'
      );
      if position('#variable_conflict use_column' in v_definition) = 0 then
        raise exception 'Could not patch PL/pgSQL conflict directive for %', v_function;
      end if;
      execute v_definition;
    end if;
  end loop;
end
$migration$;
