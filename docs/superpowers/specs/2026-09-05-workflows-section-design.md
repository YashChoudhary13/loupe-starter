# Workflows — one button per store-wide check or repair

*2026-09-05. Owner request: "a single button to do this job and not a daily automatic job
because this does not happen on a regular basis … a new section … whole workflows embedded
which run in one click … animations showing the progress or each step … while not blocking
activating another one."*

## Problem

Two store-wide jobs existed with no home. The material-consistency fix lived as a Python script
on the owner's Mac behind a LaunchAgent that was never loaded (the plist existed, `launchctl`
did not know it). Full reconciliation was a button on Tracking that blocked the page for the
whole run and answered with one paragraph. Neither showed what it was doing.

## Design

**`/workflows`** — a section in the sidebar under Models. One card per workflow: title, what it
does, what it writes, a black **Run** pill, and a vertical step timeline drawn like `/models`.

**Engine** — `workflow_runs` table (migration `20260905100000`). Pressing Run inserts a row and
returns; the steps execute in `after()` inside the Next.js process and write their status and a
live detail line back onto the row every ≤400 ms. Browsers poll `listWorkflowRunsAction` every
2 s only while a run is in progress. A partial unique index allows one *running* row per
workflow, so a double press joins the run in flight; different workflows run concurrently. A
running row silent for 15 min is reported as failed ("Loupe restarted during this run").

A step that throws fails the run and skips the rest. A step that should not stop the run returns
`{ detail, warning: true }` and shows amber. Every run ends with a `workflow.finished` /
`workflow.failed` audit event.

**Timeline colours** follow DESIGN.md: grey pending, black pulsing running, green tick done,
amber warning or failed, dashed skipped. Summary line, "Details" expander with titled lists and
the log, and the previous three runs under each card.

## Workflows

| Key | Steps | Writes |
|---|---|---|
| `material` | pull → compare → write → verify | tags, `custom.material`, SEO on products whose description disagrees (description = truth; 0 or 2 materials reported) |
| `reconciliation` | webhooks → drafts → drift → drive → counters → duplicates | same five functions as the nightly job; step 6 reports duplicate SKUs and `-copy` handles |
| `copy_rules` | pull → scan → fix | report; replaces only the old "Made with premium … (Surgical Grade)" boilerplate with the six standard bullets |
| `collections` | rules → members | report: members of automated collections that fail the rules (admin manual includes) |

## Non-goals

- Scheduling. The owner asked for buttons, not a daily job; the LaunchAgent is removed.
- A rollback button. Before/after values are kept in the run's Details.
- Removing manual collection includes — Shopify exposes no API for it.
