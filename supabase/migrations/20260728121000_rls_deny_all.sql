-- Loupe · Phase 1 · 11 — RLS on, no policies, nothing reachable from the browser
--
-- CLAUDE.md hard rule 7: all Shopify, Drive, OpenAI and R2 calls are server-side,
-- and this tool publishes to a live store.
--
-- Every table gets RLS ENABLED and ZERO policies. In Postgres that is a default
-- deny: anon and authenticated can read and write nothing at all. service_role
-- BYPASSES RLS, which is exactly the split we want — the server-only client can
-- do everything, the browser client can do nothing, and that is enforced by the
-- database rather than by remembering to be careful in application code.
--
-- When Phase 4 adds sign-in, access still runs through the server client. If a
-- screen ever genuinely needs direct browser reads, add a narrow policy in that
-- phase's migration and say why. Do not blanket-enable.

alter table public.categories             enable row level security;
alter table public.sku_counters           enable row level security;
alter table public.materials              enable row level security;
alter table public.colours                enable row level security;
alter table public.colour_usage           enable row level security;
alter table public.product_drafts         enable row level security;
alter table public.intake_files           enable row level security;
alter table public.image_versions         enable row level security;
alter table public.product_draft_images   enable row level security;
alter table public.product_draft_variants enable row level security;
alter table public.prompts                enable row level security;
alter table public.events                 enable row level security;
alter table public.app_users              enable row level security;

-- Belt and braces. RLS already blocks anon/authenticated, but revoking the table
-- privileges as well means a future migration that adds a policy for one purpose
-- cannot accidentally expose a whole table it was not thinking about.
revoke all on all tables    in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

-- Deliberately NOT altering default privileges for future tables here — a later
-- phase that adds a table should make its own exposure decision explicitly.
