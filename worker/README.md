# loupe-worker

The vision half of Loupe's SKU matcher (D111). It runs on the owner's Windows laptop (RTX 3050) and does
three things, all through Loupe's `/api/worker/*` with one shared secret — it never holds a database, R2 or
Drive credential:

| job | what it does | when |
|---|---|---|
| `sync` | downloads an original into `LOUPE_LOCAL_ROOT/originals/<SKU>/<reference-id>.<ext>` with a JSON sidecar (SKU, handle, sha256, source) and a row in `index.sqlite` | any time |
| `embed` | SigLIP2-so400m/512 + u2net crop, two views per reference, posted back as vectors that Loupe stores in pgvector | nightly |
| `identify` | embeds a photograph waiting in Identify and posts the vector; Loupe turns it into the ten candidates | daytime, within seconds |

## Install (Windows, once)

```bat
py -3.11 -m venv .venv
.venv\Scripts\activate
pip install torch --index-url https://download.pytorch.org/whl/cu124
pip install -e .
python get-weights.py            rem 1.72 GB, resumable
copy .env.example .env           rem then fill WORKER_SECRET (same as the server .env) and LOUPE_LOCAL_ROOT
mkdir logs
loupe-worker run --kinds identify --max-jobs 1
```

The last command must print `model ready on cuda` and then either process one job or `queue empty`.

## Schedule (Task Scheduler)

- **At log on**, run `run-daytime.bat` (`--kinds sync,identify --daemon`). Identify answers while the laptop is on.
- **Daily 02:00**, run `run-nightly.bat` (`--kinds sync,embed --until-empty`). Tick "Wake the computer to run this task"
  and "Run whether user is logged on or not". Logs land in `logs\nightly-YYYYMMDD.log`.

## What "resumable and traceable" means here

Every job is leased with a token; a crash leaves the job claimable again after ten minutes. Every completion is
fenced by that token, so a stale worker cannot overwrite a newer one. Loupe records each transition
(`match.requested`, `match.matched`, `match.job_failed`, …) in its `events` table; each reference's status
(`pending_sync → synced → queued → indexed`) is on `match_references`. The local `index.sqlite` and the sidecars
are the laptop's own record of what it holds.

## CPU fallback on a VPS

`Dockerfile` builds the same worker for CPU (`--kinds identify --claim-delay 5`): it answers Identify in ~10 s when
the laptop is offline and steps back when the laptop is online (the 5 s delay lets the GPU worker claim first).

## CPU fallback on a Mac

Same package, `--device cpu`, about 4 s per identify and 5 s per embed on an M1. Torch and onnxruntime each
ship their own libomp on macOS, so run with `KMP_DUPLICATE_LIB_OK=TRUE` or the process aborts with
`OMP: Error #15` before the model loads. When a second machine later takes over, `npm run match:resync -- --apply`
queues a sync of every already-indexed original for it; that never re-embeds.
