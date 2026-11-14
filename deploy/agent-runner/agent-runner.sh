#!/usr/bin/env bash
# Qimati agent runner (D143): claims one Enhance job from Loupe, downloads its photos, runs Claude Code on
# them with the enhance skill, and reports the result back. One pass per invocation; the systemd timer
# calls it every 30 seconds. Never deletes a batch folder.
#
# Since D170 (2026-11-14) a job is worked in passes: one claim takes at most MAX_PHOTOS photographs, Loupe sends
# back to the queue whatever was not delivered, and the pass ends with what happened (ok, limit, login, error).
# Before claiming, the runner looks at $STATE_DIR: a `paused` file, a `hold` file (until a limit resets, or a
# sign-in), and the limits agent-control.py last read. It works without that service too.
#
# Job kinds: batch (phone photos, split into parts), redo (D145: one image sent back with a note) and render
# (D148: one photo the owner sent on from the Restock section). A restock is never rendered here by itself:
# the push tool sends it to the Restock section and the owner decides.
#
# Since 2026-10-10 a batch is split into parts that parallel Claude sessions work on at once, and the
# catalogue matcher starts the moment the job is claimed: one session doing 15 photos in sequence took
# 25 minutes, almost all of it one model reading and writing.
#
#   agent-runner.sh                      claim and run one job
#   LOCAL_FOLDER=<folder> agent-runner.sh   run the same pipeline on a folder of photos, nothing claimed or reported
#                                           (use with PUSH_FLAG=--dry to keep it out of Loupe)
set -euo pipefail

ENV_FILE="${ENV_FILE:-/etc/qimati-agent/runner.env}"
# shellcheck disable=SC1090
[ -f "$ENV_FILE" ] && . "$ENV_FILE"
: "${LOUPE_BASE_URL:?set LOUPE_BASE_URL in $ENV_FILE}"
: "${AGENT_SECRET:?set AGENT_SECRET in $ENV_FILE}"
RUNNER_NAME="${RUNNER_NAME:-canada-1}"
WORK_DIR="${WORK_DIR:-$HOME/agent-batches}"
NOTE_FILE="${NOTE_FILE:-$WORK_DIR/next-batch-note.md}"  # 2026-10-16: the owner's instructions for the next batch only; moved into the job folder on claim. A first line `match: --category=anklets` goes to the matcher, the rest to every session.
CLAUDE_BIN="${CLAUDE_BIN:-claude}"
PROMPT_FILE="${PROMPT_FILE:-/etc/qimati-agent/run-job.prompt.md}"
LEASE_SECONDS="${LEASE_SECONDS:-1800}"
CLAUDE_TIMEOUT="${CLAUDE_TIMEOUT:-45m}"
PART_SIZE="${PART_SIZE:-5}"     # photos one session handles
MAX_PARTS="${MAX_PARTS:-3}"     # sessions at once; the host has 7 GB beside n8n and Chatwoot
MAX_PHOTOS="${MAX_PHOTOS:-15}"  # photographs one pass takes; the rest of the batch waits its turn
LOW_PHOTOS="${LOW_PHOTOS:-5}"   # ...and this many when the Codex seats are nearly used up (calibrate against real batches)
STATE_DIR="${STATE_DIR:-$WORK_DIR/.state}"
CONTROL_PY="${CONTROL_PY:-/opt/qimati-agent/agent-control.py}"
PUSH_FLAG="${PUSH_FLAG:---apply}"
MATCH_PY="${MATCH_PY:-$HOME/Desktop/AI-Python/.venv/bin/python}"
# Everything the enhance skill needs, nothing more: no shell escape, no git, no network beyond python's own calls.
ALLOWED_TOOLS="${ALLOWED_TOOLS:-Read,Write,Edit,Glob,Grep,Bash(python3:*),Bash($HOME/Desktop/AI-Python/.venv/bin/python:*),Bash(qdb:*),Bash(ls:*),Bash(mkdir:*),Bash(cp:*),Bash(mv:*),Bash(cat:*),Bash(head:*),Bash(tail:*),Bash(wc:*),Bash(unzip:*),Bash(sleep:*),Bash(pgrep:*),Bash(codex:*)}"

