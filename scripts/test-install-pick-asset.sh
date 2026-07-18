#!/usr/bin/env bash
# Regression test for install.sh pick_asset_url().
#
# The original implementation piped into `while read`, which created a
# subshell — `return 0` inside the loop never exited the function, so
# native installers were silently never selected. This test feeds a fake
# asset list through the same matching logic and asserts exit code + output.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Mirrors install.sh's pick_asset_url matching core (no live GitHub call).
pick_asset_url() {
  local assets="$1"
  local platform="$2"
  local arch_norm="$3"
  local pattern=""

  case "$platform" in
    macos)
      pattern="${arch_norm}.*\\.dmg$|\\.dmg$"
      ;;
    linux)
      pattern="${arch_norm}.*\\.AppImage$|\\.AppImage$|${arch_norm}.*\\.deb$|\\.deb$|${arch_norm}.*\\.rpm$|\\.rpm$"
      ;;
    *)
      return 1
      ;;
  esac

  # Process substitution (not a pipe) so return exits the function, not a subshell.
  while IFS=$'\t' read -r name url size; do
    [ -n "$name" ] || continue
    if echo "$name" | grep -qE "$pattern"; then
      echo "$name|$url|$size"
      return 0
    fi
  done < <(printf '%s\n' "$assets")
  return 1
}

FAKE_ASSETS=$(printf '%s\n' \
  $'GTSS-Growth-Engine-Setup-1.0.0-x64.exe\thttps://example.com/setup.exe\t50000000' \
  $'GTSS-Growth-Engine-1.0.0-x64.AppImage\thttps://example.com/foo.AppImage\t12345' \
  $'GTSS-Growth-Engine-1.0.0-x64.dmg\thttps://example.com/foo.dmg\t67890' \
  $'gtss-growth-desktop_1.0.0_amd64.deb\thttps://example.com/foo.deb\t11111')

pass=0
fail=0

assert_pick() {
  local platform="$1"
  local arch="$2"
  local expect_name="$3"
  local result rc
  set +e
  result=$(pick_asset_url "$FAKE_ASSETS" "$platform" "$arch")
  rc=$?
  set -e
  if [ "$rc" -ne 0 ]; then
    echo "FAIL: pick_asset_url($platform/$arch) returned $rc (expected 0)"
    fail=$((fail + 1))
    return
  fi
  local got_name
  got_name="${result%%|*}"
  if [ "$got_name" != "$expect_name" ]; then
    echo "FAIL: pick_asset_url($platform/$arch) got '$got_name', expected '$expect_name'"
    fail=$((fail + 1))
    return
  fi
  echo "OK:   pick_asset_url($platform/$arch) → $got_name"
  pass=$((pass + 1))
}

assert_no_pick() {
  local platform="$1"
  local arch="$2"
  local rc
  set +e
  pick_asset_url "$FAKE_ASSETS" "$platform" "$arch" >/dev/null
  rc=$?
  set -e
  if [ "$rc" -eq 0 ]; then
    echo "FAIL: pick_asset_url($platform/$arch) unexpectedly succeeded"
    fail=$((fail + 1))
    return
  fi
  echo "OK:   pick_asset_url($platform/$arch) correctly returns non-zero"
  pass=$((pass + 1))
}

assert_pick linux x64 "GTSS-Growth-Engine-1.0.0-x64.AppImage"
assert_pick macos x64 "GTSS-Growth-Engine-1.0.0-x64.dmg"
assert_no_pick windows x64

# Source-check that install.sh itself no longer uses the subshell pipe pattern.
if grep -qE 'echo "\$assets" \| while' "$ROOT/install.sh"; then
  echo "FAIL: install.sh still pipes into while (subshell bug)"
  fail=$((fail + 1))
else
  echo "OK:   install.sh does not pipe assets into while"
  pass=$((pass + 1))
fi

# Source-check that install.sh uses process substitution.
if grep -qE 'done < <\(' "$ROOT/install.sh"; then
  echo "OK:   install.sh uses process substitution for the asset loop"
  pass=$((pass + 1))
else
  echo "FAIL: install.sh does not use process substitution for the asset loop"
  fail=$((fail + 1))
fi

echo ""
echo "Results: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
