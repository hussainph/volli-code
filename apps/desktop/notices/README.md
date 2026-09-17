# Desktop licence notices

`apps/desktop/THIRD-PARTY-NOTICES` is the notice that ships inside the macOS
application bundle. It is generated, not written:

```sh
node apps/desktop/scripts/generate-third-party-notices.mjs        # regenerate
pnpm -C apps/desktop run check:notices                            # what CI runs
```

Three files ride along in the packaged `.app`, all under `Contents/Resources`
(Finder → Show Package Contents), declared by `extraResources` in
`electron-builder.yml`:

| In the bundle                                | From                                                    |
| -------------------------------------------- | ------------------------------------------------------- |
| `Contents/Resources/LICENSE.txt`             | the repository's `LICENSE`                              |
| `Contents/Resources/THIRD-PARTY-NOTICES.txt` | `apps/desktop/THIRD-PARTY-NOTICES`                      |
| `Contents/Resources/LICENSES.chromium.html`  | `node_modules/electron/dist/LICENSES.chromium.html` |

## What the generator derives, and what this directory supplies

The generator walks the production dependency closure of `apps/desktop` and
`packages/cli` — the two roots whose code reaches the bundle — and reads each
package's own licence and NOTICE files. That covers the renderer bundle, the
packed main process, the `node_modules` tree electron-builder keeps, the fonts,
and the `volli` CLI.

It cannot see four kinds of thing, so this directory carries them in
`sources.json`, reviewed by a person and verified by the generator:

- **`platformNative`** — packages that install on one platform only (the sharp
  addon, its libvips dylib, ripgrep's binary). Their licence text is pinned in
  `texts/` so the document renders identically on macOS and on Linux CI. When
  the package _is_ installed, the generator compares the pinned text and version
  against it and fails on drift.
- **`toolchain`** — development dependencies whose own code or generated output
  ships anyway: Electron (the runtime itself), Tailwind and `tw-animate-css`
  (their CSS is emitted into the renderer stylesheet). Their versions and licence
  texts are read live from `node_modules`.
- **`vendored`** — third-party source copied into the repository instead of
  installed, each with the in-repo evidence that establishes where it came from.
  An entry whose provenance is not recorded carries `unresolved` instead of a
  licence, and the document prints it as unresolved rather than guessing.
- **`fragments`** — notices that exist outside any package: today the TextMate
  theme data, whose upstream copyrights live in tm-themes' `NOTICE` rather than
  in a package's `LICENSE`. `editor-themes.NOTICE` is regenerated from that
  upstream file by `scripts/generate-editor-theme-notices.mjs`.
- **`expectedFragments`** — a notice another workspace package owns, which this
  document has to carry because the `.app` ships this file and not that one.
  Each entry names the file, the marker that identifies its material in shipped
  source, and the trees to search. The generator folds the file in verbatim the
  moment it exists; while it does not, the document prints the entry as pending;
  and if the material appears in shipped source while the file is still missing,
  `check:notices` fails rather than packaging it with no attribution.

## When you have to regenerate

Any change to the production dependency set: adding or removing a dependency,
bumping one, changing `electron-builder.yml`'s shipped-package whitelist, or
editing this directory. `check:notices` fails in CI otherwise, and it also fails
when the packaging config stops shipping the notices or starts shipping a package
nothing covers.

Adding a dependency with an unusual licence needs no code change here — the
generator reports whatever the package declares and publishes, and lists
anything that is not a plain permissive grant in the document's last section.

## Open items

These are recorded rather than decided. None of them is a conclusion about
obligations; the licensing review that reaches conclusions is tracked separately
from the packaging work that produced this pipeline.

1. **Copyright holder.** The root `LICENSE` still carries the Apache-2.0
   appendix placeholder, no manifest names an author, and there is no `NOTICE`
   file. The document says exactly that instead of naming a holder.
2. **AI Elements provenance.** `src/renderer/src/components/ui/ai-elements/` was
   copied in; the introducing commit records no upstream project, revision or
   licence. The entry stays `unresolved` until someone confirms the origin and
   adds it to `sources.json` with its licence text.
3. **APCA-W3 formulation.** `packages/shared/src/theme/color.ts` implements the
   published APCA-W3 constants in shipped code (the `apca-w3` package itself is a
   test-only devDependency). Whether that reproduction carries an obligation is
   part of the separate licensing review.
4. **Declarations flagged for review.** The document's last section lists every
   declaration that is not a plain permissive grant — today the libvips binary's
   `LGPL-3.0-or-later`, DOMPurify's `(MPL-2.0 OR Apache-2.0)`, and node-forge's
   `(BSD-3-Clause OR GPL-2.0)`. They are listed so a reviewer can find them.
5. **Shared terminal theme catalog.** `packages/shared/THIRD-PARTY-THEMES.md` —
   the iTerm2-Color-Schemes licence and provenance for the Ghostty theme catalog,
   including the per-theme ambiguity that work identifies — is being written on
   another ticket's branch. Neither the catalog nor the file is in this tree, so
   the document prints the entry as pending and asserts nothing about it. The
   integration needs no further code: the `expectedFragments` entry folds the
   file into the shipped notice as soon as it lands (regenerate, or CI's
   `check:notices` will say so), and fails the check if the catalog ships first.
   Per-theme licence judgements stay with the review that owns them; this
   pipeline only guarantees the attribution travels inside the `.app`.

Out of this artifact's scope, stated so the boundary is legible: the docs and
website static sites (including GSAP, which only `apps/website` depends on) are
not part of the desktop bundle and are covered by their own work.
