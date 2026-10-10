#!/usr/bin/env bash
# Qimati agent runner (D143): claims one Enhance job from Loupe, downloads its photos, runs Claude Code on
# them with the enhance skill, and reports the result back. One pass per invocation; the systemd timer
# calls it every 30 seconds. Never deletes a batch folder.
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
CLAUDE_BIN="${CLAUDE_BIN:-claude}"
PROMPT_FILE="${PROMPT_FILE:-/etc/qimati-agent/run-job.prompt.md}"
LEASE_SECONDS="${LEASE_SECONDS:-1800}"
CLAUDE_TIMEOUT="${CLAUDE_TIMEOUT:-45m}"
PART_SIZE="${PART_SIZE:-5}"     # photos one session handles
MAX_PARTS="${MAX_PARTS:-3}"     # sessions at once; the host has 7 GB beside n8n and Chatwoot
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

local_run=0
if [ -n "${LOCAL_FOLDER:-}" ]; then
  local_run=1; folder="$(cd "$LOCAL_FOLDER" && pwd)"; label="$(basename "$folder")"; job_id="local"; kind="batch"
else
  claim=$(api POST /api/agent/jobs "{\"action\":\"claim\",\"runner\":\"$RUNNER_NAME\",\"lease_seconds\":$LEASE_SECONDS}")
  if [ "$(printf '%s' "$claim" | json 'd["job"] is None')" = "True" ]; then exit 0; fi
  job_id=$(printf '%s' "$claim" | json 'd["job"]["id"]')
  label=$(printf '%s' "$claim" | json 'd["job"]["label"]')
  kind=$(printf '%s' "$claim" | json 'd["job"].get("kind") or "batch"')
  folder="$WORK_DIR/$label"
  mkdir -p "$folder"
  printf '%s' "$claim" | json 'json.dumps(d["job"], indent=1)' > "$folder/job.json"
  echo "$(stamp) claimed $job_id ($label)" >> "$WORK_DIR/runner.log"
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

report() {  # report <done|failed> <note> <error> <count>
  [ "$local_run" = 1 ] && { echo "[local] $1: $4 finals | $2 | $3"; return; }
  local body
  body=$(python3 -c 'import json,sys; print(json.dumps({"action":sys.argv[1],"runner":sys.argv[2],"note":sys.argv[3][:500],"error":sys.argv[4][:2000],"result_count":int(sys.argv[5])}))' "$1" "$RUNNER_NAME" "$2" "$3" "$4")
  api POST "/api/agent/jobs/$job_id" "$body" > /dev/null || true
}

hb=""
if [ "$local_run" = 0 ]; then
  # Heartbeat while Claude works, so the lease does not lapse and a second runner never takes the job.
  ( while sleep 300; do api POST "/api/agent/jobs/$job_id" "{\"action\":\"heartbeat\",\"runner\":\"$RUNNER_NAME\",\"lease_seconds\":$LEASE_SECONDS}" > /dev/null 2>&1 || true; done ) &
  hb=$!
fi
trap '[ -n "$hb" ] && kill $hb 2>/dev/null || true' EXIT

run_claude() {  # run_claude <work folder> : one Claude Code session on that folder, its temp files kept apart from the other parts'
  local work="$1" prompt
  mkdir -p "$work/tmp"
  prompt="$(cat "$PROMPT_FILE")

Folder: $work
Job id: $job_id
Job label: $label
Push command: python3 -I ~/.claude/skills/enhance/loupe_push.py \"$work\" --batch \"$label\" $PUSH_FLAG"
  ( cd "$HOME" && printf '%s' "$prompt" | TMPDIR="$work/tmp" timeout "$CLAUDE_TIMEOUT" "$CLAUDE_BIN" -p --output-format text --allowedTools "$ALLOWED_TOOLS" ) > "$work/claude.log" 2>&1  # prompt on stdin: `-p` with flags after it reads no positional prompt
}

set +e
parts=()
if [ "$kind" = "redo" ]; then
  parts=("$folder"); run_claude "$folder"; status=$?
else
  mapfile -t photos < <(find "$folder" -maxdepth 1 -type f \( -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.png' -o -iname '*.webp' -o -iname '*.heic' \) | sort)
  n=${#photos[@]}
  k=$(( (n + PART_SIZE - 1) / PART_SIZE )); [ "$k" -gt "$MAX_PARTS" ] && k=$MAX_PARTS; [ "$k" -lt 1 ] && k=1
  size=$(( (n + k - 1) / k )); [ "$size" -lt 1 ] && size=1
  for ((p = 0; p < k; p++)); do
    d="$folder/part-$((p + 1))"; mkdir -p "$d/new"
    for f in "${photos[@]:p*size:size}"; do ln -f "$f" "$d/" 2>/dev/null || cp -f "$f" "$d/"; ln -f "$f" "$d/new/" 2>/dev/null || cp -f "$f" "$d/new/"; done
    [ -n "$(find "$d" -maxdepth 1 -type f -print -quit)" ] && parts+=("$d")
  done
  # The catalogue matcher for every part: one model load, started before any session, each part's sheets written as soon as it is done.
  ( "$MATCH_PY" "$HOME/Desktop/AI-Python/restock.py" match "${parts[@]}" > "$folder/matcher.log" 2>&1; echo $? > "$folder/matcher.done" ) &
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
photos = sum(1 for f in os.listdir(root) if f.lower().endswith((".jpg", ".jpeg", ".png", ".webp", ".heic")))
head = f"{photos} photos, {ok} delivered" + (": " + ", ".join(f"{v} {k.replace('_', ' ')}" for k, v in tags.most_common()) if tags else "")
if dead and len(parts) > 1:
    head += f". No delivery from {', '.join(dead)}"
print(ok)
print((head + ".\n" + "\n".join(lines))[:500])
PY
)
count=$(printf '%s\n' "$summary" | head -1)
note=$(printf '%s\n' "$summary" | tail -n +2)
printf '%s\n' "$note" > "$folder/SUMMARY.md"

if [ "$local_run" = 0 ] && command -v qdb > /dev/null 2>&1; then  # one vault entry per job, written here so parallel sessions never race on the log
  qdb add paid-render "Canada runner, Enhance job $label ($job_id): $(printf '%s' "$note" | head -1)" "$(printf '%s' "$note" | tail -n +2 | tr '\n' ' ' | cut -c1-600)" "Folder $folder; parts: ${#parts[@]}; kind: $kind." > /dev/null 2>&1 || true
fi

if [ "${count:-0}" -gt 0 ] || { [ "$status" -eq 0 ] && [ "$PUSH_FLAG" != "--apply" ]; }; then
  report done "$note" "" "${count:-0}"
  [ "$local_run" = 0 ] && echo "$(stamp) done $job_id: $count finals" >> "$WORK_DIR/runner.log"
else
  tails=""; for d in "${parts[@]}"; do tails="$tails$(basename "$d"): $(tail -n 8 "$d/claude.log" 2>/dev/null)
"; done
  report failed "$note" "claude exit $status. $tails" "${count:-0}"
  [ "$local_run" = 0 ] && echo "$(stamp) FAILED $job_id (exit $status)" >> "$WORK_DIR/runner.log"
  exit 1
fi
