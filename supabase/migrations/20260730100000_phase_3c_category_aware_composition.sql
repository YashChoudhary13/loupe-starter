-- Loupe · Phase 3C — bounded category-aware composition
--
-- The describe call now returns one factual paragraph plus one member of a
-- closed presentation vocabulary. Application code owns every resulting word
-- of composition prose. The presentation class is not a product category.

create type public.presentation_class as enum (
  'pair-upright',
  'flat-curve',
  'standing-three-quarter',
  'angled-band',
  'flat-arc',
  'tray-grid'
);

alter table public.intake_files
  add column presentation_class public.presentation_class,
  add column presentation_fallback boolean not null default false,
  add column presentation_fallback_reason text;

alter table public.intake_files
  add constraint intake_files_presentation_audit_is_consistent check (
    (
      presentation_class is null
      and not presentation_fallback
      and presentation_fallback_reason is null
    )
    or (
      presentation_class is not null
      and (
        (
          not presentation_fallback
          and presentation_fallback_reason is null
        )
        or (
          presentation_fallback
          and presentation_class = 'flat-curve'::public.presentation_class
          and length(btrim(presentation_fallback_reason)) > 0
        )
      )
    )
  );

comment on column public.intake_files.presentation_class is
  'Closed staging vocabulary selected by the describe call. It is not a Shopify product category and never controls SKU, title, tag or collection.';
comment on column public.intake_files.presentation_fallback is
  'True only when application code supplied flat-curve because no valid structured presentation was available.';
comment on column public.intake_files.presentation_fallback_reason is
  'Queryable reason for the deterministic flat-curve fallback. NULL means presentation_class came from valid structured model output.';

-- Prompt history remains append-only. Retire the Phase 3B defaults and insert
-- one new version of each kind.
do $migration$
declare
  v_describe_body constant text := $describe$You are describing a piece of jewellery for a product catalogue.

Describe ONLY the jewellery in this photograph. The photo may show the piece on a retail
display card, held in a hand, inside packaging, or on a cluttered surface — ignore all of
that completely.

Cover, in this order: the item type; whether it is a single piece or a matching pair; the
metal colour and finish; the overall form and silhouette; any stones — their type, cut,
colour, and how they are set and arranged; the chain or band construction; clasps, bezels,
prongs or other fittings; and any texture, engraving or distinguishing feature.

Rules:
- 60 to 100 words. One paragraph. No bullet points, no headings.
- Plain factual description only. No adjectives about beauty, quality, luxury or value.
- Do NOT state exact counts of stones, links or components. Describe density and
  arrangement instead — "densely set pavé across the oval face", not "twelve stones".
- Do not mention the background, packaging, card, hand, lighting or photography.
- If a detail is not clearly visible, omit it. Never guess or invent.
- Output the description only. No preamble, no explanation, no closing remark.

Then choose exactly ONE presentation class for this piece from this list:

  pair-upright            a matched pair (earrings, studs)
  flat-curve              necklaces and long chains
  standing-three-quarter  rings
  angled-band             kadas, bangles, cuffs, rigid bracelets
  flat-arc                chain bracelets, anklets, flexible bracelets
  tray-grid               a set, tray or card holding multiple separate items

Return ONLY a JSON object, nothing else:
{"description": "<the paragraph above>", "presentation": "<one class from the list>"}$describe$;
  v_image_body constant text := $image$A single hero product photograph for an e-commerce jewellery catalogue.

PRODUCT
{{PRODUCT_DESCRIPTION}}

SUBJECT — the jewellery item only. The source photograph may show the piece attached to a
display card, held in a hand, inside packaging, or on a cluttered surface. Remove all of
it: cards, backing, tags, price stickers, plastic, hands and fingers, and any text, logo or
branding that is not physically part of the jewellery. Present the piece as though
photographed on its own. Where the item is a pair, show both, evenly spaced and
symmetrically arranged side by side at the same scale and height — balanced, not
mechanically duplicated.

BACKGROUND — soft ivory-champagne satin with gentle natural folds, warm in tone, strongly
out of focus so the folds read as texture rather than pattern. Monochromatic ivory, cream
and warm beige palette. Smooth creamy bokeh, no hard lines. No props, no flowers, no vases,
no risers, no boxes, nothing touching the jewellery.

