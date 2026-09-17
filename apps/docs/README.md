# @volli/docs

The user-facing documentation site for Volli Code, published at
[docs.volli.app](https://docs.volli.app).

Built with [Astro Starlight](https://starlight.astro.build). It deploys to its
own Cloudflare Pages project, separate from the marketing site in `apps/website`.

## Commands

```sh
pnpm -C apps/docs dev      # local preview on :4321
pnpm -C apps/docs build    # astro check + static build to dist/
pnpm -C apps/docs deploy   # build, then wrangler pages deploy
```

## Layout

```
src/content/docs/     pages, one .mdx per route
src/styles/volli.css  the brand layer
src/components/       Starlight component overrides
astro.config.mjs      sidebar navigation lives here
```

Adding a page means creating the `.mdx` file and adding it to the `sidebar`
array in `astro.config.mjs`. A page that isn't in the sidebar still builds and is
reachable by URL, it just won't appear in the navigation.

## Brand

`src/styles/volli.css` maps Starlight's `--sl-*` custom properties onto Volli's
palette. The values come from two places, and both are upstream of this file:

- Page, text, border, and brand-accent values match
  `apps/website/src/styles/global.css`.
- The readable accent `#ff966c` is the default canvas's generated
  `--primary-text` token, solved onto a dark background at APCA Lc60. Fills use
  `#e8652a`; text uses `#ff966c`, because the fill color fails contrast as body
  copy. This fixed docs-site palette is a public-brand choice, not a constraint
  on the desktop app's theme engine.

If either of those upstream palettes changes, update `volli.css` to match rather
than letting the sites drift.

The site is dark only. `src/components/ThemeSelect.astro` renders nothing, which
removes Starlight's light/dark toggle, and `volli.css` declares the palette on
both `:root` and `:root[data-theme="light"]` so a visitor whose system prefers
light still gets the dark site.

## Fonts and licenses

The site self-hosts Mona Sans (`@fontsource-variable/mona-sans`, loaded through
Starlight's `customCss`), so every build emits its `.woff2` files and every
deploy redistributes font software. OFL-1.1 allows that only when the copyright
notice and license text travel with the fonts, so `src/pages/licenses.txt.ts`
reads them out of the installed package at build time and publishes
`/licenses.txt`, which the footer links. Nothing is transcribed by hand: bumping
the font package rewrites the notice on the next build.

`pnpm -C apps/docs build` finishes by running `scripts/check-font-notices.mjs`
from the repo root, which fails the build if `dist/` holds a font file that
`/licenses.txt` does not cover. CI builds both sites, so that gate runs there
too. Adding a second family means adding it to `REDISTRIBUTED_FONT_PACKAGES` in
`src/lib/font-notices.ts` (and to the matching list in `apps/website`).

`src/lib/font-notices.ts` is a deliberate copy of the website's module — the two
Astro projects share no build, and neither would otherwise depend on a workspace
package. This app has no test runner, so the website's `font-notices.test.ts`
owns the unit tests and fails if the two copies' code stops matching. Edit one,
edit the other.

## Writing

Documentation prose follows the `product-docs` skill: second person, active
voice, no marketing language, and no em-dashes. Terminology comes from
`CONTEXT.md` at the repo root, which is the glossary of record. Use its terms
exactly rather than inventing synonyms.

Anything not verifiable from the code gets a `{/* TODO */}` comment instead of a
guess.

## Deployment

Cloudflare Pages project `volli-docs`, serving `docs.volli.app`. DNS and TLS are
in place; `pnpm -C apps/docs deploy` builds and ships to it.
