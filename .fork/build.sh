#!/usr/bin/env bash
# Builds the Linux x64 t3 archive for the checked-out commit, the same way release CI does.
# Usage: .fork/build.sh [repo-dir]
# Output: ~/t3-builds/<sha>.tar.gz and <sha>.version. Last stdout line: "<version> <archive>".
# A build that already exists for this commit is reused.
set -euo pipefail

repo=$(cd "${1:-.}" && pwd)
cd "$repo"
# shellcheck disable=SC1091
. "$HOME/.config/vite-plus/env"
export PATH="$HOME/.local/bin:$PATH"

builds="${T3_FORK_BUILDS:-$HOME/t3-builds}"
runtime="${T3CODE_HOME:-$HOME/.t3}/runtime"
sha=$(git rev-parse HEAD)

git diff --quiet HEAD || { echo "build.sh: $repo has uncommitted changes" >&2; exit 1; }

# The version is the latest upstream stable tag in this commit's history, plus our commit.
if git remote get-url upstream >/dev/null 2>&1; then
  git ls-remote --tags --refs upstream 'v*' | awk '{print $2}' |
    grep -E '^refs/tags/v[0-9]+\.[0-9]+\.[0-9]+$' | sed 's|.*|&:&|' |
    xargs -r git fetch -q --no-tags upstream
fi
tag=$(git describe --tags --abbrev=0 --match 'v[0-9]*' --exclude '*-*' HEAD)
version="${tag#v}+fork.${sha:0:7}"
archive="$builds/$sha.tar.gz"

if [ -s "$archive" ] && [ "$(cat "$builds/$sha.version" 2>/dev/null)" = "$version" ]; then
  echo "$version $archive"
  exit 0
fi

# Reuse the installed resource monitor so the build needs no Rust toolchain.
active=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).activeVersion)' \
  "$runtime/service-state.json")
monitor="$runtime/versions/$active/resource-monitor"
[ -x "$monitor/linux-x64/t3-resource-monitor" ] || { echo "build.sh: no resource monitor in $monitor" >&2; exit 1; }

out=$(mktemp -d "${TMPDIR:-/tmp}/t3-build.XXXXXX")
trap 'rm -rf "$out"' EXIT

vp i
APP_VERSION="$version" vp run --filter t3 build
APP_VERSION="$version" node apps/server/scripts/cli.ts build-exe --verbose
node scripts/build-cli-archive.ts --platform linux --arch x64 --version "$version" \
  --resource-monitor-dir "$monitor" --output-dir "$out"
node scripts/smoke-cli-archive.ts --archive "$out/t3-$version-linux-x64.tar.gz" --expect-version "$version"

mkdir -p "$builds"
mv "$out/t3-$version-linux-x64.tar.gz" "$archive.tmp"
mv "$archive.tmp" "$archive"
echo "$version" > "$builds/$sha.version"
echo "$version $archive"
