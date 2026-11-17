#!/usr/bin/env bash
# Nightly deploy of this fork. Installed as ~/.local/bin/t3-nightly-update, run by
# t3-update.timer at 04:00 Europe/Prague. Installs origin/deploy when it moved, rolls back if
# the server is unhealthy, and opens a GitHub issue only when a person has to look.
#
# The deploy checkout's HEAD is always the commit that is installed.
# T3_FORK_DRY_RUN=1 does everything up to the install, unpacks into a temporary directory, and
# leaves the server and the checkout as they were.
set -uo pipefail

REPO=${T3_FORK_DEPLOY_DIR:-$HOME/code/t3code-deploy}
FORK=${T3_FORK_REPO:-michal-skoula/t3code}
HEALTH=${T3_FORK_HEALTH_URL:-http://100.127.105.79:3773/}
RUNTIME=$HOME/.t3/runtime
BUILDS=$HOME/t3-builds
T3=$HOME/.local/bin/t3
export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"

log() { echo "[$(date -Is)] $*"; }
alert() {
  log "ALERT: $1"
  gh issue create -R "$FORK" --title "deploy: $1" --body "$2"$'\n\nHost: '"$(hostname)"$'\nLog: `journalctl --user -u t3-update.service`' >/dev/null ||
    log "could not open the issue"
}
healthy() {
  for _ in $(seq 12); do
    curl -sf -o /dev/null -m 5 "$HEALTH" && return 0
    sleep 5
  done
  return 1
}
active_version() {
  node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).activeVersion)' \
    "$RUNTIME/service-state.json"
}

if [ "${T3_FORK_DRY_RUN:-}" != 1 ] && pgrep -u "$(id -u)" -x claude >/dev/null; then
  log "skip: a claude process is running"
  exit 0
fi

cd "$REPO" || { alert "deploy checkout missing" "Expected a clone of $FORK at \`$REPO\`."; exit 1; }
# A failed fetch is usually the network; tomorrow's run tries again.
git fetch -q origin deploy || { log "fetch failed, trying again tomorrow"; exit 0; }
installed=$(git rev-parse HEAD)
target=$(git rev-parse origin/deploy)
if [ "$installed" = "$target" ]; then
  log "nothing new (installed $installed)"
  exit 0
fi
if ! git merge -q --ff-only origin/deploy; then
  alert "deploy is not a fast-forward" \
    "\`origin/deploy\` ($target) does not descend from the installed commit $installed, so nothing was installed. Someone rewrote history; check before deploying by hand."
  exit 1
fi
back() { git reset -q --hard "$installed"; }

mkdir -p "$BUILDS"
archive=$BUILDS/$target.tar.gz
# The merge agent normally built this commit already; build only on a miss.
if [ -s "$archive" ] && [ -s "$BUILDS/$target.version" ]; then
  version=$(cat "$BUILDS/$target.version")
  log "using the agent's build of $target"
else
  log "building $target"
  if [ ! -x "$REPO/.fork/build.sh" ] || ! "$REPO/.fork/build.sh" "$REPO" >"$BUILDS/$target.log" 2>&1; then
    back
    alert "build failed for ${target:0:7}" "\`.fork/build.sh\` failed or is missing, so nothing changed. Tail of the log:"$'\n\n```\n'"$(tail -n 40 "$BUILDS/$target.log" 2>/dev/null)"$'\n```'
    exit 1
  fi
  read -r version archive < <(tail -n 1 "$BUILDS/$target.log")
fi
previous=$(active_version)

dir=$RUNTIME/versions/$version
if [ "${T3_FORK_DRY_RUN:-}" = 1 ]; then
  dir=$(mktemp -d)/$version
  back
fi
if [ "$(cat "$dir/.install-complete" 2>/dev/null)" != "$version" ]; then
  rm -rf "$dir.tmp" && mkdir -p "$dir.tmp" &&
    tar -xzf "$archive" -C "$dir.tmp" --strip-components=1 &&
    echo "$version" >"$dir.tmp/.install-complete" &&
    rm -rf "$dir" && mv "$dir.tmp" "$dir" ||
    { back; alert "could not unpack $version" "Unpacking \`$archive\` into \`$dir\` failed; nothing changed."; exit 1; }
fi

if [ "${T3_FORK_DRY_RUN:-}" = 1 ]; then
  log "dry run: would install $version (was $previous) from $dir; $("$dir/t3" --version)"
  rm -rf "$(dirname "$dir")"
  exit 0
fi

log "installing $version (was $previous)"
if ! "$T3" update "$version" --yes </dev/null; then
  back
  alert "t3 update to $version failed" "\`t3 update $version\` failed. Check that the server still runs $previous."
  exit 1
fi
if healthy; then
  log "ok: $previous -> $version"
  ls -1t "$BUILDS"/*.tar.gz 2>/dev/null | tail -n +4 | while read -r old; do rm -f "$old" "${old%.tar.gz}.version" "${old%.tar.gz}.log"; done
  exit 0
fi

log "unhealthy after $version, rolling back to $previous"
# The new build may be the broken part, so roll back with the previous version's own binary.
if "$RUNTIME/versions/$previous/t3" update "$previous" --allow-downgrade --yes </dev/null && healthy; then
  back
  alert "$version was unhealthy, rolled back" \
    "The server did not answer at $HEALTH after installing $version (${target:0:7}), so it is back on $previous. \`deploy\` still points at the bad commit; the next run tries again only after \`deploy\` moves."
  exit 1
fi
alert "rollback to $previous failed" "Installing $version left the server unhealthy, and rolling back to $previous failed too. The server may be down."
exit 1
