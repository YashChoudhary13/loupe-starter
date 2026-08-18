-- Loupe · D107 — an empty p_images no longer wipes a draft's images
--
-- 2026-08-17, production: drafts CB402 and CB406 were saved once each with
-- `image_count: 0` and went to Shopify as products with no pictures. The
-- console fills its image list from a preview round trip that races the first
-- save; a fast enough "Save draft" sends `p_images: []` while the database
-- already holds the correct group-time defaults from create_product_draft —
-- and the save's delete-what-was-not-sent step destroyed them.
--
-- The rule this installs: an empty p_images means "the client is not stating
-- an image selection", never "remove every image". There is no console path
-- that removes all images through save — removal goes through
-- detach_intake_file, which deletes the join rows itself. So an empty list can
-- only ever be client ignorance, and the safe interpretation is to leave the
-- rows alone.
--
-- The draft.saved event now records the images the draft actually holds after
-- the save rather than the length of what the client sent — image_count: 0
-- with surviving rows would read as this very bug during the next
-- investigation.
--
-- Same guarded live-definition patch as add_size_variants and
-- shopify_native_colour_swatches: each replacement fails closed if the
-- deployed function no longer contains the text it expects.

do $migration$
declare
  v_definition text;
  v_before     text;
begin
  select pg_get_functiondef(
    'public.save_product_draft(uuid,timestamptz,uuid,uuid,text,integer,integer,integer,text[],jsonb,text,text,text,text,jsonb)'::regprocedure
  ) into v_definition;

  v_before := v_definition;
  v_definition := replace(
    v_definition,
    $old$  delete from public.product_draft_images pdi
   where pdi.product_draft_id = p_draft_id
     and pdi.image_version_id not in (
       select (e->>'image_version_id')::uuid
         from jsonb_array_elements(coalesce(p_images, '[]'::jsonb)) e
     );
$old$,
    $new$  -- D107: an empty p_images means the client had not learned the images yet
  -- (the preview round trip races the first save), never "remove every image".
  -- The group-time defaults survive; removal goes through detach_intake_file.
  if jsonb_array_length(coalesce(p_images, '[]'::jsonb)) > 0 then

  delete from public.product_draft_images pdi
   where pdi.product_draft_id = p_draft_id
     and pdi.image_version_id not in (
       select (e->>'image_version_id')::uuid
         from jsonb_array_elements(coalesce(p_images, '[]'::jsonb)) e
     );
$new$
  );
  if v_definition = v_before then
    raise exception 'save_draft_keeps_images: could not find the image delete step';
  end if;

  v_before := v_definition;
  v_definition := replace(
    v_definition,
    $old$  on conflict (product_draft_id, image_version_id) do update
    set position = excluded.position,
        colour_id = excluded.colour_id;
$old$,
    $new$  on conflict (product_draft_id, image_version_id) do update
    set position = excluded.position,
        colour_id = excluded.colour_id;

  end if;
$new$
  );
  if v_definition = v_before then
    raise exception 'save_draft_keeps_images: could not find the image insert step';
  end if;

  v_before := v_definition;
  v_definition := replace(
    v_definition,
    $old$            'image_count', jsonb_array_length(coalesce(p_images, '[]'::jsonb)),
$old$,
    $new$            'image_count', (select count(*) from public.product_draft_images held
                              where held.product_draft_id = p_draft_id),
$new$
  );
  if v_definition = v_before then
    raise exception 'save_draft_keeps_images: could not find the image_count event detail';
  end if;

  execute v_definition;
end;
$migration$;

comment on function public.save_product_draft(
  uuid, timestamptz, uuid, uuid, text, integer, integer, integer, text[], jsonb, text, text, text, text, jsonb
) is
  'Persists the whole editor. An empty p_images leaves the draft''s existing images untouched (D107) — removal goes through detach_intake_file, so an empty list can only be a client that has not learned the images yet.';
