# Qimati agent runner (D143)

Runs on the Canada VPS (`vps-f7d37609.vps.ovh.ca`, Ubuntu 26.04). Every 30 seconds it asks Loupe for one
queued Enhance job, downloads the phone photos, runs Claude Code with the `enhance` skill on them, and reports
back. The finals of new pieces arrive in Loupe's Pending grid through `POST /api/agent/images` (D142). A photo
judged a restock, or a possible one, is not rendered: it goes to the Restock section through
`POST /api/agent/restocks` (D148) and the owner picks use old image, generate new image or wrong restock. The batch folder stays under `/home/ubuntu/agent-batches/<label>/` with `claude.log` and `SUMMARY.md`.

## Install (once)

```sh
# Node 22, the two CLIs, Python tooling (done 2026-10-10)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs python3-venv rsync git
sudo npm i -g @anthropic-ai/claude-code @openai/codex
# The agent's brain, synced from the Mac: ~/.claude/skills, ~/.claude/projects/-home-ubuntu/memory,
# ~/Desktop/AI-Python (restock index + weights, venv at ~/Desktop/agent-venv), ~/.u2net, ~/Desktop/Qimati Memory (git mirror ~/qimati-memory.git)
# Secrets (owner-run from the Mac): sh ~/Desktop/Qimati/SERVERS/canada-agent-secrets.sh  -> ~/Desktop/.env, Qimati SEO credentials, /etc/qimati-agent/runner.env
# Logins, interactive, once:
claude login
codex login
CODEX_HOME=$HOME/.codex-2 codex login
# Runner files
sudo mkdir -p /opt/qimati-agent /etc/qimati-agent
sudo cp deploy/agent-runner/agent-runner.sh /opt/qimati-agent/ && sudo chmod 755 /opt/qimati-agent/agent-runner.sh
sudo cp deploy/agent-runner/run-job.prompt.md /etc/qimati-agent/
sudo cp deploy/agent-runner/qimati-agent-runner.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now qimati-agent-runner.timer
```

`/etc/qimati-agent/runner.env` (mode 600): `LOUPE_BASE_URL`, `AGENT_SECRET` (same value as the Loupe server's),
`RUNNER_NAME`, optional `WORK_DIR`, `CLAUDE_BIN`, `CLAUDE_TIMEOUT`, `ALLOWED_TOOLS`.

## Operate

- A batch is split into parts of up to `PART_SIZE` photos (default 5), at most `MAX_PARTS` (default 3), each worked by its own Claude Code session at the same time in `<label>/part-N/`; the catalogue matcher (`restock.py match part-1 part-2 …`) starts when the job is claimed and writes each part's sheets as it goes (`matcher.log`, `matcher.done`). 6 photos in two parts: 4 min 10 s (2026-10-10); one session doing 15 in sequence had taken 25.
- Job kinds: `batch` as above; `redo` (D145, one image sent back with a note, the render replaces it in place); `render` (D148, one photo the owner sent on from the Restock section, `restock` in `job.json` naming the old product or null for a new piece). `redo` and `render` run as one session on the job folder, about 4 minutes each, one after another.
- Same design under several SKUs: the session records `restock.py verdict <folder> <n> old <handle> "<note>" --also <handle> ...`; the push tool reads every named listing live (stock, price, status, image, creation date) and Loupe shows the latest first.
- Try it without Loupe: `LOCAL_FOLDER=<folder of photos> PUSH_FLAG=--dry /opt/qimati-agent/agent-runner.sh` (nothing claimed, reported or delivered).
- Logs: `~/agent-batches/runner.log`, per job `~/agent-batches/<label>/claude.log`; `journalctl -u qimati-agent-runner`.
- One job by hand: `sudo systemctl start qimati-agent-runner.service` (or `ENV_FILE=/etc/qimati-agent/runner.env /opt/qimati-agent/agent-runner.sh`).
- Claude runs with an explicit tool allowlist (`ALLOWED_TOOLS` in the script): file tools plus `python3`, the restock venv, `qdb`, `codex` and a few coreutils. No shell escape, no git, no permission bypass.
- A job that fails is marked `failed` in `/enhance` with the last log lines; the folder is kept for a re-run (`agent_job_claim` picks up running jobs whose lease lapsed).
- Codex credits: the renders spend the two Codex accounts (`~/.codex`, `~/.codex-2`). When both are out, `enhance.py codex` reports it and the job fails with that reason.