LIGHTING — warm luxury studio lighting: a large diffused key from the upper left and front,
gentle warm fill from the front right, restrained rim light to separate polished edges from
the background. Natural warm-gold reflections rather than flat yellow metal. Crisp,
controlled specular points on faceted stones — no starbursts, no glitter, no blown
highlights, no lens flare.

SHADOWS — one soft, realistic contact shadow directly beneath and slightly behind the
piece, anchoring it to the surface. Diffused and light. No harsh black shadows, no floating
objects, no dramatic contrast.

COMPOSITION — square framing, product centred, occupying roughly 70–75% of the frame
with even margins and clean negative space. Eye-level or very slightly elevated camera
angle. Keep this framing identical for every product.
{{COMPOSITION_DETAIL}}

CAMERA — premium macro product photography with the visual character of an 85–100mm macro
lens. The piece completely sharp front to back with crisp micro-detail; the background
transitioning rapidly into shallow depth of field. Clean high-end commercial retouching,
realistic optical depth, accurate textures. The result must look like a real photograph —
not a 3D render, illustration, painting or AI image.

FIDELITY — this outranks everything above, and applies to the jewellery itself. Reproduce
the piece exactly as photographed: form, proportion, stone shape and placement, setting
style, chain or band construction, clasps, bezels, prongs, engraving, texture and plating
colour must all match the source. Do not add sparkle, stones, links, engraving or
decoration that is not present. Do not remove, straighten, lengthen, resize or restyle any
part of it. Where a detail is unclear in the source, reproduce it as-is rather than
inventing it. Only the surroundings may change.

DO NOT INCLUDE — hands, fingers, skin, ears, people, models, mannequins, display cards,
packaging, price tags, labels, text, logos, watermarks, borders, frames, stands, clips,
wires, props touching the jewellery, extra or missing pieces, mismatched pairs, altered
design, distorted proportions, bent or melted metal, duplicated components, floating
jewellery, harsh shadows, dark backgrounds, cool blue lighting, oversaturated yellow,
excessive bloom, excessive sparkle, star filters, motion blur, soft product focus, noise,
grain, chromatic artifacts, plastic-looking materials, CGI or cartoon styling.$image$;
  v_describe_id uuid;
  v_image_id uuid;
begin
  update public.prompts
     set is_default = false,
         archived_at = coalesce(archived_at, now())
   where is_default
     and archived_at is null
     and kind in ('describe', 'image');

  insert into public.prompts (name, body, kind, is_default, created_by)
  values (
    'Qimati factual describer — bounded presentation',
    v_describe_body,
    'describe',
    true,
    'business:phase-3c-amendment'
  )
  returning id into v_describe_id;

  insert into public.prompts (name, body, kind, is_default, created_by)
  values (
    'Qimati ivory-champagne catalogue — category-aware composition',
    v_image_body,
    'image',
    true,
    'business:phase-3c-amendment'
  )
  returning id into v_image_id;

  insert into public.events (entity_type, entity_id, event, detail, actor)
  values
    (
      'prompt',
      v_describe_id,
      'prompt.default_replaced',
      jsonb_build_object(
        'kind', 'describe',
        'structured_output', true,
        'presentation_vocabulary', jsonb_build_array(
          'pair-upright',
          'flat-curve',
          'standing-three-quarter',
          'angled-band',
          'flat-arc',
          'tray-grid'
        ),
        'third_model_call', false,
        'free_form_composition', false
      ),
      'migration:20260730100000'
    ),
    (
      'prompt',
      v_image_id,
      'prompt.default_replaced',
      jsonb_build_object(
        'kind', 'image',
        'product_description_token', '{{PRODUCT_DESCRIPTION}}',
        'composition_detail_token', '{{COMPOSITION_DETAIL}}',
        'composition_prose_owner', 'application',
        'fidelity_block_unchanged', true
      ),
      'migration:20260730100000'
    );
end
$migration$;

