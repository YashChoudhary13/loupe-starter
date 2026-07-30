# Phase 5 — redo, version history and prompt management

Recorded 2026-07-30. **Phase 5 is complete.**

## Purpose

Let an authorised operator inspect the two enhancement prompts, preserve immutable
prompt history, and redo an image without paying to describe the same photograph again.
Every generated result remains a separate version; nothing overwrites history.

## Boundaries

- Test environment only. Phase 7 owns live-store cutover.
- D51 supersedes D43 only for Phase 5 model selection: each prompt box offers ten curated
  OpenRouter models from budget to premium. There is no arbitrary model field and no
  provider-key selector.
- The current models stay selected until an operator deliberately changes one.
  `DESCRIBE_REASONING_EFFORT`, `IMAGE_SIZE` and `IMAGE_QUALITY` do not become UI controls.
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
4. Each current prompt has a separate model selector with exactly ten curated choices,
   ordered from low cost to premium; changing one creates an immutable prompt version,
   is atomic, audited, and is refused while enhancement work is in flight.
5. A new prompt version can be created without changing the current default.
6. Promoting a version is atomic: exactly one live default remains for each kind.
7. Image prompt activation refuses missing or duplicate required template tokens.
8. Prompt create/promote actions record the authorised operator and audit events.
9. Redo starts from an existing intake image and reuses cached description and
   presentation classification without another describe call.
10. A redo creates a new immutable generated `image_versions` row with incremented
   `version_no`, exact resolved prompt, model and cost.
11. Original and every generated version remain viewable; choosing a version does not
    delete or mutate another version.
12. Retry/crash recovery cannot cause a duplicate paid generation for the same redo job.
13. Tests, typecheck, lint, build, secret isolation and database lint pass; real
    test-environment evidence proves prompt activation and redo before completion.

## Completion evidence

- Criteria 1–4: the signed-in production browser opened `/prompts` through the console
  sidebar. Both prompt kinds showed one current version plus immutable history, and each
  selector exposed exactly ten choices with the accepted defaults still selected.
- Criteria 5–8: deployed-database tests and the live acceptance created a non-current image
  prompt, atomically promoted it, restored the original, and proved required-token
  validation plus authorised audit events.
- Criteria 9–11: live redo job `932dbeb1-ea9b-47c9-a89c-045dd03fc4b8` appended an
  unselected v2 for fixture `74b7dde8-d5e2-42cb-b7b4-787547b3a450`. It made zero
  descriptor calls, retained original/v1/v2, left v1 selected, and persisted the exact
  model, resolved prompt and `$0.078064` provider cost. The production browser showed all
  three versions and allowed v2 to be reviewed.
- Criterion 12: recovery tests prove that an existing deterministic R2 result is completed
  without another provider call, while an ambiguous started request with no object is
  fenced instead of being charged twice. Deployed SQL proves an expired lease can be
  reclaimed without losing that marker.
- Criterion 13: `380 passed`; typecheck, lint, production build, secret isolation and
  linked database lint all passed. Deployment `dpl_55xkFtB2vLJ81sT275Y24aiZM1oB` is
  Ready at `https://qimati-loupe.vercel.app`.

Evidence is retained under `.artifacts/phase5-acceptance/`. Cleanup restored the exact
original image prompt `f2f08fe5-708c-4366-9826-18f5857c9f54`, removed the temporary
intake, redo job and R2 objects, and a database read-back confirmed zero fixture/job rows
and exactly one current image prompt.
