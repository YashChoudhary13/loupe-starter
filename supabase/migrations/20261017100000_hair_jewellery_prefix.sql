-- Loupe · Hair accessories become Hair Jewellery, SKU prefix HA → HJ (D155)
--
-- Owner, 2026-10-17: the hair category (titles "Hairband {n}", SKU HA) is
-- renamed Hair Jewellery with prefix HJ. The Shopify tag stays `HA`: the
-- storefront collection Hair Claw Clips (handle hair-accessories) selects
-- TAG = HA, and the Clutchers CR002–CR011 carry that tag too, so a tidier tag
-- would empty the collection (D23). The taxonomy id stays Hair Accessories
-- (D153).
--
-- Every SKU text Loupe holds moves with the prefix in this one transaction so
-- the published identity still parses: sku_counters follows by ON UPDATE
-- CASCADE; the 17 drafts HA013–HA029 (Shopify DRAFT products of 2026-10-16),
-- the HA012 restock references and the matcher's references are rewritten
-- here. Shopify itself is renamed straight after by
-- scripts/rename-hair-jewellery.ts, which refuses to write before this has
-- applied (the daily reconciliation reads each draft by its Loupe handle).

do $$
begin
  if exists (select 1 from public.freed_skus where sku_prefix = 'HA') then
    raise exception 'freed_skus still holds HA numbers; its foreign key does not cascade';
  end if;
  if exists (select 1 from public.categories where sku_prefix = 'HJ') then
    raise exception 'a category with prefix HJ already exists';
  end if;
end $$;

update public.categories
   set name          = 'Hair Jewellery',
       sku_prefix    = 'HJ',
       title_pattern = 'Hair Jewellery {n}'
 where sku_prefix = 'HA';

update public.product_drafts
   set reserved_sku    = 'HJ' || substr(reserved_sku, 3),
       reserved_handle = regexp_replace(reserved_handle, '^hairband-', 'hair-jewellery-')
 where reserved_sku ~ '^HA[0-9]+$';

update public.intake_files
   set restock_sku = 'HJ' || substr(restock_sku, 3)
 where restock_sku ~ '^HA[0-9]+$';

update public.restock_decisions
   set sku = 'HJ' || substr(sku, 3)
 where sku ~ '^HA[0-9]+$';

update public.match_references
   set sku = 'HJ' || substr(sku, 3)
 where sku ~ '^HA[0-9]+$';

-- Restock cards still waiting for the owner name the old product by SKU and
-- title (its handle hairband-012 is not renamed on Shopify).
update public.agent_job_photos
   set restock = regexp_replace(
                   regexp_replace(restock::text, '\mHA([0-9]{3})\M', 'HJ\1', 'g'),
                   '\mHairband ([0-9]{3})\M', 'Hair Jewellery \1', 'g')::jsonb
 where restock_state in ('pending', 'generate')
   and restock::text ~ '\mHA[0-9]{3}\M';
