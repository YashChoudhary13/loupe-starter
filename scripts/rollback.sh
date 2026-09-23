#!/usr/bin/env bash
# Instant rollback ON THE SERVER: serve an earlier, already-built release again and restart Loupe.
#
#   bash ~/loupe/repo/scripts/rollback.sh <short-sha> [--dry-run]        e.g. b7f5220
#
# Seconds, no rebuild. It holds until the next push to main, because autodeploy.sh acts only when
# origin/main moves. To make it permanent, revert the deploy commit on main and push:
#   git revert -m 1 <deploy-merge-sha> && git push origin main
# deploy.sh keeps the last three releases, so the target must be one of them. The nginx config and the
# systemd unit are not rolled back: an older release simply serves every name nginx sends it.
# Once AUTH_BASE_URL has moved to the Home origin (D136), revert it to https://loupe.qimati-eng.site in
# ~/loupe/shared/.env before rolling back to any pre-platform release (e.g. b7f5220): pre-platform code
# accepts QC scans and label prints only from the AUTH_BASE_URL origin and cannot finish sign-in on the Home host.
set -euo pipefail
ROOT=${LOUPE_ROOT:-/home/ubuntu/loupe}
SHA=${1:?usage: rollback.sh <short-sha> [--dry-run]}
# Serve only a release deploy.sh marked complete: it touches .deploy-complete once `npm run build` succeeds, and
# marks the release live when it runs, which covers releases built before the mark existed. .next/BUILD_ID is
# no proof: next build writes it part-way through, so a build that died later still has one.
check_target() {
  TARGET=$(ls -1d "$ROOT"/releases/*-"$SHA" 2>/dev/null | tail -1 || true)
  if [ -z "$TARGET" ] || [ ! -f "$TARGET/.deploy-complete" ]; then
    echo "no complete release for $SHA; complete releases kept:" >&2
    for dir in "$ROOT"/releases/*/; do if [ -f "$dir.deploy-complete" ]; then basename "$dir" >&2; fi; done
    exit 1
  fi
}
check_target
if [ "$(readlink -f "$ROOT/current")" = "$(readlink -f "$TARGET")" ]; then echo "==> $(basename "$TARGET") is already live"; exit 0; fi
if [ "${2:-}" = "--dry-run" ]; then echo "would serve $(basename "$TARGET")"; exit 0; fi

exec 9>"$ROOT/deploy.lock"; flock 9
# A deploy that held the lock meanwhile may have pruned the target; switching to it would leave current dangling.
check_target
ln -sfn "$TARGET" "$ROOT/current.new" && mv -T "$ROOT/current.new" "$ROOT/current"
sudo systemctl restart loupe
echo "==> serving $(basename "$TARGET"). Check: curl -sI https://loupe.qimati-eng.site/login"
