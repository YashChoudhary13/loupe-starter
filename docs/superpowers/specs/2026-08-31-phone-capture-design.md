# Phone capture — shoot straight into Loupe

*2026-08-31. Owner request: "as soon as we click a picture, can it come to Loupe instead of
uploading to Drive all the time?"*

## Problem

Photographs reach Loupe two ways today: the photographer drops files into the Drive RAW folder
(404 of 449 intakes in August), or an operator drags files onto `/upload` on a desktop (45).
Both are a round-trip away from the phone that took the picture. `/upload` cannot be used on a
phone: the shell is a fixed 216 px sidebar grid with no responsive breakpoints, so the content
column is ~140 px wide on a 390 px screen.

Nothing is wrong with the upload pipeline itself. D103 already takes a browser file, presigns
an R2 PUT, verifies the object and lands it in `intake_files` as `discovered` — Identify, then
enhancement, exactly like a Drive drop. The gap is a phone-sized front door to that pipeline.

## Goal

An operator opens Loupe on their phone, taps **Camera**, takes the shot with the phone's normal
camera app, and the full-resolution JPEG is uploading before they lower the phone. A second
button, **From gallery**, sends photographs already taken (Pro mode, earlier session) the same
way. No Drive, no "Enhance" button, no desktop.

Success: a shot taken on an Android phone at the shop appears in **Identify** within a minute,
through the existing D103 path, with `source = 'manual'` and `drive_file_id = upload:{id}`.

## Non-goals

- Replacing or changing the Drive intake. It stays exactly as it is.
- Making the desktop shell responsive.
- Web Share Target ("Gallery → Share → Loupe"). Gallery multi-select covers the bulk case; the
  share sheet needs a service worker and an IndexedDB hand-off. Revisit only if picking from the
  gallery proves slow in practice.
- Per-shot prompt choice on the phone. The sticky session default (same as `/upload`) is enough.
- In-browser camera streams (`getUserMedia`). They bypass the camera app's processing and cap
  resolution. `capture="environment"` hands off to the real camera app instead.

## Design

### 1. Route: `/capture`

`src/app/capture/page.tsx` — a server page outside the `(shell)` route group, so it renders
without the sidebar. It calls `requireOperator()` (same gate as every section) and renders
`CaptureScreen`. Login is the existing Google OAuth flow; the login page is already a standalone
card and works on a phone. All four production operators can sign in as they are.

The page has its own minimal header: "Loupe · Capture", the signed-in email, and a link to
`/identify` showing how many shots are waiting there.

### 2. Shared upload queue

Two pieces, so the logic is testable in the project's node-only vitest setup (no jsdom, no
testing-library):

**`src/components/upload/raw-upload-runner.ts`** — pure, no React. `runRawUploads(items, deps,
report)` takes a batch of `{ key, file, categorySlug, settingSlug }`, runs them three-wide, and
for each calls `deps.begin` → `deps.put` → `deps.finalize` (the existing
`beginRawUploadAction`, `putUploadedObject`, `finalizeRawUploadAction`, injected), reporting
every state change through `report(key, patch)`. This is the loop that lives inside
`UploadScreen.startAll` today, moved verbatim.

**`src/components/upload/use-raw-upload-queue.ts`** — a thin hook that owns the file list
state (`pending | uploading | verifying | queued | failed`, progress, detail), preview URLs,
and the sticky defaults under the existing `loupe.upload.defaults.v1` localStorage key. It
exposes `addFiles(files, { autoStart })`, `startAll()`, `retry(key)`, `remove(key)` and calls
the runner.

`UploadScreen` is refactored to consume the hook with no behaviour change. `CaptureScreen`
calls `addFiles(..., { autoStart: true })`.

### 3. `CaptureScreen`

`src/components/upload/CaptureScreen.tsx`, client component, phone-first single column:

- **Camera** — `<input type="file" accept="image/jpeg,image/png,image/webp" capture="environment">`.
  Android Chrome and iOS Safari open the system camera app; the returned file is the camera
  app's own full-resolution JPEG. iOS converts HEIC to JPEG automatically because `accept`
  excludes HEIC.
- **From gallery** — the same input without `capture`, with `multiple`.
- Prompt defaults — the same category × setting selects as `/upload`, sticky.
- Shot list — thumbnail, filename, state, progress bar, per-shot **Retry** on `failed`,
  remove on `pending`.
- Uploads start the moment files are chosen. No submit button.

Large touch targets, no hover-only affordances, works at 360 px wide.

### 4. Home-screen install

`src/app/manifest.ts` (Next.js App Router manifest route) with `name: "Loupe"`,
`start_url: "/capture"`, `display: "standalone"`, theme/background colours from the existing
palette, and icons at `public/icons/loupe-192.png` and `public/icons/loupe-512.png` (a plain
"L" mark generated once; no design work). Next.js links the manifest automatically; the root
layout's `metadata` gains `appleWebApp: { capable: true, title: 'Loupe' }` so iOS installs too.

### 5. Errors and limits

Unchanged from D103: the 50 MB cap (`MANUAL_UPLOAD_MAX_BYTES`), MIME verification server-side,
per-file failure with an operator-facing sentence, retry re-runs the whole begin/put/finalize
sequence for that file. Phone JPEGs are 10–25 MB, well inside the cap. A dropped connection
mid-PUT surfaces as `failed` with the existing "could not reach private image storage" message.

### 6. Discoverability

One line on `/upload`: "On a phone? Open loupe…/capture and add it to your home screen." No
sidebar entry — the desktop shell does not need it.

## Data flow

```
phone camera app ──JPEG──▶ CaptureScreen
                              │ beginRawUploadAction (server action)
                              ▼
                        manual_uploads row (pending) + presigned PUT
                              │ putUploadedObject (browser → R2, manual/{id}/original.jpg)
                              ▼
                        finalizeRawUploadAction
                              │ verify object, intake_files (discovered, source=manual)
                              ▼
                        Identify → enhance → Console  (all existing)
```

## Testing

- `tests/raw-upload-runner.test.ts` — the pure runner with stubbed `begin`/`put`/`finalize`:
  happy path reports `uploading → verifying → queued`; `begin` failure, PUT failure and
  `finalize` failure each land in `failed` carrying the message; one bad file never stops the
  others; at most three run at once. The hook is a thin state wrapper and is covered by the
  acceptance run rather than a DOM test.
- Existing `UploadScreen` behaviour must not change: `npx tsc --noEmit`, eslint, and the
  existing test suite stay green.
- Acceptance (recorded in `docs/PROGRESS.md`): a real shot from an Android phone at
  `/capture` on production appears in Identify; the `intake_files` row and R2 key are quoted.

## Decisions to record

- **D-next:** the phone entry point is a separate route outside the shell rather than a
  responsive shell. Reasoning: one screen needs a phone; making the whole workspace responsive
  is unrequested work with regression risk across every section.
- **D-next:** camera capture via `<input capture>`, never `getUserMedia`. Reasoning: the camera
  app's own processing and full resolution are the whole point; a web stream gives neither.
