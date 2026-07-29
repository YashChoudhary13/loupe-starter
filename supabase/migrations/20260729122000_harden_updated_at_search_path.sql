-- The shared trigger helper predates the database security-advisor check for a
-- mutable search path. Phase 3A adds another trigger that uses it, so pin name
-- resolution to trusted schemas before the new sync state is exercised.

alter function public.set_updated_at()
  set search_path = pg_catalog, pg_temp;
