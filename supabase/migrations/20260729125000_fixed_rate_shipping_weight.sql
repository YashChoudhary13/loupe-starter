-- Qimati uses fixed shipping rates. Variant weight does not participate in
-- shipping, so 0 g is the correct catalogue value rather than a placeholder.
-- NULL remains a distinct "nobody has said" state and continues to block publish.

comment on column public.categories.default_weight_g is
  'Grams written to Shopify. Qimati uses fixed shipping rates, so 0 g is the correct category default. NULL remains expressible and means "nobody has said", which blocks publish. See docs/DECISIONS.md D19.';

comment on column public.product_drafts.weight_g is
  'Optional product-specific grams. NULL falls back to categories.default_weight_g; if both are NULL publish blocks. Qimati uses fixed shipping rates, so a resolved 0 g is correct.';

insert into public.events (entity_type, event, detail, actor)
select
  'system',
  'catalog.shipping_weight_confirmed',
  jsonb_build_object(
    'shipping_rate_mode', 'fixed',
    'default_weight_g', 0,
    'null_semantics', 'unknown_and_blocks_publish',
    'note', 'Qimati uses fixed shipping rates; 0 g is the correct value and is not a cutover blocker.'
  ),
  'migration:20260729125000'
where not exists (
  select 1
    from public.events
   where entity_type = 'system'
     and event = 'catalog.shipping_weight_confirmed'
);
