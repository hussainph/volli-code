<!-- GENERATED FILE — do not edit by hand.
     Regenerate: node apps/desktop/scripts/generate-license-notice-inputs.mjs
     Verified in CI: pnpm -C apps/desktop run check:notice-inputs -->

# Notice inputs

Attribution text for the centralized notice files, derived from the installed dependency
tree. This file is an INPUT handoff, not a notice: nothing here ships as-is, and the
tickets that own `apps/desktop/THIRD-PARTY-NOTICES` and the website's static notices decide
the final wording and placement.

Why it is generated: the component lists below change with every `@img/sharp-libvips` bump,
and a notice that silently describes an older library is the failure mode this replaces.

The reasoning, and the questions still open, are in `dependency-license-review.md`.

## 1. LGPL — libvips, shipped inside the desktop app

Package: `@img/sharp-libvips-darwin-arm64@1.3.3`  
SPDX: `LGPL-3.0-or-later`  
Upstream: https://github.com/lovell/sharp-libvips.git  
Payload: `./lib/libvips-cpp.8.18.6.dylib`, loaded at run time by `@img/sharp-darwin-arm64`'s native addon.

### 1a. Notice text (LGPLv3 sections 4(a) and 4(c))

Section 4(a) wants prominent notice that the library is used and is covered by the LGPL;
4(c) wants libvips named among any copyright notices the app shows while running.

**One line in this draft is still conditional.** The sentence marked below asserts a fact
about the shipped artifact that is only true once the notices ticket has acted: §1b's license
copies must actually be in the bundle. Publishing it unchanged would turn an open obligation
into a false compliance claim, which is worse than shipping no notice at all. Delete or amend
the marked line if the condition does not hold.

The relink sentence is NO LONGER conditional. VC-409 ruled on §B2: Volli keeps LGPL libvips
and keeps the packaged app's hardened runtime, and discharges 4(d)/4(e) by shipping
Corresponding Source directions and working Installation Information inside the bundle, at
`Contents/Resources/licensing/`. The replaceability claim now has something behind it.

```text
This application uses libvips, bundled as a prebuilt shared library together with its
dependencies. libvips and several of the components it links are used under the terms of
the GNU Lesser General Public License version 3 or later.

Components used under an LGPL license:
  - fribidi
  - glib
  - libexif
  - libheif
  - librsvg
  - libvips
  - pango
  - proxy-libintl

libvips itself is available from https://github.com/libvips/libvips and the prebuilt
package from https://github.com/lovell/sharp-libvips.

[ONLY IF §1b IS DONE] Copies of the GNU General Public License v3 and the GNU Lesser
General Public License v3 accompany this application.

The library is dynamically linked and ships as a separate, unmodified file inside the
application bundle, so it can be replaced with a compatible build. Instructions for doing so,
and directions to the source it is built from, accompany this application in its licensing
folder.
```

On the relink sentence: the library genuinely is dynamically linked and genuinely does ship
unpacked — `check:licenses` asserts both. macOS library validation does still stand between a
user and a replacement dylib, which is why the sentence points at instructions rather than
implying a drag-and-drop swap: `licensing/RELINK-LIBVIPS.md` ships beside the notice and was
verified end to end against a signed build. The About surface 4(c) engages should point at
that folder too.

### 1b. License texts that must accompany the app (LGPLv3 section 4(b))

Section 4(b) requires a copy of BOTH documents. They are not in this repository and are not
generated here on purpose — they must be byte-verbatim canonical copies, and a reflowed or
paraphrased GPL is not a copy of it.

| File to ship | Canonical source |
| --- | --- |
| `GPL-3.0.txt` | <https://www.gnu.org/licenses/gpl-3.0.txt> |
| `LGPL-3.0.txt` | <https://www.gnu.org/licenses/lgpl-3.0.txt> |

The `@img/sharp-libvips-darwin-arm64` package itself ships neither: its files are `package.json`,
`README.md`, `versions.json`, one header and the dylib. The README's component table is
reproduced below because it is the only license statement the package carries.

### 1c. Component licenses — verbatim from the package README

