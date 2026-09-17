# Third-party notice: the vendored Ghostty theme catalog

`@volli/shared` vendors Ghostty's bundled terminal theme collection — 463 theme
files, copied verbatim into `src/ghostty-theme-sources.generated.ts` by
`apps/desktop/scripts/generate-ghostty-themes.mjs`, which reads them out of an
installed `Ghostty.app`. That generated module is redistributed with the app, so
it is third-party material and needs a license chain. This file is that chain.

Nothing here is invented: every link below was checked against a source that can
be fetched again, and the one thing that could not be resolved is recorded as
unresolved rather than papered over.

## Provenance chain

| Link               | What it is                                                                          |
| ------------------ | ----------------------------------------------------------------------------------- |
| This repository    | `packages/shared/src/ghostty-theme-sources.generated.ts`                            |
| Read from          | `/Applications/Ghostty.app/Contents/Resources/ghostty/themes`                       |
| Which is           | Ghostty.app **1.3.0** (`CFBundleVersion` 15112), 463 theme files                    |
| Which ships        | ghostty-org/ghostty `v1.3.0`, `build.zig.zon` dependency `iterm2_themes`            |
| Pinned to          | `https://deps.files.ghostty.org/ghostty-themes-release-20260216-151611-fc73ce3.tgz` |
| Which repackages   | mbadolato/iTerm2-Color-Schemes, release **`release-20260216-151611-fc73ce3`**       |
| Collection license | MIT — Copyright (c) 2011 to Present Mark Badolato                                   |
| Per-theme license  | **Not resolved, and at least one is known to conflict — see below.**                |

Reproduce the middle of the chain with:

```
curl -s https://raw.githubusercontent.com/ghostty-org/ghostty/v1.3.0/build.zig.zon | grep -A4 iterm2_themes
ls /Applications/Ghostty.app/Contents/Resources/ghostty/themes | wc -l    # 463
defaults read /Applications/Ghostty.app/Contents/Info.plist CFBundleShortVersionString
```

The Zig dependency hash Ghostty pins for that tarball is
`N-V-__8AABVbAwBwDRyZONfx553tvMW8_A2OKUoLzPUSRiLF`, which is what ties the
release name above to exact bytes rather than to a mutable tag.

## The per-theme license question — OPEN, and not merely bookkeeping

iTerm2-Color-Schemes' own `LICENSE` grants MIT over the _collection_ and then
says, verbatim:

> This license covers the iTerm-Color-Schemes repository collection of themes.
>
> The copyright/license for each individual theme belongs to the author of that theme.

So the MIT grant reproduced below covers the collection as assembled. It does
**not** purport to license each of the 463 themes individually, and upstream
publishes no per-theme author or license index. The theme files carry nothing
themselves either: they are bare `key = value` palettes with no comment, author
line or license header anywhere in the installed directory.

That gap is tracked upstream at
<https://github.com/mbadolato/iTerm2-Color-Schemes/issues/638> — "possible
license violations of themes", opened 2025-10-13, still open, last active
2026-05-29. Its report, from someone who walked the tree while packaging
Ghostty, is that some themes have no license at all and **others prohibit
redistribution outright**.

One of those was checked here directly rather than taken on report. Monokai's
own license page (<https://monokai.pro/license>, Copyright (c) 2017-2026
Monokai) states:

> Monokai Pro may not be sub-licensed, resold, or redistributed.
>
> You may not loan, rent, transfer or grant any rights to Monokai Pro contained
> herein, or any compilation, derivative or collective work containing Monokai
> Pro to any other person or organization without the prior written consent of
> Monokai.

The catalog Volli vendors contains seven files under that name — `Monokai Pro`,
`Monokai Pro Light`, `Monokai Pro Light Sun`, `Monokai Pro Machine`,
`Monokai Pro Octagon`, `Monokai Pro Ristretto`, `Monokai Pro Spectrum` — and
also `Adventure Time`, the other theme named in that issue.

**This is reported, not resolved, and deliberately so.** Whether a palette of
sixteen hex values is protected expression at all, and whether a proprietary
theme's terms reach a third-party port of its colors, are questions this file
cannot answer and must not pretend to. What can be said is what is written
above: the terms conflict on their face, and nobody in the chain — not Ghostty,
not iTerm2-Color-Schemes, not Volli — has cleared them.

So:

- **No theme was deleted, renamed or re-described.** Removing files on an
  unresolved legal question would break the picker's parity with Ghostty's own
  `+list-themes`, and would assert a conclusion nobody here is entitled to
  reach. The catalog ships as upstream assembles it.
- **No per-theme terms were invented.** Every theme not named above is simply
  undocumented upstream; that is recorded as unknown, not filled in.
- **This needs a decision that is not an engineering one.** It is the one item
  in this ticket that cannot be closed by evidence-gathering, and it is raised
  as a blocker rather than left in a file nobody reads.

## MIT License (iTerm2-Color-Schemes)

Reproduced in full, as MIT requires of any copy or substantial portion.

```text
MIT License

Copyright (c) 2011 to Present Mark Badolato

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

This license covers the iTerm-Color-Schemes repository collection of themes.

The copyright/license for each individual theme belongs to the author of that theme.
```

Ghostty itself is MIT (ghostty-org/ghostty) and is not vendored here — only the
theme files it ships are — so its own notice is not reproduced.

## Regeneration, and what is still open

`generate-ghostty-themes.mjs` is deterministic given a themes directory: it
sorts case-insensitively, writes one entry per file and re-runs the repo
formatter, and `--check` fails when the checked-in file is stale. It is **not**
deterministic across Ghostty versions, because it reads whatever
`Ghostty.app` happens to be installed and the generated header records that path
without the version behind it. Pinning it — stamping the resolved Ghostty
version and the iTerm2 release into the generated header, and pointing both the
generator and the generated file at this notice — is the remaining work.

**It is not done here, and the reason is mechanical.** The theme catalog and its
generator landed on `main` (`aa9bd7e6`, VC-107) _after_ this ticket's worktree
was branched, and this ticket may not merge or rebase `main`. Neither
`packages/shared/src/ghostty-theme-sources.generated.ts` nor
`apps/desktop/scripts/generate-ghostty-themes.mjs` exists on this branch to
edit. This file is written to stand alone and merge cleanly; the two header
edits and a `--check`-style provenance assertion need a branch cut from a base
that has those files.
