# Phase 5 — redo, version history and prompt management

Recorded 2026-07-30. **Phase 5 has started and is not complete.**

## Purpose

Let an authorised operator inspect the two enhancement prompts, preserve immutable
prompt history, and redo an image without paying to describe the same photograph again.
Every generated result remains a separate version; nothing overwrites history.

## Boundaries

- Test environment only. Phase 7 owns live-store cutover.
- D43 still applies: no model/provider selector and no change to `DESCRIBE_MODEL`,
  `DESCRIBE_REASONING_EFFORT`, `IMAGE_MODEL`, `IMAGE_SIZE` or `IMAGE_QUALITY`.
- Redo reuses the cached factual description and presentation class. It makes no third
  model call and does not rerun the describe call.
- Prompt bodies are append-only. Editing means inserting a new version and atomically
  promoting it; old rows and the exact prompt on every image version remain unchanged.
- Prompt activation and redo are protected server actions and write audit events.
- The current Phase 3C prompt remains active until an authorised operator deliberately
  promotes a tested replacement.
- Tracking, duplicate detection and daily Shopify reconciliation remain Phase 6.

## Success criteria

1. `/prompts` is protected by the same exact `app_users` authorisation as `/console`.
2. The sidebar opens Prompt management and clearly marks the active page.
3. Both `describe` and `image` show exactly one current default plus immutable history.
4. A new prompt version can be created without changing the current default.
5. Promoting a version is atomic: exactly one live default remains for each kind.
6. Image prompt activation refuses missing or duplicate required template tokens.
7. Prompt create/promote actions record the authorised operator and audit events.
8. Redo starts from an existing intake image and reuses cached description and
   presentation classification without another describe call.
9. A redo creates a new immutable generated `image_versions` row with incremented
   `version_no`, exact resolved prompt, model and cost.
10. Original and every generated version remain viewable; choosing a version does not
    delete or mutate another version.
11. Retry/crash recovery cannot cause a duplicate paid generation for the same redo job.
12. Tests, typecheck, lint, build, secret isolation and database lint pass; real
    test-environment evidence proves prompt activation and redo before completion.

## Current slice

Criteria 1–3 are implemented: Prompt management is now a real protected route that shows
the current Describe and Image prompts and their history. Editing, promotion and redo are
the next slice. No prompt body or model setting changed.
