-- Originals are never purged.
--
-- D62 purged a photograph's original together with its generated versions seven
-- days after the product reached Shopify, on the assumption that Google Drive
-- /Processed kept the untouched file. Measured 2026-08-21: 82 of 238 drive files
-- are gone from Drive, 175 of 271 originals were already deleted from R2, and
-- upload-sourced photographs (D103) have no Drive copy at all. The original is
-- the only real photograph of the product — the reference the SKU matcher needs
-- (docs/LOUPE-INTEGRATION-PLAN.md §1.3) — so it is excluded from retention at
-- both ends: the candidate query never returns one, and the marker refuses one.
-- Generated versions and thumbnails keep purging exactly as before.

create or replace function public.retention_candidates(
  p_days  integer default 7,
  p_limit integer default 200
)
returns table (
  image_version_id uuid,
  intake_file_id   uuid,
  storage_key      text,
  thumb_key        text
)
language sql
stable
set search_path = public, pg_temp
as $$
  select iv.id, iv.intake_file_id, iv.storage_key, iv.thumb_key
    from public.image_versions as iv
    join public.intake_files   as f on f.id = iv.intake_file_id
    join public.product_drafts as d on d.id = f.product_draft_id
   where iv.purged_at is null
     and iv.kind <> 'original'
     and d.shopify_first_sent_at is not null
     and d.shopify_first_sent_at < now() - make_interval(days => p_days)
   order by d.shopify_first_sent_at
   limit p_limit;
$$;

comment on function public.retention_candidates(integer, integer) is
  'Generated image versions whose product reached Shopify more than p_days ago and whose R2 objects have not been purged. Originals are never candidates: the photographer''s file is the matcher''s reference and Drive /Processed proved unreliable (2026-08-21).';

create or replace function public.mark_versions_purged(
  p_image_version_ids uuid[],
  p_actor             text
)
returns integer
language plpgsql
volatile
set search_path = public, pg_temp
as $$
declare
  v_count integer;
begin
  if p_image_version_ids is null or array_length(p_image_version_ids, 1) is null then
    return 0;
  end if;

  -- An original is refused here as well as in the candidate query, so a stale
  -- deploy of the purge job cannot record an original as gone.
  update public.image_versions
     set purged_at = now()
   where id = any (p_image_version_ids)
     and purged_at is null
     and kind <> 'original';
  get diagnostics v_count = row_count;

  if v_count > 0 then
    insert into public.events (entity_type, entity_id, event, detail, actor)
    values (
      'system',
      null,
      'retention.purged',
      jsonb_build_object('image_versions', v_count),
      p_actor
    );
  end if;

  return v_count;
end;
$$;

comment on function public.mark_versions_purged(uuid[], text) is
  'Marks generated image_versions rows as having had their R2 objects deleted. Rows are kept (D5). Refuses kind = original: originals are never purged.';

revoke execute on function public.retention_candidates(integer, integer) from anon, authenticated;
revoke execute on function public.mark_versions_purged(uuid[], text) from anon, authenticated;
