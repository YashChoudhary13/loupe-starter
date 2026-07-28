-- Loupe · Phase 1 · 07 — which images and which colours belong to a draft

create table public.product_draft_images (
  id                uuid    primary key default gen_random_uuid(),
  product_draft_id  uuid    not null references public.product_drafts (id)  on delete cascade,
  image_version_id  uuid    not null references public.image_versions (id)  on delete restrict,
  position          integer not null default 0 check (position >= 0),
  -- Optional: which colour variant this image shows. NULL = applies to all.
  colour_id         uuid    references public.colours (id) on delete set null,

  unique (product_draft_id, image_version_id),
  unique (product_draft_id, position) deferrable initially deferred
);

comment on table public.product_draft_images is
  'Ordered images for a product. The position uniqueness is DEFERRABLE so a drag-to-reorder can renumber several rows inside one transaction without tripping over itself mid-update.';

create index product_draft_images_image_version_id_idx
  on public.product_draft_images (image_version_id);
create index product_draft_images_colour_id_idx
  on public.product_draft_images (colour_id) where colour_id is not null;

-- ---------------------------------------------------------------------------

create table public.product_draft_variants (
  id                uuid    primary key default gen_random_uuid(),
  product_draft_id  uuid    not null references public.product_drafts (id) on delete cascade,
  colour_id         uuid    not null references public.colours (id)        on delete restrict,
  position          integer not null default 0 check (position >= 0),

  unique (product_draft_id, colour_id),
  unique (product_draft_id, position) deferrable initially deferred
);

comment on table public.product_draft_variants is
  'Colour variants. There is deliberately no SKU column: variants SHARE the parent draft''s reserved_sku, matching the live store where AK011 sits on both the Gold and the Silver variant (CLAUDE.md · Colours).';

create index product_draft_variants_colour_id_idx
  on public.product_draft_variants (colour_id);
