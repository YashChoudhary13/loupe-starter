-- D102: Shopify webhooks push changes into Loupe the moment they happen,
-- instead of the operator waiting for (and worrying about) the nightly
-- reconciliation. Alerts raised by webhook handlers live here — the
-- shopify_reconciliation_issues table is keyed to a reconciliation RUN and its
-- rows are rebuilt every night, which is the wrong home for an event-driven
-- finding that must survive until a human resolves it.
--
-- One live alert per (product, code): the same drift re-reported by ten rapid
-- webhook deliveries updates the existing row instead of stacking ten.
-- A clean products/update auto-resolves whatever it previously raised.

create table public.shopify_webhook_alerts (
  id                  bigint generated always as identity primary key,
  shopify_product_id  text        not null,
  product_draft_id    uuid        references public.product_drafts (id) on delete cascade,
  topic               text        not null,
  code                text        not null,
  message             text        not null check (length(btrim(message)) > 0),
  detail              jsonb       not null default '{}'::jsonb,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  resolved_at         timestamptz,
  resolved_by         text
);

create unique index shopify_webhook_alerts_one_live
  on public.shopify_webhook_alerts (shopify_product_id, code)
  where resolved_at is null;

create index shopify_webhook_alerts_unresolved_idx
  on public.shopify_webhook_alerts (created_at desc)
  where resolved_at is null;

comment on table public.shopify_webhook_alerts is
  'Findings raised by Shopify webhook handlers (D102): real drift on Loupe-published products, or a published product deleted in admin. Resolved by an operator in Tracking or automatically when a later webhook shows the product clean.';

alter table public.shopify_webhook_alerts enable row level security;
