-- Printed only after the operator chooses Print on the draft label popup. Cancel leaves this false.
alter table public.product_drafts
  add column labels_printed boolean not null default false;
comment on column public.product_drafts.labels_printed is
  'True only after the operator prints labels from the post-draft popup. Cancel keeps false.';
