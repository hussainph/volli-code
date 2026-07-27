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

- Page, text, border, and ember values match `apps/website/src/styles/global.css`.
- The readable accent `#ff966c` is the app's generated `--primary-text` token,
  the ember solved onto a dark background at APCA Lc60. Fills use `#e8652a`;
  text uses `#ff966c`, because ember at full strength fails contrast as body
  copy. This is the same rule the desktop app follows.

If either of those upstream palettes changes, update `volli.css` to match rather
than letting the sites drift.

The site is dark only. `src/components/ThemeSelect.astro` renders nothing, which
removes Starlight's light/dark toggle, and `volli.css` declares the palette on
both `:root` and `:root[data-theme="light"]` so a visitor whose system prefers
light still gets the dark site.

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
