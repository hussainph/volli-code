# libvips source, replacement, and macOS re-signing

This is an auxiliary release-compliance record for the macOS arm64 desktop
bundle. It describes the engineering path for building and installing a
modified libvips, and the signing consequences of modifying a signed Electron
application. It is not a legal opinion and does not decide which license
obligations apply to any particular distribution.

The shipped package manifest declares `@img/sharp-libvips-darwin-arm64@1.3.3`
under `LGPL-3.0-or-later`. The release record must keep that declaration, the
upstream notices, and the exact source/build inputs together with the release.
The current pins are:

| Component | Current pin | Role |
| --- | --- | --- |
| `sharp` | `0.35.4` | JavaScript API and native-addon loader |
| `@img/sharp-darwin-arm64` | `0.35.4` | arm64 Node native addon |
| `@img/sharp-libvips-darwin-arm64` | `1.3.3` | prebuilt libvips package |
| libvips | `8.18.6` | `lib/libvips-cpp.8.18.6.dylib` |

If any of these pins change, re-check this record, the pinned notice under
`apps/desktop/notices/`, and the generated desktop notice before releasing.

## Why `asarUnpack` is necessary but insufficient

`apps/desktop/electron-builder.yml` unpacks both `sharp` and the whole `@img`
tree:

```yaml
asarUnpack:
  - "**/node_modules/sharp/**"
  - "**/node_modules/@img/**"
```

This is necessary because the `.node` addon and the dylib are native Mach-O
files. The dynamic loader needs ordinary filesystem paths, and the addon uses
its `@rpath` entries to find libvips. In a packaged arm64 app the relevant
files are:

```text
Volli Code.app/Contents/Resources/app.asar.unpacked/node_modules/@img/
  sharp-darwin-arm64/lib/sharp-darwin-arm64-0.35.4.node
  sharp-libvips-darwin-arm64/lib/libvips-cpp.8.18.6.dylib
```

Unpacking does **not** make the library replaceable in the compliance or
signing sense. It only moves bytes out of `app.asar`; it does not build a
replacement, preserve the required Mach-O install name, sign the replacement,
or bypass macOS library validation. The addon currently requests
`@rpath/libvips-cpp.8.18.6.dylib`, and the replacement must answer to that name
from the same `@img/sharp-libvips-darwin-arm64/lib` directory.

The published app keeps `hardenedRuntime: true` and uses
`apps/desktop/build/entitlements.mac.plist`. That plist deliberately does not
grant `com.apple.security.cs.disable-library-validation`. A replacement built
and signed by somebody else therefore cannot be made to load merely by copying
it into `app.asar.unpacked`: with library validation enabled, the replacement
must carry the same Team ID as the process that loads it.

`codesign --deep` alone is not a complete replacement procedure. It does not
re-sign the Mach-O files below `Contents/Resources/app.asar.unpacked`, so an
outer re-sign can leave the replacement dylib with its old or incompatible
signature. Sign nested code first and enclosing bundles last.

## Build a compatible replacement

The reproducible baseline is the upstream `sharp-libvips` packaging checkout,
not a Homebrew dylib copied into the app. The `@img` package's `versions.json`
and the upstream packaging scripts describe the dependency versions, patches,
link flags, and macOS `@rpath` rewriting used to produce the shipped file.
Start from the tag matching the package pin:

```sh
git clone --branch v1.3.3 --depth 1 \
  https://github.com/lovell/sharp-libvips.git
cd sharp-libvips
./build.sh darwin-arm64v8
```

To make a modified build, apply the intended change to the libvips source in
that packaging flow, keeping the `v1.3.3` build scripts, the
`darwin-arm64v8` toolchain files, the dependency versions, and the upstream
patches as the baseline. The libvips extraction/configuration step is in
`build/posix.sh`; a local patch belongs after the vips source is extracted and
before its Meson configure/build step. Record that patch and any deliberate
configuration change with the release source.

The build output is a packaging tarball. Extract the library from its `lib/`
directory, then verify its architecture, install name, and dependencies before
installing it:

```sh
BUILD_TARBALL="$PWD/sharp-libvips-darwin-arm64v8.tar.gz"
BUILD_DIR="$(mktemp -d)"
tar -xzf "$BUILD_TARBALL" -C "$BUILD_DIR"
BUILT_LIB="$BUILD_DIR/lib/libvips-cpp.8.18.6.dylib"

file "$BUILT_LIB"
otool -D "$BUILT_LIB"
otool -L "$BUILT_LIB"
```

`file` must report an arm64 Mach-O dynamic library. `otool -D` must report
`@rpath/libvips-cpp.8.18.6.dylib`, and `otool -L` must not contain a build
machine path such as `/opt/homebrew/...`. The upstream packaging flow rewrites
macOS dependency install names to `@rpath` and packages the needed non-system
dependencies; a generic system libvips may not have either property. A build
with a different libvips ABI or a different filename is not a drop-in
replacement: rebuild the matching sharp addon as well, or retain the versions
requested by the shipped addon.

## Replace the file in a copy of the app

