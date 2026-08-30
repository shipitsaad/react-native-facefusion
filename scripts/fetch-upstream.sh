#!/usr/bin/env bash
#
# Places the upstream C++ engine into third_party/facefusion-mobile/cpp/.
#
# The files are NOT in this repository: upstream ships no LICENSE, so redistributing
# them is not permitted (docs/05-licensing.md §1). Cloning their public repo yourself
# is, which is all this script does.
#
# Pinned to a commit on purpose. Upstream moves daily, and a re-sync must be a
# deliberate act with a diff review, not something a build silently picks up.
set -euo pipefail

REPO="https://github.com/AbrahamPaulJ/facefusion-mobile.git"
COMMIT="bf633acee030772deb2f2068866c0c0a17de24ba"
SRC_SUBDIR="work/android/app/src/main/cpp"
FILES=(ffjni.cpp ffpipe.cpp ffpipe.h ffcv.cpp ffcv.h ffqnn.cpp ffqnn.h)

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$ROOT/third_party/facefusion-mobile/cpp"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "Cloning $REPO @ ${COMMIT:0:7} ..."
git init -q "$TMP"
git -C "$TMP" remote add origin "$REPO"
git -C "$TMP" fetch -q --depth 1 origin "$COMMIT"
git -C "$TMP" checkout -q FETCH_HEAD

mkdir -p "$DEST"
for f in "${FILES[@]}"; do
  cp "$TMP/$SRC_SUBDIR/$f" "$DEST/$f"
  echo "  $f"
done

echo
echo "Done. Verify against third_party/facefusion-mobile/NOTICE:"
if command -v shasum >/dev/null; then
  (cd "$DEST" && shasum -a 256 "${FILES[@]}")
fi
