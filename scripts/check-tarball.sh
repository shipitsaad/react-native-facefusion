#!/usr/bin/env bash
#
# Refuses to publish a tarball containing Qualcomm's QAIRT runtime, its proprietary
# headers, upstream's unlicensed C++, or a model binary.
#
# This runs as `prepublishOnly`, ON THE PUBLISHING MACHINE, and that placement is the
# whole point. CI has a step that greps the packed tarball too -- but a CI checkout
# cannot contain any of these files in the first place (they are gitignored and fetched
# separately), so the grep there passes trivially and proves nothing. The only machine
# where the bytes actually exist is a developer's, which is the only machine that ever
# runs `npm publish`. A guard that cannot fire where the risk lives is decoration.
#
# See docs/05-licensing.md: redistribution of the QAIRT runtime is permitted only "as
# incorporated in Your software application", never "on a standalone basis" -- an APK
# may ship it, an npm package may not.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

echo "prepublish: auditing the tarball..."

# Build the real tarball and read it with tar, rather than parsing `npm pack --json`:
# `npm pack` re-runs `prepare` (bob build), which prints lines like
# "[typescript] Cleaning up previous build" to STDOUT, ahead of the JSON. Any attempt to
# slice the JSON out of that stream picks up bob's bracket instead of the array's.
# The bytes on disk are the thing being audited anyway.
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
npm pack --pack-destination "$tmp" >/dev/null 2>&1
tgz="$(ls "$tmp"/*.tgz 2>/dev/null | head -1)"
if [ -z "$tgz" ]; then
  echo "prepublish: npm pack produced no tarball" >&2
  exit 1
fi
files="$(tar -tzf "$tgz" | sed 's|^package/||' | grep -v '/$')"

banned="$(printf '%s\n' "$files" | grep -Ei 'libQnn|\.so$|\.bin$|include/QNN/|hexagon|third_party/facefusion-mobile/cpp/' || true)"
if [ -n "$banned" ]; then
  echo >&2
  echo "PUBLISH BLOCKED -- the tarball contains files that must never be redistributed:" >&2
  printf '  %s\n' $banned >&2
  echo >&2
  echo "See docs/05-licensing.md. Check the \"files\" array in package.json:" >&2
  echo "npm's files list OVERRIDES .gitignore, so being gitignored is not protection." >&2
  exit 1
fi

# Clean is not enough; it also has to be complete. These are what the README's install
# steps and the build actually need -- all four were missing once, which made the
# published package impossible to install.
required=(
  package.json README.md LICENSE
  scripts/fetch-upstream.sh
  patches/ffjni-analyse-faces.patch
  third_party/facefusion-mobile/NOTICE
  lib/module/index.js
  lib/typescript/src/index.d.ts
  android/build.gradle
  android/src/main/AndroidManifest.xml
  android/src/main/cpp/CMakeLists.txt
)
missing=0
for f in "${required[@]}"; do
  printf '%s\n' "$files" | grep -qxF "$f" || { echo "PUBLISH BLOCKED -- missing: $f" >&2; missing=1; }
done
[ "$missing" -eq 0 ] || exit 1

echo "prepublish: OK -- $(printf '%s\n' "$files" | wc -l | tr -d ' ') files, nothing proprietary, nothing missing."
