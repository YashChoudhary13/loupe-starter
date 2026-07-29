-- PL/pgSQL exposes RETURNS TABLE columns as variables. The Phase 3B completion
-- function therefore needs to name the unique constraint explicitly: an
-- unqualified ON CONFLICT (... version_no) can be parsed as either the table
-- column or the output variable.
--
-- Fresh installs already receive the corrected function from the preceding
-- migration. Existing linked databases are repaired from their deployed
-- function definition without changing its signature, grants or behaviour.
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
    'on conflict (intake_file_id, version_no) do nothing',
    'on conflict on constraint image_versions_intake_file_id_version_no_key do nothing'
  );

  if v_rewritten <> v_definition then
    execute v_rewritten;
  end if;
end
$migration$;
