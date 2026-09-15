-- Existing drafts retain their label identity. Only drafts created after this
-- migration opt into exact-variant SKUs and matching barcodes (owner request).
-- Adding with a legacy default and THEN changing the default avoids relabeling
-- existing published products, failed retries, and in-flight Shopify drafts.
alter table public.product_drafts
  add column sku_scheme text not null default 'legacy'
  check (sku_scheme in ('legacy', 'variant-v1'));
alter table public.product_drafts alter column sku_scheme set default 'variant-v1';

comment on column public.product_drafts.sku_scheme is
  'Immutable creation policy: legacy keeps shared SKUs; variant-v1 derives exact-option SKUs and writes matching Shopify barcodes. Changing an option identity requires new labels.';

create function public.protect_draft_sku_scheme() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.sku_scheme is distinct from old.sku_scheme then
    raise exception 'SKU policy cannot be changed through draft editing. Existing labels require a separate catalogue migration.';
  end if;
  return new;
end;
$$;
create trigger protect_draft_sku_scheme before update on public.product_drafts
for each row execute function public.protect_draft_sku_scheme();
