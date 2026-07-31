# Phase 6 — tracking, duplicate detection and Shopify reconciliation

Recorded and completed 2026-07-31. **Phase 6 is complete.**

## Purpose

Give an authorised operator one truthful place to see failed or forgotten work, review
possible duplicate photographs, and verify that products Loupe published still match the
test Shopify store. The page explains what needs attention and offers bounded, audited
actions; it does not silently repair Shopify or let infrastructure failures disappear.

## Boundaries

- Test store only. Phase 7 owns the live-store cutover.
- Alerts are based on age and actionable failure, not merely on a non-terminal status.
- Duplicate detection uses a deterministic 64-bit perceptual hash. It raises a warning
  only; it never blocks publishing and never decides for the operator.
- Shopify reconciliation is read-only. It records differences but never changes Shopify
  or rewrites a Loupe draft automatically.
- Product counts and photograph counts are labelled separately. A multi-image product must
  not make a visually neat but false accounting equation.
- Existing Phase 3C model, prompt and paid-acceptance constraints do not change.
- Reports, R2 retention and live cutover remain later work.

## Success criteria

1. `/tracking` requires the same exact `app_users` authorisation as the console.
2. The sidebar opens Tracking, marks it active and shows the real attention count.
3. Today’s uploaded photographs, listed products, attention items and queue work are
   labelled truthfully with Asia/Kolkata day boundaries.
4. A failed intake item needs attention immediately; an enhanced ungrouped photograph
   becomes stalled only after 24 hours; normal recent queue work is not called an error.
5. Rows show filename/entity, status, age and a plain-English reason. Event history and
   bounded raw detail are available without exposing secrets.
6. Needs-attention, in-progress and all views plus status, error, age and filename search
   filters work with mouse and keyboard.
7. An authorised operator can retry an exhausted retryable intake item or skip an
   ungrouped/failed item. Permanent input errors are not offered a futile retry. Every
   transition is validated in SQL and audited.
8. Enhancement stores one deterministic 64-bit perceptual hash for every decodable source
   and retries produce the same hash.
9. Hash-distance matching finds near-identical photographs, excludes self and completed
   review decisions, and never treats the warning as a publish block.
10. The operator can mark a candidate duplicate or dismiss the pair. The canonical pair,
    actor and audit event are durable; marking a grouped or published photograph duplicate
    is refused.
11. Possible duplicates are visible in Tracking and on the console before publish while
    normal publishing remains available.
12. A daily, authenticated cron reads every Loupe-published test-store product and compares
    critical identity/catalogue fields without writing to Shopify.
13. Reconciliation runs and each mismatch are durable, auditable and visible in Tracking;
    one active run is leased so overlapping cron/manual requests cannot duplicate a run.
14. A signed-in operator can start a reconciliation manually and see its completed result.
15. Tests, typecheck, lint, build, secret isolation and database lint pass. Live
    test-environment evidence proves the age boundary, duplicate decisions, protected
    actions, Shopify read-back, keyboard path and cleanup before Phase 6 is complete.

## Completion evidence

- Criteria 1–6: the deployed `/tracking` route passed signed-in production-browser review.
  It showed separate photograph/product counts, the 24-hour stalled boundary, immediate
  failures, duplicate warnings, plain reasons, filters, detail controls and a consistent
  attention badge on Console, Tracking and Prompts. Mouse view switching plus keyboard
  search, clear and filter paths were exercised.
- Criteria 7–11: deployed SQL and application tests proved the guarded retry, skip and
  canonical duplicate-review transitions. Live pHash fixtures were distance `2`; the
  warning appeared in Tracking and the Console without blocking Publish. The signed-in
  operator dismissed the pair and database read-back recorded the canonical IDs, decision
  and actor.
- Criteria 12–14: the authenticated daily cron is active at `03:00 Asia/Kolkata`. Live
  reconciliation matched the test product, caught a deliberate title drift, matched again
  after restoration, and the signed-in manual action completed `1/1` with zero issues.
- Criterion 15: `427` tests across 41 files, typecheck, lint, production build,
  `verify:isolation` and linked database lint passed. Evidence is retained under
  `.artifacts/phase6-acceptance/`. Cleanup removed every fixture row, R2 object and Shopify
  product; database counts were zero and Shopify returned a null node.
