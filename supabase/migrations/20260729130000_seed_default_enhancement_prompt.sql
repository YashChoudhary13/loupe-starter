-- The business-approved enhancement prompt is configuration, not worker code.
-- Prompt history is append-only: retire a previous live default, then insert or
-- promote this exact body as the one live default.

do $migration$
declare
  v_body constant text := $prompt$Place the product on a soft ivory-white marble surface.
Warm luxury lighting with soft, natural shadows.
Shallow depth of field — background beautifully blurred, the product entirely in focus.
Natural gold reflections and diamond sparkle highlights where the material warrants them.

Preserve the product exactly as photographed. Chain links, stone count and facets,
engraving, clasps and settings must match the source image precisely. Do not add,
remove, restyle or embellish any part of the product itself.$prompt$;
  v_prompt_id uuid;
begin
  update public.prompts
     set is_default = false,
         archived_at = coalesce(archived_at, now())
   where is_default
     and archived_at is null
     and body <> v_body;

  select id
    into v_prompt_id
    from public.prompts
   where body = v_body
     and archived_at is null
   order by created_at desc
   limit 1;

  if v_prompt_id is null then
    insert into public.prompts (name, body, is_default, created_by)
    values (
      'Qimati ivory marble — product fidelity',
      v_body,
      true,
      'business:2026-07-29'
    )
    returning id into v_prompt_id;
  else
    update public.prompts
       set is_default = true
     where id = v_prompt_id;
  end if;

  insert into public.events (entity_type, entity_id, event, detail, actor)
  select
    'prompt',
    v_prompt_id,
    'prompt.default_seeded',
    jsonb_build_object(
      'name', 'Qimati ivory marble — product fidelity',
      'source', 'business-approved ChatGPT prompt',
      'resolution_in_parameters', true,
      'product_fidelity_added', true,
      'open_ended_enhancement_removed', true
    ),
    'migration:20260729130000'
  where not exists (
    select 1
      from public.events
     where entity_type = 'prompt'
       and entity_id = v_prompt_id
       and event = 'prompt.default_seeded'
  );
end
$migration$;
