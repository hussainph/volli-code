<!-- GENERATED FILE — do not edit by hand.
     Regenerate: node apps/desktop/scripts/generate-lgpl-source-offer.mjs
     Verified in CI: pnpm -C apps/desktop run check:lgpl-source

     This file SHIPS INSIDE the application bundle (Contents/Resources/licensing).
     It is not an internal note: it is the notice and the source directions that
     LGPLv3 section 4 requires accompany the binary. -->

# libvips and the GNU Lesser General Public License

Volli Code 0.2.0-canary.11 includes **libvips**, bundled together with its own
dependencies as a single prebuilt shared library:

    lib/libvips-cpp.8.18.6.dylib

It is supplied by the npm package `@img/sharp-libvips-darwin-arm64@1.3.3`,
published under **LGPL-3.0-or-later**, and built from
<https://github.com/lovell/sharp-libvips>.

## The components covered by the LGPL

libvips itself and the following bundled components are used under the terms of the GNU
Lesser General Public License, version 3 or later. Upstream reaches LGPLv3 for some of
them through the “any later version” clause of the LGPLv2 or LGPLv2.1.

  - fribidi
  - glib
  - libexif
  - libheif
  - librsvg
  - libvips
  - pango
  - proxy-libintl

The other components in the same library are under permissive licenses; they are listed,
with their terms, in the application’s third-party notices.

## The license itself

Verbatim copies of both documents the LGPL requires accompany this application, in this
same folder:

  - GPL-3.0.txt
  - LGPL-3.0.txt

## Getting the source code

The LGPL gives you the right to the source of the LGPL-covered parts, so that you can study,
modify and rebuild them. Every component below is fetched from the address shown, by the
build script listed at the end, at exactly the version shown.

| Component | Version | Source |
| --- | --- | --- |
| fribidi | 1.0.16 | <https://github.com/fribidi/fribidi/releases/download/v1.0.16/fribidi-1.0.16.tar.xz> |
| glib | 2.89.4 | <https://download.gnome.org/sources/glib/2.89/glib-2.89.4.tar.xz> |
| libexif | 0.6.26 | <https://github.com/libexif/libexif/releases/download/v0.6.26/libexif-0.6.26.tar.xz> |
| libheif | 1.23.2 | <https://github.com/strukturag/libheif/releases/download/v1.23.2/libheif-1.23.2.tar.gz> |
| librsvg | 2.62.91 | <https://download.gnome.org/sources/librsvg/2.62/librsvg-2.62.91.tar.xz> |
| libvips | 8.18.6 | <https://github.com/libvips/libvips/releases/download/v8.18.6/vips-8.18.6.tar.xz> |
| pango | 1.58.2 | <https://download.gnome.org/sources/pango/1.58/pango-1.58.2.tar.xz> |
| proxy-libintl | 0.5 | <https://github.com/frida/proxy-libintl/archive/0.5.tar.gz> |

The library is **not** compiled from those tarballs unmodified, so the tarballs alone are not
the whole of the source. It is built by the sharp-libvips build scripts, version 1.3.3:

  <https://github.com/lovell/sharp-libvips/archive/refs/tags/v1.3.3.tar.gz>

You need that as well: it carries the configure flags, the source edits applied during the
build, and the exact way the components are linked together into one library.

These components are patched before they are compiled. The patches are part of the source
you are entitled to, and are applied by the build script above:

  - glib: <https://gist.github.com/kleisauke/284d685efa00908da99ea6afbaaf39ae/raw/bdad5489a61c217850631571caf57f5db6ea8b2c/glib-without-gregex.patch>
  - libvips: <https://gist.githubusercontent.com/lovell/313a6901e9db1bf285f2a1f1180499e4/raw/3988223c7dfa4d22745d9392034b0117abef1446/libvips-cpp-soversion.patch>

### If any of those addresses has gone

They are third-party servers, and the obligation to keep the source reachable is ours, not
theirs. If a link above is dead, ask us and we will supply the Corresponding Source for the
version you have, on a medium customarily used for software interchange:

  <https://github.com/hussainph/volli-code/issues>

This offer is valid for anyone who has a copy of this software, for as long as we distribute
this version of it, and for at least three years after we stop.

## Running your own build of libvips

Section 4(d) of the LGPL is not only about source: you are entitled to run a **modified**
libvips inside this application. The library ships as a separate, unmodified, replaceable
file for that reason — it is not sealed inside the application archive.

macOS puts one obstacle in the way, and we have documented how to get past it rather than
removing the protection that causes it. See **RELINK-LIBVIPS.md**, beside this file, and the
script it describes.