-- The claim return shape grows to include the presentation cache and audit
-- state. PostgreSQL cannot replace a function with a different row shape.
drop function public.claim_intake_file(integer);

create function public.claim_intake_file(
  p_lease_seconds integer default 900
)
returns table (
  id                            uuid,
  drive_file_id                 text,
  filename                      text,
  drive_md5                     text,
  bytes                         bigint,
  mime_type                     text,
  status                        public.intake_status,
  attempts                      integer,
  lease_token                   uuid,
  lease_expires_at              timestamptz,
  product_description           text,
  presentation_class            public.presentation_class,
  presentation_fallback         boolean,
  presentation_fallback_reason  text,
  description_model             text,
  described_at                  timestamptz,
  description_cost_usd          numeric,
  description_missing_at        timestamptz
)
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
as $$
declare
  v_file public.intake_files%rowtype;
  v_lease_token uuid := gen_random_uuid();
begin
  if p_lease_seconds is null or p_lease_seconds <= 0 then
    raise exception 'claim_intake_file: p_lease_seconds must be positive, got %',
      coalesce(p_lease_seconds::text, '<null>') using errcode = '22023';
  end if;

  with candidate as (
    select f.id
      from public.intake_files as f
     where f.status = 'discovered'
       and f.next_attempt_at <= now()
     order by f.next_attempt_at, f.discovered_at, f.id
     limit 1
       for update skip locked
  )
  update public.intake_files as f
     set status           = 'enhancing',
         lease_token      = v_lease_token,
         lease_expires_at = now() + make_interval(secs => p_lease_seconds)
    from candidate as c
   where f.id = c.id
  returning f.* into v_file;

  if not found then
    return;
  end if;

  insert into public.events (entity_type, entity_id, event, detail)
  values (
    'intake_file',
    v_file.id,
    'intake.claimed',
    jsonb_build_object(
      'attempts_completed', v_file.attempts,
      'lease_token', v_file.lease_token,
      'lease_expires_at', v_file.lease_expires_at,
      'description_cached', v_file.product_description is not null,
      'description_missing', v_file.description_missing_at is not null,
      'presentation_class', v_file.presentation_class,
      'presentation_fallback', v_file.presentation_fallback,
      'presentation_fallback_reason', v_file.presentation_fallback_reason
    )
  );

  return query
  select
    v_file.id,
    v_file.drive_file_id,
    v_file.filename,
    v_file.drive_md5,
    v_file.bytes,
    v_file.mime_type,
    v_file.status,
    v_file.attempts,
    v_file.lease_token,
    v_file.lease_expires_at,
    v_file.product_description,
    v_file.presentation_class,
    v_file.presentation_fallback,
    v_file.presentation_fallback_reason,
    v_file.description_model,
    v_file.described_at,
    v_file.description_cost_usd,
    v_file.description_missing_at;
end;
$$;

comment on function public.claim_intake_file(integer) is
  'Claims one due intake row with SKIP LOCKED and UUID ownership, returning cached description and presentation state so retry/redo makes zero duplicate describe calls.';

drop function public.store_intake_description(uuid, uuid, text, text, numeric, text);

create function public.store_intake_description(
  p_intake_file_id uuid,
  p_lease_token uuid,
  p_description text,
  p_presentation_class public.presentation_class,
  p_model text,
  p_cost_usd numeric,
  p_source text default 'enhancement-worker'
)
returns table (
  id uuid,
  product_description text,
  presentation_class public.presentation_class,
  presentation_fallback boolean,
  presentation_fallback_reason text,
  description_model text,
  described_at timestamptz,
  description_cost_usd numeric
)
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
as $$
declare
  v_file public.intake_files%rowtype;
