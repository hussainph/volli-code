<!-- This file SHIPS INSIDE the application bundle (Contents/Resources/licensing).
     It is the Installation Information LGPLv3 section 4(e) asks for, written for the
     person who received the binary — not an internal note. Keep it in that voice.

     Every command and every claim about macOS behaviour here was verified against a
     real Developer ID-signed, notarized Volli Code.app. The evidence, and what was
     tried and did not work, is in docs/licensing/dependency-license-review.md.
     apps/desktop/scripts/check-library-validation.mjs re-checks the two claims this
     document rests on, so it fails if macOS ever stops behaving this way. -->

# Running your own build of libvips

Volli Code includes **libvips** as a shared library, under the GNU Lesser General Public
License v3. Section 4(d) of that license entitles you to replace it with your own build and
still run this application. This file explains how, on macOS.

The short version:

```sh
"/Applications/Volli Code.app/Contents/Resources/licensing/relink-libvips.sh" \
  --app "$HOME/Volli Code.app" \
  --dylib "$HOME/build/libvips-cpp.8.18.6.dylib"
```

Everything below is why that script does what it does, and what to do when it does not fit.

## What ships, and where

The library is a single file inside the application bundle, deliberately left outside the
`app.asar` archive so that it is an ordinary file you can replace:

```
Volli Code.app/Contents/Resources/app.asar.unpacked/node_modules/
  @img/sharp-libvips-darwin-arm64/lib/libvips-cpp.<version>.dylib
```

It is loaded at run time by the `sharp` native addon beside it, through the Mach-O load
command `@rpath/libvips-cpp.<version>.dylib`. Dynamic linking, not static: your replacement
is genuinely what gets mapped. `LGPL-LIBVIPS.md`, next to this file, tells you where the
source of that library and everything in it comes from.

Your build has to keep the same file name and the same install name (`@rpath/<file name>`),
because that is the name the addon asks the loader for. The script handles this with
`install_name_tool`; if you do it by hand, do not skip it.

## The obstacle, stated honestly

Volli Code is distributed signed with an Apple Developer ID and the **hardened runtime**, and
it deliberately does not carry the `com.apple.security.cs.disable-library-validation`
entitlement. With that combination, macOS enforces _library validation_: a process will only
load libraries signed by the same Apple Team ID as the process itself.

You cannot sign anything with our Team ID — that is the point of a Team ID. So a libvips you
built is normally refused by the operating system, with this error:

```
Library not loaded: @rpath/libvips-cpp.8.18.6.dylib
  Reason: ... (code signature in ... not valid for use in process:
  mapping process and mapped file (non-platform) have different Team IDs)
```

We are not shipping that entitlement switched off to make this easier. Library validation
protects every user of the published build against a class of code-injection attack, and
turning it off for everyone in order to serve the few people who relink libvips would be a
bad trade. What we can do — and what the license asks of us — is tell you exactly how to
lift it **on your own copy**, which is what the rest of this file does.

> **How strictly this is enforced varies by macOS version.** The refusal above was reproduced
> against a Developer ID-signed, notarized build on macOS 26. Some older versions are less
> strict about certain signature combinations, so depending on your macOS and on how your
> library is signed, your replacement may simply load. **Try it first.** If it works, you are
> done and the re-signing below is work you do not need. If you get the error above, the two
> methods below are how you get past it.

## Method 1 — re-sign your copy ad hoc (no Apple account needed)

This is what `relink-libvips.sh` does by default. It keeps the hardened runtime on and adds
the one entitlement that admits a differently-signed library, then re-signs the bundle with
an ad-hoc signature.

```sh
./relink-libvips.sh --app "$HOME/Volli Code.app" --dylib ~/build/libvips-cpp.8.18.6.dylib
```

Work on a **copy** of the app, not on the one in `/Applications`, unless you mean to modify
the installed one.

Two details the script gets right and a hand-rolled command usually does not:

- **`codesign --deep` does not work here.** It does not re-sign the Mach-O files under
  `Resources/app.asar.unpacked`, which is exactly where libvips lives, so the library keeps
  its old signature while the app around it gets a new one. The bundle must be signed from
  the inside out: nested libraries and executables first, then the frameworks, then the
  helper apps, then the app itself.
- **The entitlements must be carried over.** Electron needs `allow-jit` and
  `allow-unsigned-executable-memory` under the hardened runtime. A re-sign that drops them
  produces an app that crashes at launch.

To inspect what you have without changing anything:

```sh
./relink-libvips.sh --app "$HOME/Volli Code.app" --verify
```

## Method 2 — re-sign with your own Developer ID

If you have an Apple Developer account, sign your libvips and the app with your own
identity. Library validation is then satisfied normally, because both sides share your Team
ID, and no entitlement change is needed:

```sh
./relink-libvips.sh --app "$HOME/Volli Code.app" \
  --dylib ~/build/libvips-cpp.8.18.6.dylib \
  --mode team --identity "Developer ID Application: Your Name (TEAMID)"
```

## What you give up either way

These are consequences of modifying a signed application, not conditions we impose:

- **Notarization.** Your copy is no longer notarized by Apple. On the machine that modified
  it this does not matter; moving it to another Mac will meet Gatekeeper.
- **Automatic updates.** The built-in updater replaces the whole application when it applies
  an update, so it will replace your libvips with an official build. Turn updates off in
  Settings if you want your build to persist.
- **Our ability to help.** A crash report from a modified build tells us very little.

## If it still does not load

- **Quit the app completely first.** macOS caches a file's code signature while it is
  mapped, so a bundle re-signed in place can keep behaving like the old one until every
  process using it has exited. Copying the bundle to a new path also clears this.
- **Check the architecture.** `file libvips-cpp.*.dylib` must report `arm64`.
- **Check the install name.** `otool -D` on your library must print
  `@rpath/libvips-cpp.<version>.dylib`, matching the file name exactly.
- **Check what the addon asks for.** `otool -L` on `sharp-darwin-arm64-*.node` prints the
  name it will look up; your file must answer to it.
- **Missing symbols** mean the library loaded and was the wrong build — a different libvips
  version, or one configured without a feature the addon uses. That is a build problem, not
  a signing one, and it means the replacement worked.

## If image handling stops working entirely

The application treats libvips as optional: it is loaded on demand, and a failure to load is
handled as a failed image read rather than a failed startup. An image the assistant cannot
process comes back as `[Image omitted: could not make a provider-safe copy.]`. So a broken
replacement degrades that one feature; it does not brick the application, and putting the
original library back restores it.
