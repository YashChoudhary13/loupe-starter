-- Loupe · Phase 3B — durable two-call enhancement
--
-- The describer result belongs to the intake item and is cached there. Generated
-- image rows retain the exact resolved prompt and whether the cached description
-- was injected, so the true/false A/B is queryable after the fact.

create type public.prompt_kind as enum ('describe', 'image');

alter table public.prompts
  add column kind public.prompt_kind;

update public.prompts
   set kind = 'image'
 where kind is null;

alter table public.prompts
  alter column kind set not null;

drop index if exists public.prompts_one_live_default;

create unique index prompts_one_live_default_per_kind
  on public.prompts (kind)
  where is_default and archived_at is null;

create index prompts_live_kind_idx
  on public.prompts (kind, created_at desc)
  where archived_at is null;

comment on column public.prompts.kind is
  'Prompt stage. There is one live default describe prompt and one live default image prompt.';

alter table public.intake_files
  add column product_description text,
  add column description_model text,
  add column described_at timestamptz,
  add column description_cost_usd numeric(12, 6),
  add column description_error text,
  add column description_error_code text,
  add column description_error_detail text,
  add column description_missing_at timestamptz;

alter table public.intake_files
  add constraint intake_files_description_is_complete check (
    (
      product_description is null
      and description_model is null
      and described_at is null
      and description_cost_usd is null
    )
    or (
      length(btrim(product_description)) > 0
      and length(btrim(description_model)) > 0
      and described_at is not null
      and description_cost_usd is not null
      and description_cost_usd >= 0
    )
  ),
  add constraint intake_files_description_missing_has_no_text check (
    description_missing_at is null or product_description is null
  );

comment on column public.intake_files.product_description is
  'Cached factual jewellery description. It describes the source piece, so every image redo reuses it without another model call.';
comment on column public.intake_files.description_model is
  'Exact resolved model slug that produced product_description.';
comment on column public.intake_files.described_at is
  'When the cached description was stored.';
comment on column public.intake_files.description_cost_usd is
  'Actual OpenRouter usage.cost for the successful describe call, kept at 6 decimal places.';
comment on column public.intake_files.description_missing_at is
  'Set when five bounded describe attempts are exhausted. Image generation then degrades without a PRODUCT block instead of failing the file.';

alter table public.image_versions
  alter column cost_usd type numeric(12, 6),
  add column description_injected boolean,
  add column description_missing boolean;

alter table public.image_versions
  drop constraint image_versions_original_is_pristine,
  drop constraint image_versions_generated_is_attributed;

alter table public.image_versions
  add constraint image_versions_original_is_pristine check (
    kind <> 'original'
    or (
      prompt_text is null
      and model is null
      and cost_usd is null
      and parent_version_id is null
      and description_injected is null
      and description_missing is null
    )
  ),
  add constraint image_versions_generated_is_attributed check (
    kind <> 'generated'
    or (
      prompt_text is not null
      and model is not null
      and cost_usd is not null
      and description_injected is not null
      and description_missing is not null
      and not (description_injected and description_missing)
    )
  );

comment on column public.image_versions.description_injected is
  'For generated rows, true only when product_description replaced {{PRODUCT_DESCRIPTION}} in the exact prompt_text sent to the image model.';
comment on column public.image_versions.description_missing is
  'For generated rows, true only when bounded describe attempts were exhausted and image generation proceeded without the PRODUCT block.';

-- Retire every older live prompt as immutable history, then install the two
-- amendment bodies byte-for-byte as the only live defaults of their kinds.
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
- Output the description only. No preamble, no explanation, no closing remark.$describe$;
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

COMPOSITION — square framing, product centred, occupying roughly 70–75% of the frame with
even margins and clean negative space. Eye-level or very slightly elevated camera angle,
straight-on frontal presentation. Preserve the angle and orientation of the piece as
photographed — do not reposition, rotate or restage it. Keep this framing identical for
every product.

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
   where archived_at is null;

  insert into public.prompts (name, body, kind, is_default, created_by)
  values (
    'Qimati jewellery factual describer',
    v_describe_body,
    'describe',
    true,
    'business:phase-3b-amendment'
  )
  returning id into v_describe_id;

  insert into public.prompts (name, body, kind, is_default, created_by)
  values (
    'Qimati ivory-champagne catalogue — described product',
    v_image_body,
    'image',
    true,
    'business:phase-3b-amendment'
  )
  returning id into v_image_id;

  insert into public.events (entity_type, entity_id, event, detail, actor)
  values
    (
      'prompt',
      v_describe_id,
      'prompt.default_seeded',
      jsonb_build_object('kind', 'describe', 'body_is_verbatim', true),
      'migration:20260729132000'
    ),
    (
      'prompt',
      v_image_id,
      'prompt.default_seeded',
      jsonb_build_object(
        'kind', 'image',
        'body_is_verbatim', true,
        'product_description_token', '{{PRODUCT_DESCRIPTION}}',
        'metal_colours_excluded_from_negatives', false
      ),
      'migration:20260729132000'
    );
