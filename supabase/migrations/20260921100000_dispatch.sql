-- Dispatch: tracking numbers staged against In-progress Shopify orders, then pushed as fulfilments.
-- A parcel carries one tracking number; one or more orders travel in it. The same rows are the push history.
create table public.dispatch_parcels (
  id uuid primary key default gen_random_uuid(),
  shop_domain text not null,
  tracking_number text check (tracking_number ~ '^[0-9A-Z]{6,30}$'),
  carrier text check (carrier in ('DTDC','India Post','Tirupati Courier')),
  carrier_source text not null default 'auto' check (carrier_source in ('auto','manual')),
  staged_by text not null,
  staged_at timestamptz not null default now(),
  pushed_by text,
  pushed_at timestamptz,
  check ((pushed_at is null) = (pushed_by is null))
);
create table public.dispatch_parcel_orders (
  id uuid primary key default gen_random_uuid(),
  parcel_id uuid not null references public.dispatch_parcels(id) on delete cascade,
  shop_domain text not null,
  order_id text not null check (order_id ~ '^gid://shopify/Order/[0-9]+$'),
  order_name text not null,
  position integer not null default 0 check (position >= 0),
  status text not null default 'staged' check (status in ('staged','pushing','fulfilled','failed')),
  fulfillment_id text,
  error text,
  request_id uuid,
  push_started_at timestamptz,
  finished_at timestamptz,
  check ((status = 'fulfilled') = (fulfillment_id is not null)),
  unique (parcel_id, position)
);
-- An order sits in at most one open parcel; a fulfilled row is history and no longer blocks.
create unique index dispatch_open_order_idx on public.dispatch_parcel_orders(shop_domain, order_id) where status <> 'fulfilled';
create index dispatch_parcel_orders_parcel_idx on public.dispatch_parcel_orders(parcel_id);
create index dispatch_parcels_pushed_idx on public.dispatch_parcels(shop_domain, pushed_at desc) where pushed_at is not null;
alter table public.dispatch_parcels enable row level security;
alter table public.dispatch_parcel_orders enable row level security;
revoke all on public.dispatch_parcels, public.dispatch_parcel_orders from public, anon, authenticated;
grant select, insert, update, delete on public.dispatch_parcels, public.dispatch_parcel_orders to service_role;
comment on table public.dispatch_parcels is 'One tracking number and carrier, staged in /dispatch and pushed to Shopify as fulfilments. No customer information is stored.';
comment on table public.dispatch_parcel_orders is 'Orders travelling in a parcel, with the per-order push result. position 0 is the row the parcel was started from.';
