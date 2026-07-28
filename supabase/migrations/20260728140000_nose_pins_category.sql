-- Loupe · Phase 2 · 15 — Nose Pins, and a nullable Shopify tag
--
-- The live store uses prefix `NP` for Nose Pins with title pattern `Nose Pin {n}`.
-- The prefix and the pattern are confirmed. The TAG IS NOT.
--
-- Every other category's tag was read off a live product. Nobody has read one off
-- a live Nose Pin. Collections are tag-driven, so an invented tag ('nose-pin'?
-- 'Nose Pins'? 'nosepin'?) would publish the product successfully and drop it
-- silently out of its collection — the single worst failure mode this project has,
-- because it looks like success.
--
-- So the tag is NULL, which required relaxing NOT NULL on categories.shopify_tag,
-- and public.reserve_draft_identity() refuses to reserve an identity for a
-- category whose tag is null. Filling the tag in makes the category work with no
-- code change and no migration.

alter table public.categories
  alter column shopify_tag drop not null;

-- The existing CHECK (length(btrim(shopify_tag)) > 0) still holds: it evaluates to
-- NULL for a NULL tag, and Postgres only rejects a CHECK that evaluates to FALSE.
-- So NULL means "not yet known" and '' is still rejected. That distinction is the
-- whole point — do not "tidy" this by defaulting the column to ''.

comment on column public.categories.shopify_tag is
  'The tag as it appears on the LIVE store, inconsistent casing and all. NULL means the tag has not been confirmed yet — publish is blocked for that category rather than guessing. Never invent one: collections are tag-driven and a wrong tag fails silently.';

insert into public.categories
  (name, sku_prefix, title_pattern, shopify_tag, default_weight_g, default_stock, sort_order)
values
  ('Nose Pins', 'NP', 'Nose Pin {n}', null, null, 0, 70)
on conflict (sku_prefix) do update
  set name          = excluded.name,
      title_pattern = excluded.title_pattern,
      sort_order    = excluded.sort_order;
-- shopify_tag is deliberately NOT in the DO UPDATE list. Once a human confirms
-- the real tag and sets it, re-running this migration must not wipe it back to
-- NULL. Same reasoning as default_weight_g in the Phase 1 seed.

insert into public.sku_counters (sku_prefix, last_number)
values ('NP', 0)
on conflict (sku_prefix) do nothing;  -- never reset a counter that is already live

insert into public.events (entity_type, event, detail, actor)
select 'system', 'seed.category_np', jsonb_build_object(
         'sku_prefix', 'NP',
         'title_pattern', 'Nose Pin {n}',
         'shopify_tag', null,
         'note', 'Tag unconfirmed. Publish is blocked for NP until a human reads the tag off a live Nose Pin.'
       ), 'migration:20260728140000'
where not exists (
  select 1 from public.events
   where entity_type = 'system' and event = 'seed.category_np'
);
