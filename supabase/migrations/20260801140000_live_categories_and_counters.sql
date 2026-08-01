-- Categories and SKU maxima extracted from the LIVE store (qimati.in),
-- 2026-08-01, from its public products.json — 2,664 products.
--
-- ⚠️ THE LIVE MAX SKU IS NOT THE HIGHEST SKU NUMBER IN THE CATALOGUE.
--
-- Three SKUs are typos, and each product's own TITLE proves it:
--
--     NK7801  ->  "Necklace 801"                 (extra 7)
--     BK3367  ->  "Bracelet Kada 337 (Small)"    (extra 3)
--     AK0834  ->  "Anklets 084 (Single Piece)"   (trailing 4)
--
-- Seeding NK from the raw maximum would have started the next necklace at
-- NK7802 — permanently, since the counter is monotone and D2 forbids lowering
-- it. The numbers below are the true sequence maxima with those three excluded.
-- Anyone re-running `seed:counters` against the live store must apply the same
-- correction; the Shopify Admin API reports the typo'd values too.
--
-- Counters are raised through public.raise_sku_counter(), which is monotone
-- (greatest(last_number, p_to)). It can never lower a counter, so this is safe
-- to re-run and safe to apply before the Phase 7 cutover.

-- ---------------------------------------------------------------------------
-- 1. Nose Pins: the tag is confirmed at last
-- ---------------------------------------------------------------------------
-- D23 left shopify_tag NULL because nobody had read one off a live Nose Pin,
-- and publish has refused the category ever since. All 20 live Nose Pins carry
-- exactly one category tag: NP. Filling it in makes the category work with no
-- code change, exactly as D23 anticipated.

update public.categories
   set shopify_tag = 'NP'
 where sku_prefix = 'NP'
   and shopify_tag is null;

-- ---------------------------------------------------------------------------
-- 2. Categories that exist on the live store but not in Loupe
-- ---------------------------------------------------------------------------
-- Only categories whose tag is unanimous across every live product of that
-- prefix are added here. Tags drive collections, so an invented one publishes
-- successfully and drops the product out of its collection silently (D23) —
-- the worst failure mode this project has. The remaining live prefixes
-- (S, BG, JB, CR, ST, FL, ND, KC, AS, BR) are recorded in docs/PROGRESS.md as
-- open questions rather than guessed at.
--
-- default_weight_g is 0 for the same reason as every other category: Qimati
-- uses fixed shipping rates, so weight does not participate (D19).

insert into public.categories
  (name, sku_prefix, title_pattern, shopify_tag, default_weight_g, default_stock, sort_order, active)
values
  ('Watches',           'WH',  'Watch {n}',               'watch',      0, 0, 80, true),
  ('Hand Chains',       'HC',  'Hand Chain {n}',          'Hand Chain', 0, 0, 90, true),
  ('Indian Jewellery',  'INJ', 'Indian Pendant Sets {n}', 'INJ',        0, 0, 100, true),
  ('Hair Accessories',  'HA',  'Hairband {n}',            'HA',         0, 0, 110, true)
on conflict (sku_prefix) do nothing;

insert into public.sku_counters (sku_prefix, last_number)
select c.sku_prefix, 0
  from public.categories as c
 where c.sku_prefix in ('WH', 'HC', 'INJ', 'HA')
on conflict (sku_prefix) do nothing;

-- ---------------------------------------------------------------------------
-- 3. Raise every counter to the live sequence maximum
-- ---------------------------------------------------------------------------
-- Monotone: raise_sku_counter never lowers, so a counter already ahead of the
-- live store (the test store's own numbering) is left alone.

select public.raise_sku_counter('NK',  975);   -- typo NK7801 excluded
select public.raise_sku_counter('ER',  459);
select public.raise_sku_counter('CB',  374);
select public.raise_sku_counter('BK',  362);   -- typo BK3367 excluded
select public.raise_sku_counter('RS',  227);
select public.raise_sku_counter('AK',   87);   -- typo AK0834 excluded
select public.raise_sku_counter('WH',   70);
select public.raise_sku_counter('HC',   43);
select public.raise_sku_counter('INJ',  35);
select public.raise_sku_counter('HA',   12);
select public.raise_sku_counter('NP',    5);
