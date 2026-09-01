#!/usr/bin/env bash
# Production deploy for Loupe on the Qimati VPS (see "Production server" in CLAUDE.md).
#
# Runs ON THE SERVER as `ubuntu`. GitHub Actions triggers it on every push to main
# (.github/workflows/deploy.yml) through the forced command on the CI key in
# ~/.ssh/authorized_keys, which first fast-forwards ~/loupe/repo to origin/main.
# Manual run:  ssh ubuntu@<server> 'cd ~/loupe/repo && git pull -q && bash scripts/deploy.sh'
#
# Layout:
#   ~/loupe/repo/        git checkout of main (source only, never served)
#   ~/loupe/releases/<utc-stamp>-<sha>/   one built tree per deploy
#   ~/loupe/current  ->  the release systemd serves (symlink, swapped atomically)
#   ~/loupe/shared/.env  runtime secrets, symlinked into every release
#
# A failed build leaves the running release untouched. A release that does not
# answer on its port within 60 s is rolled back to the previous one.
set -euo pipefail

ROOT=/home/ubuntu/loupe
REPO=$ROOT/repo
SHA=$(git -C "$REPO" rev-parse --short HEAD)
RELEASE=$ROOT/releases/$(date -u +%Y%m%d-%H%M%S)-$SHA
PORT=3000

echo "==> building $SHA in $RELEASE"
mkdir -p "$RELEASE"
git -C "$REPO" archive HEAD | tar -x -C "$RELEASE"
ln -s "$ROOT/shared/.env" "$RELEASE/.env"
cd "$RELEASE"
export NEXT_TELEMETRY_DISABLED=1
npm ci --no-audit --no-fund
npm run build

echo "==> installing service + nginx config"
sudo install -m 644 deploy/loupe.service /etc/systemd/system/loupe.service
sudo install -m 644 deploy/loupe.nginx.conf /etc/nginx/sites-available/loupe
sudo ln -sfn /etc/nginx/sites-available/loupe /etc/nginx/sites-enabled/loupe
sudo nginx -t
sudo systemctl daemon-reload

PREVIOUS=$(readlink -f "$ROOT/current" 2>/dev/null || true)
switch() { ln -sfn "$1" "$ROOT/current.new" && mv -T "$ROOT/current.new" "$ROOT/current"; }

echo "==> switching traffic"
switch "$RELEASE"
sudo systemctl enable -q loupe
sudo systemctl restart loupe
sudo systemctl reload nginx

for _ in $(seq 1 30); do
  if curl -sf -o /dev/null "http://127.0.0.1:$PORT/"; then
    ls -1dt "$ROOT"/releases/* | tail -n +4 | xargs -r rm -rf
    echo "==> live: $SHA"
    exit 0
  fi
  sleep 2
done

echo "!! $SHA never answered on :$PORT — rolling back to ${PREVIOUS:-nothing}" >&2
sudo journalctl -u loupe -n 40 --no-pager >&2 || true
if [ -n "$PREVIOUS" ]; then switch "$PREVIOUS"; sudo systemctl restart loupe; fi
exit 1