api() {  # api <method> <path> [json body]
  local method="$1" path="$2" body="${3:-}"
  if [ -n "$body" ]; then
    curl -fsS -X "$method" "$LOUPE_BASE_URL$path" -H "Authorization: Bearer $AGENT_SECRET" -H 'Content-Type: application/json' -H 'User-Agent: qimati-agent-runner' --data "$body"
  else
    curl -fsS -X "$method" "$LOUPE_BASE_URL$path" -H "Authorization: Bearer $AGENT_SECRET" -H 'User-Agent: qimati-agent-runner'
  fi
}
json() { python3 -c 'import json,sys; d=json.load(sys.stdin); print(eval(sys.argv[1]))' "$1"; }
stamp() { date -u +%FT%TZ; }
say() { echo "$(stamp) $*" >> "$WORK_DIR/runner.log"; }  # the page shows the tail of this file: write for the owner
mkdir -p "$STATE_DIR"

local_run=0
if [ -n "${LOCAL_FOLDER:-}" ]; then
  local_run=1; folder="$(cd "$LOCAL_FOLDER" && pwd)"; label="$(basename "$folder")"; job_id="local"; kind="batch"
else
  # Preflight: prints how many photographs to take, or nothing when this is not the moment to claim.
  max_photos=$(python3 - "$STATE_DIR" "$MAX_PHOTOS" "$LOW_PHOTOS" <<'PY'
import json, os, sys, time
state, full, low = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
def load(name):
    try: return json.load(open(os.path.join(state, name)))
    except Exception: return None
if os.path.exists(os.path.join(state, "paused")): sys.exit(0)
hold = load("hold")
if hold:
    if float(hold.get("until") or 0) > time.time(): sys.exit(0)
    os.remove(os.path.join(state, "hold"))
limits = load("limits.json")
if not limits or time.time() - float(limits.get("at") or 0) > 600:
    print(full); sys.exit(0)  # the control service is not running: go on as before
if limits.get("claude", {}).get("signed_in") is False: sys.exit(0)
seats = [c for c in limits.get("codex", []) if c.get("signed_in") and c.get("five_hour") is not None]
if seats:
    free = [c for c in seats if c["five_hour"] < 98 and (c.get("week") is None or c["week"] < 98)]
    if not free:
        resets = [c.get("five_hour_resets_epoch") or 0 for c in seats if c.get("week") is None or c["week"] < 98] or [time.time() + 3600]
        json.dump({"until": max(min(resets), time.time() + 300), "reason": "limit", "note": "Every Codex seat is used up."}, open(os.path.join(state, "hold"), "w"))
        sys.exit(0)
    if sum(100 - c["five_hour"] for c in free) < 30: full = low
print(full)
PY
)
  [ -n "$max_photos" ] || exit 0
  claim=$(api POST /api/agent/jobs "{\"action\":\"claim\",\"runner\":\"$RUNNER_NAME\",\"lease_seconds\":$LEASE_SECONDS,\"max_photos\":$max_photos}")
  if [ "$(printf '%s' "$claim" | json 'd["job"] is None')" = "True" ]; then exit 0; fi
  job_id=$(printf '%s' "$claim" | json 'd["job"]["id"]')
  label=$(printf '%s' "$claim" | json 'd["job"]["label"]')
  kind=$(printf '%s' "$claim" | json 'd["job"].get("kind") or "batch"')
  folder="$WORK_DIR/$label"
  mkdir -p "$folder"
  printf '%s' "$claim" | json 'json.dumps(d["job"], indent=1)' > "$folder/job.json"
  if [ "$kind" = "batch" ] && [ -f "$NOTE_FILE" ]; then mv "$NOTE_FILE" "$folder/owner-note.md"; fi
  pass=$(printf '%s' "$claim" | json 'd["job"].get("pass") or 1')
  taken=$(printf '%s' "$claim" | json 'len(d["job"]["photos"])')
  printf '%s' "$claim" | json '"\n".join(p["filename"] for p in d["job"]["photos"])' > "$folder/.pass-photos"
  printf '%s\n' "$label" > "$STATE_DIR/current"
  say "started $label: $taken photos (pass $pass)$([ -f "$folder/owner-note.md" ] && echo ', with the owner note')"
  # Every photo once, four at a time, keeping the supplier's filenames.
  printf '%s' "$claim" | json '"\n".join(p["filename"]+"\t"+p["url"] for p in d["job"]["photos"])' > "$folder/.photos.tsv"
  python3 - "$folder" <<'PY'