end
$migration$;

-- The claim return shape grows to include the cached description state. Drop is
-- required because PostgreSQL cannot replace a function with a new row shape.
drop function public.claim_intake_file(integer);

create function public.claim_intake_file(
  p_lease_seconds integer default 900
)
returns table (
  id                       uuid,
  drive_file_id            text,
  filename                 text,
  drive_md5                text,
  bytes                    bigint,
  mime_type                text,
  status                   public.intake_status,
  attempts                 integer,
  lease_token              uuid,
  lease_expires_at         timestamptz,
  product_description      text,
  description_model        text,
  described_at             timestamptz,
  description_cost_usd     numeric,
  description_missing_at   timestamptz
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
      'description_missing', v_file.description_missing_at is not null
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
    v_file.description_model,
    v_file.described_at,
    v_file.description_cost_usd,
    v_file.description_missing_at;
end;
$$;

comment on function public.claim_intake_file(integer) is
  'Claims one due intake row with SKIP LOCKED and a UUID ownership token, returning its cached description state so redo and image retries make zero duplicate describe calls.';

create function public.assert_intake_lease(
  p_intake_file_id uuid,
  p_lease_token uuid
)
returns boolean
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select exists (
    select 1
      from public.intake_files as f
     where f.id = p_intake_file_id
       and f.status = 'enhancing'
       and f.lease_token = p_lease_token
       and f.lease_expires_at > now()
  );
$$;

comment on function public.assert_intake_lease(uuid, uuid) is
  'Read-only fencing check used immediately before every external write. False means the worker must discard its result.';

create function public.store_intake_description(
  p_intake_file_id uuid,
  p_lease_token uuid,
  p_description text,
  p_model text,
  p_cost_usd numeric,
  p_source text default 'enhancement-worker'
)
returns table (
  id uuid,
  product_description text,
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
       set product_description      = btrim(p_description),
           description_model        = btrim(p_model),
           described_at             = now(),
           description_cost_usd     = p_cost_usd,
           description_error        = null,
           description_error_code   = null,
           description_error_detail = null,
           description_missing_at   = null,
           last_error                = case
             when f.last_error_code like 'description_%' then null else f.last_error
           end,
           last_error_code           = case
             when f.last_error_code like 'description_%' then null else f.last_error_code
           end,
           last_error_detail         = case
             when f.last_error_code like 'description_%' then null else f.last_error_detail
           end,
           error_class               = case
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
        'word_count', cardinality(regexp_split_to_array(v_file.product_description, '\s+'))
      ),
      p_source
    );
  end if;

  return query
  select
    v_file.id,
    v_file.product_description,
    v_file.description_model,
    v_file.described_at,
    v_file.description_cost_usd;
end;
$$;

comment on function public.store_intake_description(uuid, uuid, text, text, numeric, text) is
  'Fenced, write-once description cache. Records the exact model and actual cost; a stale worker changes nothing.';

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
  proceed_without_description boolean
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
  v_proceed := v_attempts >= 5;
  v_next_attempt := case v_attempts
    when 1 then now() + interval '1 minute'
    when 2 then now() + interval '5 minutes'
    when 3 then now() + interval '20 minutes'
    when 4 then now() + interval '1 hour'
    else now()
  end;

  update public.intake_files as f
     set status                   = case
           when v_proceed then 'enhancing'::public.intake_status
           else 'discovered'::public.intake_status
         end,
         attempts                 = v_attempts,
         next_attempt_at          = v_next_attempt,
         lease_token              = case when v_proceed then f.lease_token else null end,
         lease_expires_at         = case when v_proceed then f.lease_expires_at else null end,
         description_error        = v_error,
         description_error_code   = p_error_code,
         description_error_detail = p_error_detail,
         description_missing_at   = case when v_proceed then now() else null end,
         last_error                = case when v_proceed then f.last_error else v_error end,
         last_error_code           = case when v_proceed then f.last_error_code else p_error_code end,
         last_error_detail         = case when v_proceed then f.last_error_detail else p_error_detail end,
         error_class               = case when v_proceed then f.error_class else 'retryable' end
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
      'proceed_without_description', v_proceed
    )),
    p_source
  );

  return query
  select
    v_file.id,
    v_file.status,
    v_file.attempts,
    v_file.next_attempt_at,
    v_proceed;
end;
$$;

