-- Rolling-deploy compatibility for the old console's shared colour stock.
--
-- product_draft_variants.stock is authoritative whenever options exist. The
-- parent stock column remains the simple product's quantity, and for an option
-- product mirrors the largest choice quantity. Mirroring one row (rather than
-- the sum) prevents the pre-feature console from loading a two-colour product
-- at 24, saving that as 24 EACH, then loading 48 on the next edit.
--
-- The new application computes total available stock from the variant rows; it
-- never uses this compatibility mirror to publish option inventory.

create function public.sync_product_draft_option_stock()
returns trigger
language plpgsql
volatile
set search_path = public, pg_temp
as $$
declare
  v_draft_id uuid := coalesce(new.product_draft_id, old.product_draft_id);
  v_kind     text;
  v_stock    integer;
begin
  select variant_kind into v_kind
    from public.product_drafts
   where id = v_draft_id;

  -- During a switch back to one-stock mode, save_product_draft has already put
  -- the intended simple quantity on the parent before deleting old rows.
  if v_kind is null or v_kind = 'none' then
    return null;
  end if;

  select coalesce(max(stock), 0)::integer into v_stock
    from public.product_draft_variants
   where product_draft_id = v_draft_id;

  update public.product_drafts
     set stock = v_stock
   where id = v_draft_id
     and stock is distinct from v_stock;

  return null;
end;
$$;

create trigger product_draft_variants_sync_parent_stock
  after insert or update of stock or delete on public.product_draft_variants
  for each row execute function public.sync_product_draft_option_stock();

-- Correct the SUM written by the immediately preceding migration before an old
-- app bundle can read it back as the next shared per-colour value.
update public.product_drafts d
   set stock = choices.max_stock
  from (
    select product_draft_id, coalesce(max(stock), 0)::integer as max_stock
      from public.product_draft_variants
     group by product_draft_id
  ) choices
 where d.id = choices.product_draft_id
   and d.variant_kind <> 'none'
   and d.stock is distinct from choices.max_stock;

comment on column public.product_drafts.stock is
  'Simple-product stock. For option products this is a legacy-console compatibility mirror of the largest choice; product_draft_variants.stock is authoritative.';
comment on function public.sync_product_draft_option_stock() is
  'Keeps the legacy single stock field stable for option products. Publishing and validation use the authoritative per-choice rows.';

revoke all on function public.sync_product_draft_option_stock() from public, anon, authenticated;
grant execute on function public.sync_product_draft_option_stock() to service_role;
