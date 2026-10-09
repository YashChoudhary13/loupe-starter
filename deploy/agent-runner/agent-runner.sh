#!/usr/bin/env bash
# Qimati agent runner (D143): claims one Enhance job from Loupe, downloads its photos, runs Claude Code
# on them with the enhance skill, and reports the result back. One pass per invocation; the systemd
# timer calls it every two minutes. Never deletes a batch folder.
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
CLAUDE_TIMEOUT="${CLAUDE_TIMEOUT:-90m}"
# Everything the enhance skill needs, nothing more: no shell escape, no git, no network beyond python's own calls.
ALLOWED_TOOLS="${ALLOWED_TOOLS:-Read,Write,Edit,Glob,Grep,Bash(python3:*),Bash($HOME/Desktop/AI-Python/.venv/bin/python:*),Bash(qdb:*),Bash(ls:*),Bash(mkdir:*),Bash(cp:*),Bash(mv:*),Bash(cat:*),Bash(head:*),Bash(tail:*),Bash(wc:*),Bash(unzip:*),Bash(sleep:*),Bash(pgrep:*),Bash(codex:*)}"

api() {  # api <method> <path> [json body]
  local method="$1" path="$2" body="${3:-}"
  if [ -n "$body" ]; then
    curl -fsS -X "$method" "$LOUPE_BASE_URL$path" -H "Authorization: Bearer $AGENT_SECRET" -H 'Content-Type: application/json' --data "$body"
  else
    curl -fsS -X "$method" "$LOUPE_BASE_URL$path" -H "Authorization: Bearer $AGENT_SECRET"
  fi
}

json() { python3 -c 'import json,sys; d=json.load(sys.stdin); print(eval(sys.argv[1]))' "$1"; }

claim=$(api POST /api/agent/jobs "{\"action\":\"claim\",\"runner\":\"$RUNNER_NAME\",\"lease_seconds\":$LEASE_SECONDS}")
if [ "$(printf '%s' "$claim" | json 'd["job"] is None')" = "True" ]; then exit 0; fi
job_id=$(printf '%s' "$claim" | json 'd["job"]["id"]')
label=$(printf '%s' "$claim" | json 'd["job"]["label"]')
folder="$WORK_DIR/$label"
mkdir -p "$folder"
printf '%s' "$claim" | json 'json.dumps(d["job"], indent=1)' > "$folder/job.json"
echo "$(date -u +%FT%TZ) claimed $job_id ($label)" >> "$WORK_DIR/runner.log"

# Download every photo once, keeping the supplier's filenames.
printf '%s' "$claim" | json '"\n".join(p["filename"]+"\t"+p["url"] for p in d["job"]["photos"])' | while IFS=$'\t' read -r name url; do
  [ -s "$folder/$name" ] || curl -fsS -o "$folder/$name" "$url"
done

report() {  # report <done|failed> <note> <error> <count>
  local body
  body=$(python3 -c 'import json,sys; print(json.dumps({"action":sys.argv[1],"runner":sys.argv[2],"note":sys.argv[3][:500],"error":sys.argv[4][:2000],"result_count":int(sys.argv[5])}))' "$1" "$RUNNER_NAME" "$2" "$3" "$4")
  api POST "/api/agent/jobs/$job_id" "$body" > /dev/null || true
}

# Heartbeat while Claude works, so the lease does not lapse and a second runner never takes the job.
( while sleep 300; do api POST "/api/agent/jobs/$job_id" "{\"action\":\"heartbeat\",\"runner\":\"$RUNNER_NAME\",\"lease_seconds\":$LEASE_SECONDS}" > /dev/null 2>&1 || true; done ) &
hb=$!
trap 'kill $hb 2>/dev/null || true' EXIT

prompt="$(cat "$PROMPT_FILE")

Folder: $folder
Job id: $job_id
Job label: $label"

set +e
( cd "$HOME" && timeout "$CLAUDE_TIMEOUT" "$CLAUDE_BIN" -p --output-format text --allowedTools "$ALLOWED_TOOLS" "$prompt" ) > "$folder/claude.log" 2>&1
status=$?
set -e
kill $hb 2>/dev/null || true

count=0
[ -f "$folder/loupe-push.json" ] && count=$(python3 -c 'import json,sys; print(sum(1 for r in json.load(open(sys.argv[1])) if r.get("result",{}).get("ok")))' "$folder/loupe-push.json")
note=""
[ -f "$folder/SUMMARY.md" ] && note=$(head -c 500 "$folder/SUMMARY.md")

if [ "$status" -eq 0 ]; then
  report done "$note" "" "$count"
  echo "$(date -u +%FT%TZ) done $job_id: $count finals" >> "$WORK_DIR/runner.log"
else
  report failed "$note" "claude exit $status: $(tail -n 20 "$folder/claude.log")" "$count"
  echo "$(date -u +%FT%TZ) FAILED $job_id (exit $status)" >> "$WORK_DIR/runner.log"
  exit "$status"
fi