Work on a copy of the application and quit Volli Code and its helper processes
before changing a file that may already be mapped. Do not replace the copy in
a published artifact in place.

```sh
APP="$HOME/Applications/Volli Code-modified.app"
UNPACKED="$APP/Contents/Resources/app.asar.unpacked/node_modules/@img"
INSTALLED="$UNPACKED/sharp-libvips-darwin-arm64/lib/libvips-cpp.8.18.6.dylib"
ADDON="$UNPACKED/sharp-darwin-arm64/lib/sharp-darwin-arm64-0.35.4.node"

file "$ADDON"
otool -L "$ADDON" | grep 'libvips-cpp'
cp "$BUILT_LIB" "$INSTALLED"
install_name_tool -id '@rpath/libvips-cpp.8.18.6.dylib' "$INSTALLED"

otool -D "$INSTALLED"
otool -L "$ADDON" | grep 'libvips-cpp'
```

The `@rpath` name printed for the addon and the install name printed for the
replacement must match. If they do not, stop and rebuild against the matching
sharp/libvips pair instead of guessing at a filename. Replacing the file
invalidates the existing code signature, even though the file is outside the
asar archive.

## Re-sign the modified copy

The supported path that keeps library validation enabled is to sign the
replacement and the application with the recipient's own Developer ID identity
(the same Team ID for every nested Mach-O object):

```sh
IDENTITY='Developer ID Application: Your Name (TEAMID)'
codesign --force --options runtime --timestamp --sign "$IDENTITY" "$INSTALLED"
```

That command signs the replacement only. A usable application copy also needs
the rest of the native code under `Contents/Resources/app.asar.unpacked`, the
Electron frameworks/helpers, and the enclosing app bundle re-signed with the
same identity, from the inside out. Prefer rerunning the normal electron-builder
signing pipeline over hand-signing a distributed app. If signing by hand, do
not use `codesign --deep` as the only step: sign every changed/nested Mach-O,
then its framework/helper bundles, and finally `Volli Code.app`. Preserve the
app's hardened-runtime settings; do not add
`com.apple.security.cs.disable-library-validation` to the released entitlements.

Check the result before launch:

```sh
codesign --verify --deep --strict --verbose=2 "$APP"
codesign -dvvv --verbose=4 "$APP" 2>&1 | grep TeamIdentifier
codesign -dvvv --verbose=4 "$INSTALLED" 2>&1 | grep TeamIdentifier
spctl --assess --type execute --verbose=4 "$APP"
```

The two `TeamIdentifier` values must agree for the library-validation path.
Ad-hoc signing (`codesign --sign -`) does not provide a Team ID and is not a
replacement for this path under the published hardened-runtime configuration.
Do not treat a copy that only starts after weakening its entitlements as proof
that the release configuration can be weakened.

Changing a signed app also invalidates the publisher's signature and
notarization. To distribute the modified copy, sign it with the recipient's
identity, submit the resulting app/archive to Apple's notary service, staple
its ticket where appropriate, and validate the final app and archive. The
published `.dmg`, `.zip`, checksums, and auto-update metadata still describe
the original app; they cannot be reused after the replacement. An updater may
also replace a modified copy with the next official update.

## Corresponding-source and release record

For each release, keep the following material together in the release
compliance record and make it available through the documented source channel.
This is a reproducibility checklist, not a conclusion about the legal status
of any individual component:

- the exact `sharp`, `@img/sharp-darwin-arm64`, and
  `@img/sharp-libvips-darwin-arm64` package versions, package tarball digests,
  `versions.json`, and the shipped dylib's digest;
- the exact `sharp-libvips` source tag/commit, including `build.sh`,
  `build/posix.sh`, `versions.properties`, the arm64 toolchain files, all
  dependency source archives, and every patch/configuration change used to
  produce the dylib (including any local libvips modification);
- the source and build metadata for libvips and the other libraries linked into
  the packaged dylib, plus the applicable license and NOTICE texts. The
  generated `Contents/Resources/THIRD-PARTY-NOTICES.txt` is the shipped index;
- the release's `pnpm-lock.yaml`, `apps/desktop/package.json`,
  `electron-builder.yml`, and the entitlements used for signing, so the
  package selection, unpacked path, and signing posture can be reconstructed;
- the exact `Volli Code.app`, `.dmg`, and `.zip` artifacts, their checksums, and
  the signing/notarization results for the unmodified release. A modified
  recipient copy needs its own signatures and notarization evidence.

A URL to a moving branch is not an exact source record. Pin source archives or
commits and retain their digests; if a source server becomes unavailable, the
release channel must still be able to provide the recorded source materials.
The applicable license text and legal review determine the final scope of what
must be offered or published; this document records the inputs needed to make
that determination and to reproduce the shipped libvips binary.

## Existing check

The repository already has one focused check for this release surface:

```sh
pnpm run check:notices
```

It checks the generated desktop notice, the pinned platform-native package
version/text, and that `electron-builder.yml` still ships the notice resource.
It does not build libvips, replace a packaged app, or perform macOS signing or
notarization. No new documentation checker is added here; those macOS steps
remain release/operator verification.
