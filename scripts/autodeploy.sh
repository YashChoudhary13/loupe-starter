#!/usr/bin/env bash
# Server-side deploy trigger: runs from the ubuntu crontab every minute, and when
# origin/main has moved past what ~/loupe/repo has, pulls it and runs deploy.sh.
# This is the path that always works — GitHub Actions on this account was billing-locked
# on 2026-09-01, so .github/workflows/deploy.yml is a bonus, not the mechanism.
#
#   crontab -l   →   * * * * * /home/ubuntu/loupe/repo/scripts/autodeploy.sh >> /home/ubuntu/loupe/shared/autodeploy.log 2>&1
#
# A commit whose build fails is not retried every minute: the repo already sits at that
# commit, so nothing happens until the next push. Read the log for the failure.
set -euo pipefail
REPO=/home/ubuntu/loupe/repo
git -C "$REPO" fetch -q origin main
[ "$(git -C "$REPO" rev-parse HEAD)" = "$(git -C "$REPO" rev-parse origin/main)" ] && exit 0
echo "==> $(date -u +%FT%TZ) origin/main moved to $(git -C "$REPO" rev-parse --short origin/main)"
git -C "$REPO" reset -q --hard origin/main
exec bash "$REPO/scripts/deploy.sh"
