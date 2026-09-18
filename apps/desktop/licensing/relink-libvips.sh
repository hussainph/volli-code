#!/usr/bin/env bash
#
# relink-libvips.sh — install your own build of libvips into Volli Code.
#
# This is the Installation Information LGPLv3 section 4(e) asks for, in the
# form of something you can run. It replaces the libvips shared library inside
# a copy of Volli Code.app with one you supply, and then re-signs that copy so
# macOS will load it.
#
#     ./relink-libvips.sh --app "/Applications/Volli Code.app" \
#                         --dylib ~/build/libvips-cpp.8.18.6.dylib
#
#     ./relink-libvips.sh --app "/Applications/Volli Code.app" --verify
#
# WHY RE-SIGNING IS PART OF THE JOB. Volli Code ships signed with a Developer
# ID and the hardened runtime, and it deliberately does NOT carry the
# `com.apple.security.cs.disable-library-validation` entitlement. Library
# validation therefore refuses to load any library not signed by the same Apple
# Team ID as the running process — which is precisely a libvips you built. That
# hardening is a security property of the build we publish and we are not
# giving it up; instead this script hands you the means to relax it on YOUR
# copy, on your machine, which is what the license entitles you to.
#
# Two ways to get there, and this script implements the first:
#
#   1. Re-sign your copy ad hoc, keeping the hardened runtime but adding
#      `disable-library-validation` (--mode disable-lv, the default). Needs no
#      Apple Developer account. Verified working: see RELINK-LIBVIPS.md.
#
#   2. Re-sign your copy with your OWN Developer ID (--mode team --identity
#      "Developer ID Application: You (TEAMID)"). Library validation then
#      passes normally, because your libvips and your app share a Team ID.
#      Needs a paid Apple Developer account, which is why it is not the
#      default.
#
# WHAT IT COSTS YOU. Re-signing invalidates Apple's notarization of the copy
# you modify, and the bundled auto-updater will replace your work the next time
# it applies an update. Both are consequences of modifying a signed
# application, not restrictions we impose. Work on a COPY, not on the build in
# /Applications: this script refuses to touch one it was not pointed at
# explicitly, but it cannot un-modify an app for you.
#
# Requires: macOS, and the command line tools that provide `codesign`
# (`xcode-select --install`).

set -euo pipefail

APP=""
DYLIB=""
MODE="disable-lv"
IDENTITY="-"
VERIFY_ONLY=false

die() {
  echo "relink-libvips: $1" >&2
  exit 1
}

usage() {
  sed -n '2,45p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --app) APP="${2:-}"; shift 2 ;;
    --dylib) DYLIB="${2:-}"; shift 2 ;;
    --mode) MODE="${2:-}"; shift 2 ;;
    --identity) IDENTITY="${2:-}"; shift 2 ;;
    --verify) VERIFY_ONLY=true; shift ;;
    -h|--help) usage 0 ;;
    *) die "unknown argument: $1 (try --help)" ;;
  esac
done

[ "$(uname -s)" = "Darwin" ] || die "this script only applies to the macOS build."
command -v codesign >/dev/null 2>&1 || die "codesign not found. Run: xcode-select --install"
[ -n "$APP" ] || die "--app is required. Point it at a COPY of Volli Code.app."
[ -d "$APP" ] || die "no such application bundle: $APP"

case "$MODE" in
  disable-lv|team) ;;
  *) die "--mode must be 'disable-lv' or 'team'." ;;
esac
if [ "$MODE" = "team" ] && [ "$IDENTITY" = "-" ]; then
  die "--mode team needs --identity \"Developer ID Application: Your Name (TEAMID)\"."
fi

# The library is shipped unpacked from the asar precisely so it can be replaced.
# Its filename carries the libvips version, so it is discovered rather than
# hardcoded: this script keeps working across libvips bumps.
UNPACKED="$APP/Contents/Resources/app.asar.unpacked/node_modules/@img"
INSTALLED="$(find "$UNPACKED" -name 'libvips-cpp.*.dylib' -maxdepth 3 2>/dev/null | head -1 || true)"
[ -n "$INSTALLED" ] || die "no libvips dylib found under $UNPACKED — is this a Volli Code bundle?"

ADDON="$(find "$UNPACKED" -name 'sharp-darwin-*.node' -maxdepth 3 2>/dev/null | head -1 || true)"

echo "app:       $APP"
echo "libvips:   $INSTALLED"
[ -n "$ADDON" ] && echo "addon:     $ADDON"

if [ "$VERIFY_ONLY" = true ]; then
  echo
  echo "--- current signatures ---"
  codesign -dv "$APP" 2>&1 | grep -E 'TeamIdentifier|CodeDirectory' || true
  echo "--- libvips ---"
  codesign -dv "$INSTALLED" 2>&1 | grep -E 'TeamIdentifier|CodeDirectory' || true
  echo
  echo "A library whose TeamIdentifier differs from the app's cannot load unless the app"
  echo "carries the disable-library-validation entitlement. Run without --verify to fix that."
  exit 0
