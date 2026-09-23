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
set -euo pipefail
ROOT=${LOUPE_ROOT:-/home/ubuntu/loupe}
SHA=${1:?usage: rollback.sh <short-sha> [--dry-run]}
TARGET=$(ls -1d "$ROOT"/releases/*-"$SHA" 2>/dev/null | tail -1 || true)
# A failed build leaves a release directory without a finished build; never switch to one.
if [ -z "$TARGET" ] || [ ! -f "$TARGET/.next/BUILD_ID" ]; then
  echo "no built release for $SHA; kept releases:" >&2
  ls -1 "$ROOT/releases" >&2
  exit 1
fi
if [ "$(readlink -f "$ROOT/current")" = "$(readlink -f "$TARGET")" ]; then echo "==> $(basename "$TARGET") is already live"; exit 0; fi
if [ "${2:-}" = "--dry-run" ]; then echo "would serve $(basename "$TARGET")"; exit 0; fi

exec 9>"$ROOT/deploy.lock"; flock 9
ln -sfn "$TARGET" "$ROOT/current.new" && mv -T "$ROOT/current.new" "$ROOT/current"
sudo systemctl restart loupe
echo "==> serving $(basename "$TARGET"). Check: curl -sI https://loupe.qimati-eng.site/login"