begin
  if p_description is null or btrim(p_description) = '' then
    raise exception 'store_intake_description: description must not be empty'
      using errcode = '22023';
  end if;
  if p_presentation_class is null then
    raise exception 'store_intake_description: presentation class must not be empty'
      using errcode = '22023';
  end if;
  if p_model is null or btrim(p_model) = '' then
    raise exception 'store_intake_description: model must not be empty'
      using errcode = '22023';
  end if;
  if p_cost_usd is null or p_cost_usd < 0 then
    raise exception 'store_intake_description: cost must be a non-negative number'
      using errcode = '22023';
  end if;

  select f.*
    into v_file
    from public.intake_files as f
   where f.id = p_intake_file_id
     and f.status = 'enhancing'
     and f.lease_token = p_lease_token
     and f.lease_expires_at > now()
     for update;

  if not found then
    raise exception 'store_intake_description: lease for intake_file % is no longer current',
      coalesce(p_intake_file_id::text, '<null>')
      using errcode = '55000',
            hint = 'Discard this stale worker result; another worker may now own the row.';
  end if;

  if v_file.product_description is null then
    update public.intake_files as f
       set product_description           = btrim(p_description),
           presentation_class            = p_presentation_class,
           presentation_fallback         = false,
           presentation_fallback_reason  = null,
           description_model             = btrim(p_model),
           described_at                  = now(),
           description_cost_usd          = p_cost_usd,
           description_error             = null,
           description_error_code        = null,
           description_error_detail      = null,
           description_missing_at        = null,
           last_error                    = case
             when f.last_error_code like 'description_%' then null else f.last_error
           end,
           last_error_code               = case
             when f.last_error_code like 'description_%' then null else f.last_error_code
           end,
           last_error_detail             = case
             when f.last_error_code like 'description_%' then null else f.last_error_detail
           end,
           error_class                   = case
             when f.last_error_code like 'description_%' then null else f.error_class
           end
     where f.id = p_intake_file_id
       and f.lease_token = p_lease_token
    returning f.* into v_file;

    insert into public.events (entity_type, entity_id, event, detail, actor)
    values (
      'intake_file',
      p_intake_file_id,
      'description.stored',
      jsonb_build_object(
        'model', v_file.description_model,
        'cost_usd', v_file.description_cost_usd,
        'word_count', cardinality(regexp_split_to_array(v_file.product_description, '\s+')),
        'presentation_class', v_file.presentation_class,
        'presentation_source', 'model',
        'free_form_composition_accepted', false
      ),
      p_source
    );
  elsif v_file.presentation_class is null then
    raise exception 'store_intake_description: legacy cached description for intake_file % has no presentation class',
      p_intake_file_id
      using errcode = '55000',
            hint = 'Use ensure_intake_presentation_fallback with legacy_missing_presentation_class; do not make a paid describe call.';
  end if;

  return query
  select
    v_file.id,
    v_file.product_description,
    v_file.presentation_class,
    v_file.presentation_fallback,
    v_file.presentation_fallback_reason,
    v_file.description_model,
    v_file.described_at,
    v_file.description_cost_usd;
end;
$$;

comment on function public.store_intake_description(
  uuid, uuid, text, public.presentation_class, text, numeric, text
) is
  'Fenced, write-once structured describe cache. Stores only a valid enum selected by the model; application-owned composition prose never enters this function.';

create function public.ensure_intake_presentation_fallback(
  p_intake_file_id uuid,
  p_lease_token uuid,
  p_reason text,
  p_source text default 'enhancement-worker'
)
returns table (
  id uuid,
  presentation_class public.presentation_class,
  presentation_fallback boolean,
  presentation_fallback_reason text
)
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
as $$
declare
  v_file public.intake_files%rowtype;
begin
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'ensure_intake_presentation_fallback: reason must not be empty'
      using errcode = '22023';
  end if;

  select f.*
    into v_file
    from public.intake_files as f
   where f.id = p_intake_file_id
     and f.status = 'enhancing'
     and f.lease_token = p_lease_token
     and f.lease_expires_at > now()
     for update;

  if not found then
    raise exception 'ensure_intake_presentation_fallback: lease for intake_file % is no longer current',
      coalesce(p_intake_file_id::text, '<null>')
      using errcode = '55000',
            hint = 'Discard this stale worker result; another worker may now own the row.';
  end if;

  if v_file.presentation_class is null then
    update public.intake_files as f
       set presentation_class           = 'flat-curve'::public.presentation_class,
           presentation_fallback        = true,
           presentation_fallback_reason = left(btrim(p_reason), 200)
     where f.id = p_intake_file_id
       and f.lease_token = p_lease_token
    returning f.* into v_file;

    insert into public.events (entity_type, entity_id, event, detail, actor)
    values (
      'intake_file',
      p_intake_file_id,
      'presentation.fallback',
      jsonb_build_object(
        'presentation_class', v_file.presentation_class,
        'fallback', true,
        'reason', v_file.presentation_fallback_reason,
        'model_composition_prose_accepted', false
      ),
      p_source
    );
  end if;

  return query
  select
    v_file.id,
    v_file.presentation_class,
    v_file.presentation_fallback,
    v_file.presentation_fallback_reason;