import os, sys, subprocess
from concurrent.futures import ThreadPoolExecutor
folder = sys.argv[1]
rows = [l.rstrip("\n").split("\t", 1) for l in open(os.path.join(folder, ".photos.tsv")) if "\t" in l]
def get(row):
    dest = os.path.join(folder, row[0])
    if not (os.path.exists(dest) and os.path.getsize(dest) > 0):
        subprocess.run(["curl", "-fsS", "-o", dest, row[1]], check=True)
with ThreadPoolExecutor(4) as ex: list(ex.map(get, rows))
PY
  rm -f "$folder/.photos.tsv"
fi

report() {  # report <ok|limit|login|error> <note> <error> <count> [resume_at ISO]
  [ "$local_run" = 1 ] && { echo "[local] $1: $4 finals | $2 | $3"; return; }
  local body
  body=$(python3 -c 'import json,sys; print(json.dumps({"action":"pass","runner":sys.argv[2],"outcome":sys.argv[1],"note":sys.argv[3][:500],"error":sys.argv[4][:2000] or None,"result_count":int(sys.argv[5]),"resume_at":sys.argv[6] or None}))' "$1" "$RUNNER_NAME" "$2" "$3" "$4" "${5:-}")
  api POST "/api/agent/jobs/$job_id" "$body" > /dev/null || true
}

hb=""
if [ "$local_run" = 0 ]; then
  # Heartbeat while Claude works, so the lease does not lapse and a second runner never takes the job.
  ( while sleep 300; do api POST "/api/agent/jobs/$job_id" "{\"action\":\"heartbeat\",\"runner\":\"$RUNNER_NAME\",\"lease_seconds\":$LEASE_SECONDS}" > /dev/null 2>&1 || true; done ) &
  hb=$!
fi
trap '[ -n "$hb" ] && kill $hb 2>/dev/null || true; [ "$local_run" = 1 ] || rm -f "$STATE_DIR/current"' EXIT

run_claude() {  # run_claude <work folder> : one Claude Code session on that folder, its temp files kept apart from the other parts'
  local work="$1" prompt
  mkdir -p "$work/tmp"
  prompt="$(cat "$PROMPT_FILE")

Folder: $work
Job id: $job_id
Job label: $label
Push command: python3 -I ~/.claude/skills/enhance/loupe_push.py \"$work\" --batch \"$label\" $PUSH_FLAG"
  if [ -f "$folder/owner-note.md" ]; then prompt="$prompt

Owner's note for this batch. It wins over SKILL.md and the steps above where they differ:
$(grep -v '^match:' "$folder/owner-note.md")"; fi
  ( cd "$HOME" && printf '%s' "$prompt" | TMPDIR="$work/tmp" timeout "$CLAUDE_TIMEOUT" "$CLAUDE_BIN" -p --output-format text --allowedTools "$ALLOWED_TOOLS" ) > "$work/claude.log" 2>&1  # prompt on stdin: `-p` with flags after it reads no positional prompt
}

set +e
parts=()
if [ "$kind" = "redo" ] || [ "$kind" = "render" ]; then
  # A second try of the same folder must not count the first try's push record.
  [ -f "$folder/loupe-push.json" ] && mv "$folder/loupe-push.json" "$folder/loupe-push.$(date -u +%H%M%S).json"
  parts=("$folder"); run_claude "$folder"; status=$?