comment on function public.record_description_failure(uuid, uuid, text, text, text, text) is
  'Fenced describe failure path. Attempts 1–4 use the existing 1m/5m/20m/1h backoff; attempt 5 records the missing description and deliberately keeps the lease so image generation can degrade instead of failing the file.';

create function public.complete_intake_enhancement(
  p_intake_file_id uuid,
  p_lease_token uuid,
  p_original_storage_key text,
  p_original_width integer,
  p_original_height integer,
  p_generated_storage_key text,
  p_thumb_key text,
  p_generated_width integer,
  p_generated_height integer,
  p_model text,
  p_prompt_text text,
  p_cost_usd numeric,
  p_max_cost_usd numeric,
  p_description_injected boolean,
  p_description_missing boolean,
  p_source text default 'enhancement-worker'
)
returns table (
  id uuid,
  status public.intake_status,
  attempts integer,
  image_version_id uuid,
  version_no integer,
  cost_usd numeric
)
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
as $$
declare
  v_file public.intake_files%rowtype;
  v_original public.image_versions%rowtype;
  v_generated public.image_versions%rowtype;
  v_attempts integer;
  v_status public.intake_status;
  v_cost_error text;
begin
  if p_original_storage_key is null or btrim(p_original_storage_key) = ''
     or p_generated_storage_key is null or btrim(p_generated_storage_key) = ''
     or p_thumb_key is null or btrim(p_thumb_key) = ''
     or p_model is null or btrim(p_model) = ''
     or p_prompt_text is null or btrim(p_prompt_text) = ''
  then
    raise exception 'complete_intake_enhancement: storage keys, model and prompt must not be empty'
      using errcode = '22023';
  end if;
  if p_original_width <= 0 or p_original_height <= 0
     or p_generated_width <= 0 or p_generated_height <= 0
  then
    raise exception 'complete_intake_enhancement: dimensions must be positive'
      using errcode = '22023';
  end if;
  if p_cost_usd is null or p_cost_usd < 0
     or p_max_cost_usd is null or p_max_cost_usd <= 0
  then
    raise exception 'complete_intake_enhancement: costs must be non-negative and ceiling positive'
      using errcode = '22023';
  end if;
  if p_description_injected is null or p_description_missing is null
     or (p_description_injected and p_description_missing)
  then
    raise exception 'complete_intake_enhancement: invalid description audit flags'
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
    raise exception 'complete_intake_enhancement: lease for intake_file % is no longer current',
      coalesce(p_intake_file_id::text, '<null>')
      using errcode = '55000',
            hint = 'Discard this stale worker result; another worker may now own the row.';
  end if;

  insert into public.image_versions (
    intake_file_id,
    version_no,
    kind,
    storage_key,
    width,
    height,
    is_selected
  )
  values (
    p_intake_file_id,
    0,
    'original',
    btrim(p_original_storage_key),
    p_original_width,
    p_original_height,
    false
  )
  on conflict on constraint image_versions_intake_file_id_version_no_key do nothing
  returning * into v_original;

  if not found then
    select iv.*
      into v_original
      from public.image_versions as iv
     where iv.intake_file_id = p_intake_file_id
       and iv.version_no = 0;

    if v_original.kind <> 'original'
       or v_original.storage_key <> btrim(p_original_storage_key)
       or v_original.width <> p_original_width
       or v_original.height <> p_original_height
    then
      raise exception 'complete_intake_enhancement: immutable original row conflicts for intake_file %',
        p_intake_file_id using errcode = '23505';
    end if;
  end if;

  v_status := case when p_cost_usd > p_max_cost_usd then 'failed' else 'enhanced' end;

  insert into public.image_versions (
    intake_file_id,
    version_no,
    kind,
    storage_key,
    thumb_key,
    width,
    height,
    prompt_text,
    model,
    cost_usd,
    parent_version_id,
    is_selected,
    description_injected,
    description_missing
  )
  values (
    p_intake_file_id,
    1,
    'generated',
    btrim(p_generated_storage_key),
    btrim(p_thumb_key),
    p_generated_width,
    p_generated_height,
    p_prompt_text,
    btrim(p_model),
    p_cost_usd,
    v_original.id,
    v_status = 'enhanced',
    p_description_injected,
    p_description_missing
  )
  on conflict on constraint image_versions_intake_file_id_version_no_key do nothing
  returning * into v_generated;

  if not found then
    select iv.*
      into v_generated
      from public.image_versions as iv
     where iv.intake_file_id = p_intake_file_id
       and iv.version_no = 1;

    if v_generated.kind <> 'generated'
       or v_generated.storage_key <> btrim(p_generated_storage_key)
       or v_generated.thumb_key <> btrim(p_thumb_key)
       or v_generated.width <> p_generated_width
       or v_generated.height <> p_generated_height
       or v_generated.prompt_text <> p_prompt_text
       or v_generated.model <> btrim(p_model)
       or v_generated.cost_usd <> p_cost_usd
       or v_generated.description_injected is distinct from p_description_injected
       or v_generated.description_missing is distinct from p_description_missing
    then
      raise exception 'complete_intake_enhancement: generated version 1 conflicts for intake_file %',
        p_intake_file_id using errcode = '23505';
    end if;
  end if;

  v_attempts := case
    when v_file.description_missing_at is not null and v_file.attempts >= 5
      then v_file.attempts
    else least(5, v_file.attempts + 1)
  end;

  if v_status = 'failed' then
    v_cost_error := format(
      'Image generation cost $%s exceeded the $%s per-image ceiling. The version was retained for review and will not be retried.',
      p_cost_usd,
      p_max_cost_usd
    );
  end if;

  update public.intake_files as f
     set status            = v_status,
         attempts          = v_attempts,
         enhanced_at       = case when v_status = 'enhanced' then now() else f.enhanced_at end,
         last_error        = v_cost_error,
         last_error_code   = case when v_status = 'failed' then 'image_cost_ceiling_exceeded' else null end,
         last_error_detail = case when v_status = 'failed' then jsonb_build_object(
           'actual_cost_usd', p_cost_usd,
           'max_cost_usd', p_max_cost_usd,
           'image_version_id', v_generated.id
         )::text else null end,
         error_class       = case
           when v_status = 'failed' then 'permanent'::public.error_class
           else null
         end,
         lease_token       = null,
         lease_expires_at  = null,
         next_attempt_at   = now()
   where f.id = p_intake_file_id
     and f.lease_token = p_lease_token;

  if not found then
    raise exception 'complete_intake_enhancement: lease for intake_file % changed during completion',
      p_intake_file_id using errcode = '40001';
  end if;

  insert into public.events (entity_type, entity_id, event, detail, actor)
  values (
    'image_version',
    v_generated.id,
    'image.generated',
    jsonb_build_object(
      'intake_file_id', p_intake_file_id,
      'version_no', 1,
      'storage_key', v_generated.storage_key,
      'thumb_key', v_generated.thumb_key,
      'width', v_generated.width,
      'height', v_generated.height,
      'model', v_generated.model,
      'cost_usd', v_generated.cost_usd,
      'description_injected', v_generated.description_injected,
      'description_missing', v_generated.description_missing,
      'selected', v_generated.is_selected
    ),
    p_source
  );

  insert into public.events (entity_type, entity_id, event, detail, actor)
  values (
    'intake_file',
    p_intake_file_id,
    case when v_status = 'enhanced' then 'intake.enhanced' else 'intake.failed' end,
    jsonb_strip_nulls(jsonb_build_object(
      'image_version_id', v_generated.id,
      'attempts', v_attempts,
      'cost_usd', p_cost_usd,
      'max_cost_usd', p_max_cost_usd,
      'error', v_cost_error,
      'error_code', case when v_status = 'failed' then 'image_cost_ceiling_exceeded' else null end
    )),
    p_source
  );

  return query
  select
    p_intake_file_id,
    v_status,
    v_attempts,
    v_generated.id,
    v_generated.version_no,
    v_generated.cost_usd;