| Library | Used under the terms of |
| --- | --- |
| aom | BSD 2-Clause + Alliance for Open Media Patent License 1.0 <https://aomedia.org/license/patent-license/> |
| cairo | Mozilla Public License 2.0 |
| cgif | MIT License |
| expat | MIT License |
| fontconfig | fontconfig License <https://gitlab.freedesktop.org/fontconfig/fontconfig/blob/main/COPYING> (BSD-like) |
| freetype | freetype License <https://git.savannah.gnu.org/cgit/freetype/freetype2.git/tree/docs/FTL.TXT> (BSD-like) |
| fribidi | LGPLv3 |
| glib | LGPLv3 |
| harfbuzz | MIT License |
| highway | BSD 3-Clause |
| lcms | MIT License |
| libarchive | BSD 2-Clause |
| libexif | LGPLv3 |
| libffi | MIT License |
| libheif | LGPLv3 |
| libimagequant | BSD 2-Clause <https://github.com/lovell/libimagequant/blob/main/COPYRIGHT> |
| libnsgif | MIT License |
| libpng | libpng License <https://github.com/pnggroup/libpng/blob/master/LICENSE> |
| librsvg | LGPLv3 |
| libtiff | libtiff License <https://gitlab.com/libtiff/libtiff/blob/master/LICENSE.md> (BSD-like) |
| libultrahdr | MIT License |
| libvips | LGPLv3 |
| libwebp | New BSD License |
| libxml2 | MIT License |
| mozjpeg | zlib License, IJG License, BSD 3-Clause <https://github.com/mozilla/mozjpeg/blob/master/LICENSE.md> |
| pango | LGPLv3 |
| pixman | MIT License |
| proxy-libintl | LGPLv3 |
| zlib-ng | zlib License <https://github.com/zlib-ng/zlib-ng/blob/develop/LICENSE.md> |

Also stated by the README:

> Use of libraries under the terms of the LGPLv3 is via the "any later version" clause of the LGPLv2 or LGPLv2.1.

### 1d. Component versions — verbatim from the package versions.json

| Component | Version |
| --- | --- |
| aom | 3.15.0 |
| archive | 3.8.9 |
| cairo | 1.18.4 |
| cgif | 0.5.3 |
| exif | 0.6.26 |
| expat | 2.8.3 |
| ffi | 3.8.0 |
| fontconfig | 2.18.3 |
| freetype | 2.14.3 |
| fribidi | 1.0.16 |
| glib | 2.89.4 |
| harfbuzz | 14.3.1 |
| heif | 1.23.2 |
| highway | 1.4.0 |
| imagequant | 2.4.1 |
| lcms | 2.19.1 |
| mozjpeg | 0826579 |
| pango | 1.58.2 |
| pixman | 0.46.4 |
| png | 1.6.58 |
| proxy-libintl | 0.5 |
| rsvg | 2.62.91 |
| tiff | 4.7.2 |
| uhdr | 2.0.2 |
| vips | 8.18.6 |
| webp | 1.6.0 |
| xml2 | 2.15.3 |
| zlib-ng | 2.3.3 |

The two tables are reproduced side by side rather than joined: upstream keys them
differently (`exif` against `libexif`, `vips` against `libvips`), and pairing them here
would mean inventing a mapping upstream does not publish.

## 2. GSAP — bundled into the marketing website

Package: `gsap@3.15.0`  
License: Standard 'no charge' license: https://gsap.com/standard-license.  
Terms read at <https://gsap.com/standard-license> (effective 2025-04-30).

The operative notice already ships: GSAP's own `/*!` banners survive into the deployed
bundles, which is what section III.3 protects. `apps/website/scripts/check-bundled-license-notices.mjs`
holds them there. A static website notice, if one is added, needs only:

```text
GSAP 3.15.0 — Copyright 2008-2026, GreenSock. All rights reserved.
Used under the GreenSock Standard License: https://gsap.com/standard-license
```

## 3. Dual-licensed dependencies — the half Volli elected

A notice reading only `MPL-2.0 OR Apache-2.0` leaves the reader to guess which set of terms
applies. These entries state the election.

| Package | Published as | Volli elects |
| --- | --- | --- |
| `dompurify` | (MPL-2.0 OR Apache-2.0) | Apache-2.0 |
| `node-forge` | (BSD-3-Clause OR GPL-2.0) | BSD-3-Clause |
| `json-schema` | (AFL-2.1 OR BSD-3-Clause) | BSD-3-Clause |

## 4. Dependencies whose license is not in their manifest

Automated scanners report these as unlicensed. They are not — the license is simply somewhere
a scanner does not look, so a notice generator must be told where to read it from.

| Package | License | Read from |
| --- | --- | --- |
| `khroma` | MIT | the package's own `license` file |
| `@yuku-codegen/binding-*` | MIT | its parent package's manifest |
| `@yuku-parser/binding-*` | MIT | its parent package's manifest |
