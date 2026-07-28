-- Loupe · Phase 1 · 12 — seed
--
-- Idempotent: safe to re-run. Values verified against the live store and
-- recorded in CLAUDE.md. Do NOT add the eight TBD categories (Watches, Hand
-- Chains, Nose Pins, Jewellery Box, Bags, Hair Accessories, Indian Jewellery,
-- Brass) — their prefix, title pattern and tag are unconfirmed, and an invented
-- prefix would start a sequence that has to be unpicked later.

-- The tags below look inconsistent because they ARE inconsistent in the live
-- store: `cb` and `anklets` lowercase, `Necklace` and `Rings` capitalised.
-- Collections are tag-driven. A tidier tag silently drops the product out of
-- its collection. Match exactly.
insert into public.categories
  (name, sku_prefix, title_pattern, shopify_tag, default_weight_g, default_stock, sort_order)
values
  ('Necklaces',        'NK', 'Necklace {n}',                'Necklace', null, 0, 10),
  ('Earrings',         'ER', 'Earrings {n}',                'earrings', null, 0, 20),
  ('Kada Bracelets',   'BK', 'Bracelet Kada {n}',           'kada',     null, 0, 30),
  ('Chain Bracelets',  'CB', 'Chain Bracelet {n}',          'cb',       null, 0, 40),
  ('Rings',            'RS', 'Rings {n}',                   'Rings',    null, 0, 50),
  ('Anklets',          'AK', 'Anklets {n} (Single Piece)',  'anklets',  null, 0, 60)
on conflict (sku_prefix) do update
  set name             = excluded.name,
      title_pattern    = excluded.title_pattern,
      shopify_tag      = excluded.shopify_tag,
      sort_order       = excluded.sort_order;
-- default_weight_g and default_stock are deliberately NOT overwritten on
-- conflict: once Phase 2 sets real values, re-running this seed must not wipe them.

-- Every counter starts at 0 and every one of them is WRONG until Phase 2.
--
-- TODO(phase-2): set last_number to the TRUE MAX per prefix, taken from the
-- Shopify products CSV: split SKU into letters + digits and take MAX(digits) per
-- prefix. Use the MAX, NOT the row count — the live sequences have gaps
-- (RS218, RS220 and RS222 are all missing, and RS221 is used twice).
-- Publishing before this is done will re-issue SKUs that already exist.
insert into public.sku_counters (sku_prefix, last_number)
select sku_prefix, 0 from public.categories
on conflict (sku_prefix) do nothing;  -- never reset a counter that is already live

-- Exactly three, fixed. Written to a Shopify metafield; the six description
-- bullets render from the theme template (docs/DECISIONS.md D6).
insert into public.materials (name, sort_order) values
  ('304',   10),
  ('316L',  20),
  ('Brass', 30)
on conflict (name) do update set sort_order = excluded.sort_order;

-- Guarded so re-running this migration does not append a second identical
-- audit row. events is append-only; that is a reason to be careful about what
-- gets appended, not a reason to append twice.
insert into public.events (entity_type, event, detail, actor)
select 'system', 'seed.domain_data', jsonb_build_object(
         'categories', 6, 'materials', 3, 'sku_counters_at', 0,
         'note', 'Counters are placeholders. Phase 2 must set the true max per prefix.'
       ), 'migration:20260728121100'
where not exists (
  select 1 from public.events
   where entity_type = 'system' and event = 'seed.domain_data'
);
