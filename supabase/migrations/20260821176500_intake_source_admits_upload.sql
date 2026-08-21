-- Found 2026-08-21 while testing the restock paths: D103 replaced the source
-- check by dropping `intake_files_source_check`, but the constraint created in
-- 20260803120000 is named `intake_files_source_is_known`. Both existed, and the
-- older one still refused source = 'upload' — so finalize_raw_image_upload()
-- could never insert a row in production (0 upload-sourced rows, ever). The
-- three-value check from D103 stays; the stale two-value one goes.
alter table public.intake_files drop constraint if exists intake_files_source_is_known;
alter table public.intake_files drop constraint if exists intake_files_source_check;
alter table public.intake_files
  add constraint intake_files_source_check check (source in ('drive', 'manual', 'upload'));
