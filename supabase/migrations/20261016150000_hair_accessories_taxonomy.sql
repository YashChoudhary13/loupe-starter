-- Loupe · Hair accessories draft with the native Color option (D153)
--
-- Shopify's `shopify.color-pattern` category metafield is constrained to 10,897
-- taxonomy categories. Hair Bands (aa-2-14-13) is not one of them, so a coloured
-- HA draft is refused the way coloured watches were before D147. Its parent,
-- Hair Accessories (aa-2-14), is in the list, takes the same Color option, and
-- names what the category sells (hairbands, clutchers, clips). Read from the
-- live definition's constraints and proved with scripts/verify-hair-colour-live.ts
-- on 2026-10-16.
update public.categories
   set shopify_taxonomy_category_id = 'gid://shopify/TaxonomyCategory/aa-2-14' -- Hair Accessories
 where sku_prefix = 'HA'
   and shopify_taxonomy_category_id = 'gid://shopify/TaxonomyCategory/aa-2-14-13';
