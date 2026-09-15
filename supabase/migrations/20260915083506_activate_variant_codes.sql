-- Apply only AFTER the new Loupe release is healthy. Existing drafts keep their policy.
alter table public.product_drafts alter column sku_scheme set default 'variant-v1';
