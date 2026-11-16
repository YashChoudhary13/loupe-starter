-- Find (D173): the support desk types an order number and sees the photograph of the packed parcel, or types a
-- product code and sees the phone photograph the listing was made from.
--
-- parcel_photos holds one row per photograph of a packed parcel. A photograph shows a packing slip, so it shows a
-- buyer's name and address: the bucket stays private, the row stores no buyer text, and a photograph is only shown
-- for an order once it is `matched` (read and checked against Shopify, or confirmed by a person).
create table public.parcel_photos (
  id            uuid primary key default gen_random_uuid(),
  storage_key   text not null unique,
  thumb_key     text,
  -- The phone's own file name and the uploaded size: together they tell a second upload of the same photograph.
  filename      text not null,
  bytes         integer not null check (bytes > 0),
  -- pending: the browser has not finished the upload · review: a person must say which order this is ·
  -- matched: order_numbers is trusted and Find shows the photograph · dismissed: not a parcel, or a second copy.
  status        text not null default 'pending' check (status in ('pending', 'review', 'matched', 'dismissed')),
  -- The slip's own order first, then every other order packed in the same parcel.
  order_numbers integer[] not null default '{}',
  -- The courier sticker as read from the photograph. Never used as the tracking number: Shopify is asked for that.
  -- It only lets Find warn that the sticker in the picture is no longer the parcel's tracking number.
  sticker       text check (sticker is null or sticker ~ '^[0-9A-Z]{6,30}$'),
  -- Why a person is needed, in the operator's words. Null once matched.
  problem       text,
  uploaded_by   text not null,
  confirmed_by  text,
  created_at    timestamptz not null default now(),
  confirmed_at  timestamptz,
  check (status <> 'matched' or cardinality(order_numbers) > 0)
);
create index parcel_photos_status_idx on public.parcel_photos (status, created_at desc);
create index parcel_photos_file_idx on public.parcel_photos (filename, bytes);

alter table public.parcel_photos enable row level security;
revoke all on public.parcel_photos from public, anon, authenticated;
grant select, insert, update, delete on public.parcel_photos to service_role;
comment on table public.parcel_photos is
  'D173: photographs of packed parcels for the support desk. order_numbers says whose parcel it is; no buyer text is stored.';

-- Order number, or the first digits of one, to the matched photographs. One row per (order, photograph).
-- ponytail: reads the whole table (about 45 rows a day). Give order numbers their own indexed table past ~200,000 rows.
create function public.find_parcels(p_prefix text, p_limit integer default 30)
returns table (order_number integer, photo_id uuid, thumb_key text, order_numbers integer[], sticker text, created_at timestamptz)
language sql stable
set search_path = ''
as $$
  select n, p.id, p.thumb_key, p.order_numbers, p.sticker, p.created_at
    from public.parcel_photos p
   cross join lateral unnest(p.order_numbers) as n
   where p.status = 'matched'
     and p_prefix ~ '^[0-9]{1,8}$'
     and n::text like p_prefix || '%'
   order by (n::text = p_prefix) desc, n desc, p.created_at desc
   limit least(greatest(coalesce(p_limit, 30), 1), 60)
$$;

-- Product code, or the start of one, to the phone photographs behind its listing pictures.
--   · a picture Claude delivered (D142): the photograph it was made from, when the delivery recorded which one (D145);
--   · a picture the in-app pipeline made (Drive or raw upload): the stored original.
-- A ready image uploaded by hand has no phone photograph, and neither has a product listed before Loupe.
-- Goes through product_draft_images so a product that reuses an older piece's pictures finds that piece's photograph.
-- The limit counts photographs: counting products first would fill it with products that have none ("NK20" has
-- a hundred older necklaces before NK2067).
create function public.find_raw_photos(p_prefix text, p_limit integer default 30)
returns table (code text, kind text, photo_id uuid, thumb_key text, taken_at timestamptz)
language sql stable
set search_path = ''
as $$
  with files as (
    select distinct d.reserved_sku, f.id as intake_id, f.source, f.agent_source_photo_id
      from public.product_drafts d
      join public.product_draft_images i on i.product_draft_id = d.id
      join public.image_versions v on v.id = i.image_version_id
      join public.intake_files f on f.id = v.intake_file_id
     where p_prefix ~ '^[A-Z]{1,4}[0-9]{0,8}$'
       and d.reserved_sku like p_prefix || '%'
  ), photos as (
    select f.reserved_sku as code, 'phone' as kind, p.id as photo_id, p.thumb_key, p.created_at as taken_at
      from files f
      join public.agent_job_photos p on p.id = f.agent_source_photo_id and p.status = 'uploaded'
    union
    select f.reserved_sku, 'original', o.id, o.thumb_key, o.created_at
      from files f
      join public.image_versions o on o.intake_file_id = f.intake_id and o.kind = 'original'
     where f.source in ('drive', 'upload')
  )
  select p.code, p.kind, p.photo_id, p.thumb_key, p.taken_at
    from photos p
   order by (p.code = p_prefix) desc, p.code, p.taken_at
   limit least(greatest(coalesce(p_limit, 30), 1), 60)
$$;

revoke all on function public.find_parcels(text, integer), public.find_raw_photos(text, integer) from public, anon, authenticated;
grant execute on function public.find_parcels(text, integer), public.find_raw_photos(text, integer) to service_role;
