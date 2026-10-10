-- Packing slips (D146): which open orders have had a slip printed from /dispatch/print, in which batch, with which
-- mark, and whether Shopify was told the order is In progress. No customer information is stored: the slip itself is
-- rendered fresh from Shopify on every print and reprint; only the mark strip is kept so a reprint shows what was printed.
create table public.slip_batches (
  id uuid primary key default gen_random_uuid(),
  shop_domain text not null,
  printed_by text not null,
  printed_at timestamptz not null default now(),
  order_count integer not null default 0 check (order_count >= 0),
  -- "Print from Qimati<n>": orders below n in that click were recorded as printed before Loupe (BASELINE), not rendered.
  from_number integer check (from_number > 0)
);
create table public.slip_prints (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.slip_batches(id) on delete restrict,
  shop_domain text not null,
  order_id text not null check (order_id ~ '^gid://shopify/Order/[0-9]+$'),
  order_name text not null,
  order_number integer not null check (order_number >= 0),
  mark text not null check (mark in ('PACK','HOLD','CLUB','CLUB + HOLD','BASELINE')),
  strip jsonb not null default '{}'::jsonb,
  -- marked: Shopify now shows In progress · already: it already did · failed: the write failed, progress_error says why ·
  -- not_needed: a held order (or a baseline row) is never marked In progress.
  progress text not null default 'not_needed' check (progress in ('marked','already','failed','not_needed')),
  progress_error text,
  printed_at timestamptz not null default now(),
  -- One slip per order, ever. Two operators clicking at once each get only the orders the other did not take.
  unique (shop_domain, order_id)
);
create index slip_prints_batch_idx on public.slip_prints(batch_id);
create index slip_batches_printed_idx on public.slip_batches(shop_domain, printed_at desc);
alter table public.slip_batches enable row level security;
alter table public.slip_prints enable row level security;
revoke all on public.slip_batches, public.slip_prints from public, anon, authenticated;
grant select, insert, update, delete on public.slip_batches, public.slip_prints to service_role;
comment on table public.slip_batches is 'One click of Print slips on /dispatch/print: who, when, how many slips. Reprint renders the batch again from Shopify.';
comment on table public.slip_prints is 'An order whose packing slip was printed, with its mark strip and the In-progress write result. No customer information.';
