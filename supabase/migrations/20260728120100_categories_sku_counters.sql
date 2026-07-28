-- Loupe · Phase 1 · 02 — categories and the SKU counters
--
-- Category drives the SKU prefix, the title, the tag and therefore the Shopify
-- collection. Each prefix owns its OWN number sequence (CLAUDE.md).

create table public.categories (
  id                uuid primary key default gen_random_uuid(),
  name              text        not null unique,
  -- Uppercase letters only. `NK`, `ER`, `BK`, `CB`, `RS`, `AK` today.
  sku_prefix        text        not null unique check (sku_prefix ~ '^[A-Z]{2,4}$'),
  -- Must contain the {n} placeholder, e.g. 'Necklace {n}'. A pattern without it
  -- would silently produce the same title for every product in the category.
  title_pattern     text        not null check (title_pattern like '%{n}%'),
  -- Match the LIVE tag exactly, inconsistent casing and all (`cb`, `Necklace`,
  -- `anklets`). Collections are tag-driven; a tidier tag drops the product out
  -- of its collection. CLAUDE.md is explicit about this.
  shopify_tag       text        not null check (length(btrim(shopify_tag)) > 0),
  -- Nullable on purpose: real per-category weights are a Phase 2 blocking item.
  -- Every live variant currently has weight 0, which is why weight-based
  -- shipping does not work. Do not default this to 0 and repeat that.
  default_weight_g  integer     check (default_weight_g is null or default_weight_g > 0),
  default_stock     integer     not null default 0 check (default_stock >= 0),
  sort_order        integer     not null default 0,
  active            boolean     not null default true,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

comment on table public.categories is
  'The six confirmed categories. Watches, Hand Chains, Nose Pins, Jewellery Box, Bags, Hair Accessories, Indian Jewellery and Brass are deliberately absent — their prefix/title/tag are TBD and must be confirmed against the live store, never invented.';
comment on column public.categories.default_weight_g is
  'TODO(phase-2): real grams per category. NULL means "not yet known" — publish must not fall back to 0.';

create trigger categories_set_updated_at
  before update on public.categories
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------

-- The authoritative source of SKU numbers. NEVER derive a number from Shopify:
-- Shopify enforces no SKU uniqueness and accepts collisions silently, and drafts,
-- deletions and in-flight writes make any "current max" query lie. The live store
-- already carries two different products on SKU RS221 because this was done by
-- hand. See CLAUDE.md hard rule 1 and docs/DECISIONS.md D2.
create table public.sku_counters (
  sku_prefix   text primary key
                 references public.categories (sku_prefix)
                 on update cascade
                 on delete restrict,
  last_number  integer     not null default 0 check (last_number >= 0),
  updated_at   timestamptz not null default now()
);

comment on table public.sku_counters is
  'One row per SKU prefix. Mutated ONLY through public.next_sku(), which uses a single UPDATE ... RETURNING so the row lock serialises concurrent allocators.';
comment on column public.sku_counters.last_number is
  'Highest number ALLOCATED so far. TODO(phase-2): seed from the TRUE MAX per prefix taken from the Shopify products CSV — not a row count. The live sequences have gaps (RS218, RS220, RS222 are missing).';
