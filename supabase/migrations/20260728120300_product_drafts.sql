-- Loupe · Phase 1 · 04 — product drafts
--
-- Created before intake_files because intake_files.product_draft_id points here.

create table public.product_drafts (
  id                 uuid          primary key default gen_random_uuid(),
  category_id        uuid          not null references public.categories (id) on delete restrict,
  material_id        uuid          references public.materials (id)  on delete restrict,
  -- Optional free-text suffix: '(Adjustable)', '(Huggies)', '(Single Piece)',
  -- '(Light Rose gold)'. Title is NOT purely category + number.
  title_suffix       text,
  -- Money in paise, integer, never float (CLAUDE.md conventions).
  -- Nullable while assembling; publish blocks on NULL or 0 (hard rule 8).
  price_paise        integer       check (price_paise is null or price_paise > 0),
  weight_g           integer       check (weight_g is null or weight_g > 0),
  stock              integer       not null default 0 check (stock >= 0),
  status             draft_status  not null default 'assembling',

  -- Allocated inside the publish transaction, never before. Both are UNIQUE:
  -- reserved_sku is the database-level backstop against a second RS221, and
  -- reserved_handle is what makes publish idempotent — a retry reuses the same
  -- handle so Shopify's productSet updates instead of creating a duplicate
  -- product (CLAUDE.md hard rules 1 and 2).
  reserved_sku       text          check (reserved_sku ~ '^[A-Z]{2,4}[0-9]{3,}$'),
  reserved_handle    text          check (length(btrim(reserved_handle)) > 0),

  shopify_product_id text,
  published_at       timestamptz,
  created_by         text,
  error              text,
  created_at         timestamptz   not null default now(),
  updated_at         timestamptz   not null default now(),

  -- A published draft must carry the identity it was published under.
  constraint product_drafts_published_is_identified check (
    status <> 'published'
    or (reserved_sku is not null and reserved_handle is not null and published_at is not null)
  )
);

comment on table public.product_drafts is
  'One row per Shopify product. Colour variants live in product_draft_variants and deliberately SHARE this row''s reserved_sku — matching the live store, where AK011 appears on both the Gold and Silver variant.';
comment on column public.product_drafts.price_paise is
  'Integer paise. Never a float, never rupees.';
comment on column public.product_drafts.reserved_sku is
  'Allocated by public.next_sku() inside the publish transaction. UNIQUE — this index is the last line of defence against the RS221 collision recurring.';

-- Nullable-unique: many drafts sit unallocated, but no two may ever share a SKU
-- or a handle once allocated.
create unique index product_drafts_reserved_sku_key
  on public.product_drafts (reserved_sku) where reserved_sku is not null;
create unique index product_drafts_reserved_handle_key
  on public.product_drafts (reserved_handle) where reserved_handle is not null;
create unique index product_drafts_shopify_product_id_key
  on public.product_drafts (shopify_product_id) where shopify_product_id is not null;

-- Specified index: the tracking page's "what is stuck" query.
create index product_drafts_status_idx on public.product_drafts (status);
-- Alert on AGE, not status (CLAUDE.md hard rule 5).
create index product_drafts_status_created_at_idx on public.product_drafts (status, created_at);
create index product_drafts_category_id_idx on public.product_drafts (category_id);
create index product_drafts_material_id_idx on public.product_drafts (material_id);

create trigger product_drafts_set_updated_at
  before update on public.product_drafts
  for each row execute function public.set_updated_at();