end;
$$;

comment on function public.ensure_intake_presentation_fallback(uuid, uuid, text, text) is
  'Fenced, write-once compatibility/fallback path. Uses only flat-curve and records a queryable reason without making a describe call.';

drop function public.record_description_failure(uuid, uuid, text, text, text, text);

create function public.record_description_failure(
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
  proceed_without_description boolean,
  presentation_class public.presentation_class,
  presentation_fallback boolean,
  presentation_fallback_reason text
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
     set status                       = case
           when v_proceed then 'enhancing'::public.intake_status
           else 'discovered'::public.intake_status
         end,
         attempts                     = v_attempts,
         next_attempt_at              = v_next_attempt,
         lease_token                  = case when v_proceed then f.lease_token else null end,
         lease_expires_at             = case when v_proceed then f.lease_expires_at else null end,
         description_error            = v_error,
         description_error_code       = p_error_code,
         description_error_detail     = p_error_detail,
         description_missing_at       = case when v_proceed then now() else null end,
         presentation_class           = case
           when v_proceed and f.presentation_class is null
             then 'flat-curve'::public.presentation_class
           else f.presentation_class
         end,
         presentation_fallback        = case
           when v_proceed and f.presentation_class is null then true
           else f.presentation_fallback
         end,
         presentation_fallback_reason = case
           when v_proceed and f.presentation_class is null
             then left(coalesce(nullif(btrim(p_error_code), ''), 'description_failed'), 200)
           else f.presentation_fallback_reason
         end,
         last_error                    = case when v_proceed then f.last_error else v_error end,
         last_error_code               = case when v_proceed then f.last_error_code else p_error_code end,
         last_error_detail             = case when v_proceed then f.last_error_detail else p_error_detail end,
         error_class                   = case
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
      'cost_ceiling_exceeded', v_cost_ceiling,
      'presentation_class', case when v_proceed then v_file.presentation_class else null end,
      'presentation_fallback', case when v_proceed then v_file.presentation_fallback else null end,
      'presentation_fallback_reason', case
        when v_proceed then v_file.presentation_fallback_reason else null
      end,
      'model_composition_prose_accepted', false
    )),
    p_source
  );

  return query
  select
    v_file.id,
    v_file.status,
    v_file.attempts,
    v_file.next_attempt_at,
    v_proceed,
    v_file.presentation_class,
    v_file.presentation_fallback,
    v_file.presentation_fallback_reason;
end;
$$;

comment on function public.record_description_failure(uuid, uuid, text, text, text, text) is
  'Fenced structured-describe failure path. Attempts 1–4 retain existing backoff; attempt 5 or a cost breach degrades to queryable flat-curve fallback and keeps the lease for image generation.';

revoke all on function public.claim_intake_file(integer)
  from public, anon, authenticated;
revoke all on function public.store_intake_description(
  uuid, uuid, text, public.presentation_class, text, numeric, text
) from public, anon, authenticated;
revoke all on function public.ensure_intake_presentation_fallback(uuid, uuid, text, text)
  from public, anon, authenticated;
revoke all on function public.record_description_failure(uuid, uuid, text, text, text, text)
  from public, anon, authenticated;

grant execute on function public.claim_intake_file(integer)
  to service_role;
grant execute on function public.store_intake_description(
  uuid, uuid, text, public.presentation_class, text, numeric, text
) to service_role;
grant execute on function public.ensure_intake_presentation_fallback(uuid, uuid, text, text)
  to service_role;
grant execute on function public.record_description_failure(uuid, uuid, text, text, text, text)
  to service_role;
