-- D170 repair. The link from a delivery to its phone photograph (intake_files.agent_source_photo_id) was written
-- in one unchecked update together with the alt line, and the alt line broke intake_files_description_is_complete,
-- so most deliveries since D150 carry no link (708 of 1,101 on 2026-11-14). The D170 backfill trusted that link and
-- marked delivered photographs as failed. The link cannot be rebuilt (the source filename was never stored), so a
-- photograph of an old batch that did deliver something is taken as done; a batch with no delivery at all stays failed.
update public.agent_job_photos p
   set work_state = 'done', last_error = null
  from public.agent_jobs j
 where j.id = p.job_id
   and p.work_state = 'failed'
   and p.last_error = 'No delivery on record (from before per-photo tracking).'
   and (exists (select 1 from public.intake_files f where f.agent_batch = j.label)
        or exists (select 1 from public.agent_job_photos r where r.job_id = j.id and r.restock_state is not null));

-- The alt lines that were sent could not be saved either; nothing to restore them from.
