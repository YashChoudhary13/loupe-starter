-- Loupe · Phase 2 · 17 — 0 g becomes a deliberate value; NULL still means unknown
--
-- Phase 2 originally blocked publish on an unknown weight, and every
-- categories.default_weight_g was NULL, so nothing could publish at all. On the
-- test store that is friction with no upside: real per-category grams are a
-- business fact nobody has collected yet, and waiting for them blocks the entire
-- Shopify write path.
--
-- So the semantics split in two, and the distinction is the whole point:
--
--   NULL  →  "nobody has said."     Publish is BLOCKED. The guard stays.
--   0     →  "someone said zero."   Publish proceeds and writes 0 g.
--
-- Setting the defaults to 0 is therefore a decision that was made, not a gap that
-- was ignored — and it is recoverable, because a category that is later given a
-- real weight simply starts publishing it.
--
-- ⚠️ 0 g RECREATES A KNOWN LIVE-STORE BUG IF IT SHIPS. Every variant in the live
-- catalogue weighs 0, which is exactly why weight-based shipping does not work
-- there. This is acceptable on the `qimti` test store and is NOT acceptable at
-- cutover. Real per-category grams are on the blocking list in docs/PROGRESS.md.
-- See docs/DECISIONS.md D19.
--
-- The CHECKs are relaxed from `> 0` to `>= 0` rather than dropped: a negative
-- weight is still nonsense, and NULL still has to be expressible or the
-- "nobody has said" state disappears.

alter table public.categories
  drop constraint categories_default_weight_g_check;
alter table public.categories
  add constraint categories_default_weight_g_check
  check (default_weight_g is null or default_weight_g >= 0);

alter table public.product_drafts
  drop constraint product_drafts_weight_g_check;
alter table public.product_drafts
  add constraint product_drafts_weight_g_check
  check (weight_g is null or weight_g >= 0);

comment on column public.categories.default_weight_g is
  'Grams. NULL means "nobody has said" and BLOCKS publish; 0 means "someone said zero" and publishes as 0 g. Currently 0 for every category as a deliberate placeholder so the test store can publish — replace with real grams before the live cutover, because 0 g is the live catalogue''s existing shipping bug. See docs/DECISIONS.md D19.';

comment on column public.product_drafts.weight_g is
  'Grams for this product specifically. NULL falls back to categories.default_weight_g. Same NULL-vs-0 distinction: NULL is unknown, 0 is deliberate.';

-- Only fills the gap. A category that already carries a real weight is left alone,
-- so re-running this migration after someone sets NK to 25 g does not wipe it.
update public.categories
   set default_weight_g = 0
 where default_weight_g is null;

insert into public.events (entity_type, event, detail, actor)
select 'system', 'seed.default_weights_zeroed', jsonb_build_object(
         'set_to', 0,
         'categories', (select count(*) from public.categories),
         'note', 'Deliberate placeholder so the test store can publish. 0 g reproduces the live store''s weight-based-shipping bug and MUST be replaced with real per-category grams before cutover.'
       ), 'migration:20260729100000'
where not exists (
  select 1 from public.events
   where entity_type = 'system' and event = 'seed.default_weights_zeroed'
);
