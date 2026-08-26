-- 2026-08-27: store a reference's colour signature (loupe_worker/colour.py), set by the
-- embed job alongside the two view embeddings. Unfenced like store_match_embedding — the
-- reference id comes from the fenced match_job_reference read in the worker route.
create or replace function public.set_reference_colour(
  p_reference uuid,
  p_colour    text
)
returns void
language sql
volatile
set search_path = public, pg_temp
as $$
  update public.match_references
     set colour = p_colour::extensions.vector(15)
   where id = p_reference;
$$;

revoke execute on function public.set_reference_colour(uuid, text) from public, anon, authenticated;
grant  execute on function public.set_reference_colour(uuid, text) to service_role;