else
  if [ -f "$folder/.pass-photos" ]; then  # this pass's photographs only; earlier passes keep their own parts
    mapfile -t photos < <(while IFS= read -r f; do [ -f "$folder/$f" ] && printf '%s\n' "$folder/$f"; done < "$folder/.pass-photos" | sort)
  else
    mapfile -t photos < <(find "$folder" -maxdepth 1 -type f \( -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.png' -o -iname '*.webp' -o -iname '*.heic' \) | sort)
  fi
  # Parts are numbered on from the last pass (restock.py learn reads the batch label from the parent of part-N).
  base=$(find "$folder" -maxdepth 1 -type d -name 'part-*' | sed 's/.*part-//' | sort -n | tail -1); base=${base:-0}
  n=${#photos[@]}
  k=$(( (n + PART_SIZE - 1) / PART_SIZE )); [ "$k" -gt "$MAX_PARTS" ] && k=$MAX_PARTS; [ "$k" -lt 1 ] && k=1
  size=$(( (n + k - 1) / k )); [ "$size" -lt 1 ] && size=1
  for ((p = 0; p < k; p++)); do
    d="$folder/part-$((base + p + 1))"; mkdir -p "$d/new"
    for f in "${photos[@]:p*size:size}"; do ln -f "$f" "$d/" 2>/dev/null || cp -f "$f" "$d/"; ln -f "$f" "$d/new/" 2>/dev/null || cp -f "$f" "$d/new/"; done
    [ -n "$(find "$d" -maxdepth 1 -type f -print -quit)" ] && parts+=("$d")
  done
  # The catalogue matcher for every part: one model load, started before any session, each part's sheets written as soon as it is done.
  match_args=$(sed -n 's/^match: *//p' "$folder/owner-note.md" 2>/dev/null)  # e.g. --category=anklets
  # shellcheck disable=SC2086
  ( "$MATCH_PY" "$HOME/Desktop/AI-Python/restock.py" match "${parts[@]}" $match_args > "$folder/matcher.log" 2>&1; echo $? > "$folder/matcher.done" ) &
  pids=()
  for d in "${parts[@]}"; do run_claude "$d" & pids+=($!); done
  status=0; for pid in "${pids[@]}"; do wait "$pid" || status=$?; done
fi
set -e
[ -n "$hb" ] && kill $hb 2>/dev/null || true

# What actually reached Loupe, and the lines each session wants the owner to read.
summary=$(python3 - "$folder" "${parts[@]}" <<'PY'
import collections, json, os, sys
root, parts = sys.argv[1], sys.argv[2:]
tags, ok, lines, dead = collections.Counter(), 0, [], []
for d in parts:
    p = os.path.join(d, "loupe-push.json")
    if os.path.exists(p):
        for r in json.load(open(p)):
            if r.get("result", {}).get("ok"):
                ok += 1; tags[r["tag"]] += 1
    else:
        dead.append(os.path.basename(d))
    s = os.path.join(d, "SUMMARY.md")
    if os.path.exists(s):
        lines += [l.strip() for l in open(s) if l.strip().startswith("-")]
try: photos = sum(1 for l in open(os.path.join(root, ".pass-photos")) if l.strip())
except OSError: photos = sum(1 for f in os.listdir(root) if f.lower().endswith((".jpg", ".jpeg", ".png", ".webp", ".heic")))
names = {"restock_candidate": "waiting in Restock"}
head = f"{photos} photos, {ok} delivered" + (": " + ", ".join(f"{v} {names.get(k, k.replace('_', ' '))}" for k, v in tags.most_common()) if tags else "")
if dead and len(parts) > 1:
    head += f". No delivery from {', '.join(dead)}"
print(ok)
print((head + ".\n" + "\n".join(lines))[:500])
PY
)
count=$(printf '%s\n' "$summary" | head -1)
note=$(printf '%s\n' "$summary" | tail -n +2)
printf '%s\n' "$note" > "$folder/SUMMARY.md"
[ "$local_run" = 0 ] && printf '%s\n' "$note" > "$folder/SUMMARY-pass-${pass:-1}.md"

if [ "$local_run" = 0 ] && command -v qdb > /dev/null 2>&1; then  # one vault entry per job, written here so parallel sessions never race on the log
  qdb add paid-render "Canada runner, Enhance job $label ($job_id): $(printf '%s' "$note" | head -1)" "$(printf '%s' "$note" | tail -n +2 | tr '\n' ' ' | cut -c1-600)" "Folder $folder; parts: ${#parts[@]}; kind: $kind." > /dev/null 2>&1 || true
fi

if [ "$local_run" = 1 ]; then
  report "$([ "$status" -eq 0 ] && echo ok || echo error)" "$note" "claude exit $status" "${count:-0}"
  exit "$status"
fi

# What happened, for Loupe. Loupe itself decides which photographs landed (it holds the deliveries); the runner only
# says why the pass ended, so a limit or a lost sign-in costs no photograph one of its three tries.
tails=""; for d in "${parts[@]}"; do tails="$tails$(basename "$d"): $(tail -n 8 "$d/claude.log" 2>/dev/null)
"; done
logs=$(for d in "${parts[@]}"; do tail -n 40 "$d/claude.log" 2>/dev/null; done)
outcome=ok; resume=""; why=""
[ "$status" -ne 0 ] && { outcome=error; why="claude exit $status. $tails"; }
if [ "${count:-0}" -lt "${taken:-0}" ]; then
  [ -z "$why" ] && why="The session ended without delivering this photo. $tails"
  if printf '%s' "$logs" | grep -qiE 'OAuth session expired|Failed to authenticate|authentication_error|Invalid API key|Please run /login'; then
    outcome=login; why="Claude is signed out on the server."
  else
    # Fresh limits, to tell "ran out" from "went wrong" and to know when to start again.
    fresh=$(python3 "$CONTROL_PY" --limits 2>/dev/null || echo '{}')
    verdict=$(printf '%s' "$fresh" | python3 -c '
import json, sys, time, datetime
d = json.load(sys.stdin); claude_hit = sys.argv[1] == "1"; out = None
c = d.get("claude") or {}
iso = lambda e: datetime.datetime.fromtimestamp(e, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
if claude_hit or (c.get("five_hour") or 0) >= 98 or (c.get("week") or 0) >= 98:
    e = c.get("week_resets_epoch") if (c.get("week") or 0) >= 98 else c.get("five_hour_resets_epoch")
    out = (e or time.time() + 3600, "Claude reached its limit.")
else:
    seats = [s for s in d.get("codex", []) if s.get("signed_in") and s.get("five_hour") is not None]
    if seats and all(s["five_hour"] >= 98 or (s.get("week") or 0) >= 98 for s in seats):
        e = min((s.get("week_resets_epoch") if (s.get("week") or 0) >= 98 else s.get("five_hour_resets_epoch")) or time.time() + 3600 for s in seats)
        out = (e, "Every Codex seat reached its limit.")
if out: print(iso(max(out[0], time.time() + 300)) + "\t" + out[1])
' "$(printf '%s' "$logs" | grep -qiE "hit your (session|usage|weekly) limit|usage limit reached" && echo 1 || echo 0)")
    if [ -n "$verdict" ]; then outcome=limit; resume=${verdict%%$'\t'*}; why=${verdict#*$'\t'}; fi
  fi
fi

case "$outcome" in
  limit) python3 -c 'import json,sys,datetime; json.dump({"until": datetime.datetime.fromisoformat(sys.argv[1].replace("Z","+00:00")).timestamp(), "reason": "limit", "note": sys.argv[2]}, open(sys.argv[3], "w"))' "$resume" "$why" "$STATE_DIR/hold"
         say "paused $label: $why $count of $taken delivered; the rest wait in the queue and start again at $(TZ=Asia/Kolkata date -d "$resume" '+%-I:%M %p') India time" ;;
  login) # Without the control service nobody clears this, so it lapses by itself and the runner tries again.
         python3 -c 'import json,sys,time; json.dump({"until": time.time() + 900, "reason": "login", "note": sys.argv[1]}, open(sys.argv[2], "w"))' "$why" "$STATE_DIR/hold"
         say "stopped $label: Claude is signed out. Nothing is lost; the photos wait in the queue until someone signs in" ;;
  error) say "trouble in $label: $count of $taken delivered (claude exit $status); the others go back to the queue" ;;
  *)     if [ "${count:-0}" -ge "${taken:-0}" ]; then say "finished pass $pass of $label: $count of $taken delivered"
         else say "finished pass $pass of $label: $count of $taken delivered; the others go back to the queue"; fi ;;
esac
report "$outcome" "$note" "$([ "$outcome" = ok ] && [ "${count:-0}" -ge "${taken:-0}" ] || printf '%s' "$why")" "${count:-0}" "$resume"
