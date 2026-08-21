-- D110: a photograph is identified against the catalogue before any paid stage,
-- and a confirmed restock has its own states.
--
-- Enum additions live alone in this file: db-push wraps each file in a
-- transaction and Postgres refuses to use a value inside the transaction that
-- added it. The functions that use these values are in the next migration.
--
--   identifying  waiting for the matcher and for an operator's decision
--   restock      an operator confirmed this photograph shows an existing SKU;
--                the stock change is pending in the Restock section
--   restocked    stock updated; the photograph kept as a matcher reference
alter type public.intake_status add value if not exists 'identifying';
alter type public.intake_status add value if not exists 'restock';
alter type public.intake_status add value if not exists 'restocked';
