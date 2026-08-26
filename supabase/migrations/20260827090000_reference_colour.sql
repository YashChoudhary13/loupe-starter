-- 2026-08-27: a small colour signature per reference, for colour-aware re-ranking.
-- SigLIP2 is nearly colour-blind (a green and a white piece of one design sit at
-- ~0.9 cosine, measured); this 15-bin foreground colour histogram lets search break
-- those near-ties by stone colour. Null until backfilled; search falls back to pure
-- cosine wherever it is null, so the column is safe to add before it is populated.
alter table public.match_references
  add column if not exists colour extensions.vector(15);

comment on column public.match_references.colour is
  'L1-normalised 15-bin foreground colour histogram (loupe_worker/colour.py): 12 hue bins + 3 achromatic value bins. Null = not yet computed; search falls back to cosine.';

-- Colour-blended search. p_alpha in [0,1]: 1.0 = pure cosine (identical to match_search),
-- lower gives colour more weight. Colour similarity is 1 - L2/sqrt(2) on the L1-normalised
-- histograms (both in [0,1]); when either side has no colour the blend degrades to cosine
-- for that reference, so a half-backfilled index still ranks sensibly.
create or replace function public.match_search_colour(
  p_embedding text,
  p_colour    text,
  p_limit     integer default 10,
  p_alpha     real    default 1.0
)
returns table (sku text, handle text, score real)
language sql
stable
set search_path = public, pg_temp
as $$
  with scored as (
    select r.sku,
           r.handle,
           (1 - (e.embedding operator(extensions.<=>) p_embedding::extensions.vector(1152)))::double precision as cos,
           case
             when p_colour is null or r.colour is null then null
             else 1 - (r.colour operator(extensions.<->) p_colour::extensions.vector(15))::double precision / 1.4142135623730951
           end as colour_sim
      from public.match_embeddings as e
      join public.match_references as r on r.id = e.reference_id
     where r.retired_at is null
       and r.status = 'indexed'
  ),
  blended as (
    select sku, handle, cos,
           case when colour_sim is null then cos
                else p_alpha * cos + (1 - p_alpha) * colour_sim end as score
      from scored
  )
  select sku,
         (array_agg(handle order by score desc))[1] as handle,
         max(score)::real as score
    from blended
   group by sku
   order by score desc
   limit p_limit;
$$;

comment on function public.match_search_colour(text, text, integer, real) is
  'Top SKUs for a query embedding, re-ranked by colour: p_alpha*cosine + (1-p_alpha)*colour_sim, max over views per SKU. p_alpha=1.0 is pure cosine. Falls back to cosine per reference wherever colour is absent (2026-08-27).';

revoke execute on function public.match_search_colour(text, text, integer, real) from public, anon, authenticated;
grant  execute on function public.match_search_colour(text, text, integer, real) to service_role;
