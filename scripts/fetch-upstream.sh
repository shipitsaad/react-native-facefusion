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

# Verify against NOTICE, and FAIL on a mismatch. This used to print the hashes and tell
# the reader to compare them by eye, while the comment below claimed a check had happened
# -- a promise the script did not keep, found by installing the npm tarball into a clean
# app and reading what actually ran. A check nobody performs is not a check.
NOTICE="$ROOT/third_party/facefusion-mobile/NOTICE"
echo
if ! command -v shasum >/dev/null; then
  echo "WARNING: shasum not found -- cannot verify the fetch against NOTICE." >&2
elif [ ! -f "$NOTICE" ]; then
  echo "WARNING: $NOTICE is missing -- cannot verify the fetch." >&2
else
  echo "Verifying against third_party/facefusion-mobile/NOTICE ..."
  fail=0
  for f in "${FILES[@]}"; do
    got="$(shasum -a 256 "$DEST/$f" | cut -d' ' -f1)"
    # NOTICE records each hash in a markdown table row naming the file: `cpp/ffjni.cpp`.
    want="$(grep -F "cpp/$f\`" "$NOTICE" | grep -oE '[0-9a-f]{64}' | head -1)"
    if [ -z "$want" ]; then
      echo "  ?? $f -- no hash recorded in NOTICE" >&2; fail=1
    elif [ "$got" != "$want" ]; then
      echo "  !! $f -- MISMATCH" >&2
      echo "       expected $want" >&2
      echo "       got      $got" >&2
      fail=1
    else
      echo "  ok $f"
    fi
  done
  if [ "$fail" -ne 0 ]; then
    echo >&2
    echo "Upstream bytes do not match NOTICE. Refusing to patch or continue: a patch" >&2
    echo "applied to unexpected sources would mask exactly this. If upstream moved on" >&2
    echo "purpose, re-pin COMMIT and update NOTICE deliberately, with a diff review." >&2
    exit 1
  fi
fi

# Patches, applied AFTER the hash check above -- that check verifies we got upstream's
# actual, unmodified bytes; patching is a separate, deliberate step on top of a known-
# good base, not something that should ever be allowed to mask a bad fetch.
#
# One patch exists today: patches/ffjni-analyse-faces.patch adds a single new JNI
# export to ffjni.cpp (Java_com_facefusion_mobile_NativePipe_analyseFaces) so a
# multi-face source photo can be shown to the user before a swap picks one. It changes
# no existing function. See docs/02-upstream.md "Patches" and NOTICE for why this is
# tracked here instead of edited in place: this script overwrites cpp/ from upstream
# every time it runs, so an in-place edit would not survive a re-fetch.
PATCH_DIR="$ROOT/patches"
if [ -d "$PATCH_DIR" ] && [ -n "$(ls -A "$PATCH_DIR"/*.patch 2>/dev/null)" ]; then
  echo
  echo "Applying patches..."
  for p in "$PATCH_DIR"/*.patch; do
    echo "  $(basename "$p")"
    patch "$DEST/ffjni.cpp" < "$p"
  done
fi
