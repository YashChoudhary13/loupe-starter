-- The accepted prompt becomes a preset in its own right.
--
-- The picker offered four alternatives and no way back. The live pair carried no
-- preset_slug, so nothing showed as "in use" and an operator who tried marble had
-- no button that returned them to the prompt the catalogue was actually built on.
--
-- It is NOT marble. The accepted background is ivory-champagne satin with soft
-- folds; marble is a different surface that was added beside it. Both belong in
-- the list.
--
-- The two live rows are TAGGED rather than copied. Copying would create a second
-- body that has to be kept byte-identical to the accepted one forever, and the
-- first time the two drifted the preset would quietly stop being the thing it
-- claims to be. Tagging cannot drift.

update public.prompts
   set preset_slug = 'satin'
 where is_default
   and archived_at is null
   and preset_slug is null
   and kind in ('describe', 'image');

-- Both halves must exist or promote_prompt_preset() refuses the slug, which is
-- the guard doing its job — but it would be discovered by an operator rather
-- than here. There is exactly one live default per kind (prompts_one_live_default_per_kind),
-- so this is two rows or the assumption behind the update is wrong.
do $migration$
declare
  v_kinds integer;
begin
  select count(distinct kind) into v_kinds
    from public.prompts
   where preset_slug = 'satin';

  if v_kinds <> 2 then
    raise exception
      'default-as-preset: expected a describe half and an image half, tagged % kind(s)', v_kinds;
  end if;
end
$migration$;