end;
$$;

comment on function public.complete_intake_enhancement(
  uuid, uuid, text, integer, integer, text, text, integer, integer, text, text,
  numeric, numeric, boolean, boolean, text
) is
  'Fenced Phase 3B completion. Idempotently records immutable original v0 and generated v1, stores the exact resolved prompt and description audit flags, then marks enhanced or permanently fails above the actual-cost ceiling.';

revoke all on function public.claim_intake_file(integer)
  from public, anon, authenticated;
revoke all on function public.assert_intake_lease(uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.store_intake_description(uuid, uuid, text, text, numeric, text)
  from public, anon, authenticated;
revoke all on function public.record_description_failure(uuid, uuid, text, text, text, text)
  from public, anon, authenticated;
revoke all on function public.complete_intake_enhancement(
  uuid, uuid, text, integer, integer, text, text, integer, integer, text, text,
  numeric, numeric, boolean, boolean, text
) from public, anon, authenticated;

grant execute on function public.claim_intake_file(integer)
  to service_role;
grant execute on function public.assert_intake_lease(uuid, uuid)
  to service_role;
grant execute on function public.store_intake_description(uuid, uuid, text, text, numeric, text)
  to service_role;
grant execute on function public.record_description_failure(uuid, uuid, text, text, text, text)
  to service_role;
grant execute on function public.complete_intake_enhancement(
  uuid, uuid, text, integer, integer, text, text, integer, integer, text, text,
  numeric, numeric, boolean, boolean, text
) to service_role;