fi

[ -n "$DYLIB" ] || die "--dylib is required (the libvips you built). Use --verify to inspect only."
[ -f "$DYLIB" ] || die "no such file: $DYLIB"

# A wrong-architecture library fails later with an unhelpful loader error.
if ! file "$DYLIB" | grep -q 'Mach-O.*dynamically linked shared library'; then
  die "$DYLIB is not a Mach-O dynamic library."
fi

echo
echo "==> installing your libvips over $(basename "$INSTALLED")"
cp "$DYLIB" "$INSTALLED"

# The install name must stay @rpath-relative or the addon will not find it: the
# addon's load command names "@rpath/<basename>", and its LC_RPATH entries
# point at this directory.
install_name_tool -id "@rpath/$(basename "$INSTALLED")" "$INSTALLED" 2>/dev/null || true

ENTITLEMENTS="$(mktemp -t volli-relink-entitlements).plist"
trap 'rm -f "$ENTITLEMENTS"' EXIT

if [ "$MODE" = "disable-lv" ]; then
  # The app's own entitlements, plus the one that lets a differently-signed
  # library load. allow-jit and allow-unsigned-executable-memory must be
  # carried over: Electron needs both under the hardened runtime, and a re-sign
  # that drops them produces an app that crashes at launch.
  cat >"$ENTITLEMENTS" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>com.apple.security.cs.allow-jit</key>
	<true/>
	<key>com.apple.security.cs.allow-unsigned-executable-memory</key>
	<true/>
	<key>com.apple.security.cs.disable-library-validation</key>
	<true/>
</dict>
</plist>
PLIST
else
  codesign -d --entitlements :- "$APP" >"$ENTITLEMENTS" 2>/dev/null ||
    die "could not read the app's entitlements to carry them over."
fi

# Sign from the inside out. `codesign --deep` is NOT used and does not work
# here: it leaves the Mach-O files under app.asar.unpacked alone, so the very
# library you just replaced keeps its old signature while the outer app gets a
# new one, and the two then disagree.
echo "==> re-signing, innermost code first"

# A failure here is not cosmetic: an unsigned or stale-signed piece of nested
# code makes the whole bundle unloadable, with a loader error that names the
# wrong culprit. So signing failures stop the script rather than scrolling past.
sign() {
  if ! codesign --force --sign "$IDENTITY" --options runtime "$@" 2>/tmp/volli-relink-codesign.err; then
    echo "relink-libvips: failed to sign ${*: -1}" >&2
    sed 's/^/  /' /tmp/volli-relink-codesign.err >&2
    exit 1
  fi
}

# Only Mach-O files are signable. The bundle also carries prebuilt addons for
# OTHER platforms (node-pty ships Windows .node files), and codesign rejects
# those — correctly, and not as a problem with this copy.
while IFS= read -r -d '' candidate; do
  case "$(file -b "$candidate")" in
    Mach-O*) sign "$candidate" ;;
    *) ;;
  esac
done < <(find "$APP/Contents" -type f \( -name '*.dylib' -o -name '*.node' -o -name '*.so' \) -print0)

for helper in \
  "$APP/Contents/Resources/app.asar.unpacked/node_modules/@vscode/ripgrep-darwin-arm64/bin/rg" \
  "$APP/Contents/Resources/app.asar.unpacked/node_modules/node-pty/build/Release/spawn-helper" \
  "$APP/Contents/Frameworks/Electron Framework.framework/Versions/A/Helpers/chrome_crashpad_handler" \
  "$APP/Contents/Frameworks/Squirrel.framework/Versions/A/Resources/ShipIt"; do
  [ -f "$helper" ] && sign "$helper"
done

for framework in "$APP/Contents/Frameworks/"*.framework; do
  [ -d "$framework/Versions/A" ] && sign "$framework/Versions/A"
done

# The helper apps are separate processes and need the entitlements too — the
# renderer is where most of the app actually runs.
for helper_app in "$APP/Contents/Frameworks/"*.app; do
  [ -d "$helper_app" ] && sign --entitlements "$ENTITLEMENTS" "$helper_app"
done

sign --entitlements "$ENTITLEMENTS" "$APP"

echo "==> verifying"
codesign --verify --deep "$APP" 2>&1 | tail -3 || true
codesign -dv "$APP" 2>&1 | grep -E 'TeamIdentifier|CodeDirectory' || true

cat <<EOF

Done. Your libvips is installed and the copy is re-signed.

If the app was running, quit it fully before launching the modified copy.
macOS caches a file's code signature while it is mapped, so a bundle re-signed
in place can keep reporting the OLD signature until every process using it has
exited; copying the bundle to a fresh path also clears it.

This copy is no longer notarized by Apple, and the auto-updater will replace it
with an official build when it next applies an update.
EOF
