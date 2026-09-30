# @volli/docs

The user-facing documentation site for Volli, published at
[docs.volli.app](https://docs.volli.app).

Built with [Astro Starlight](https://starlight.astro.build). It deploys to its
own Cloudflare Pages project, separate from the marketing site in `apps/website`.

## Commands

```sh
pnpm -C apps/docs dev      # local preview on :4321
pnpm -C apps/docs build    # typecheck, build, docs integrity, and font notices
pnpm -C apps/docs check:docs # check an existing dist/ build
pnpm -C apps/docs deploy   # build, then wrangler pages deploy
```

## Layout

```
src/content/docs/     pages, one .mdx per route
src/data/navigation.ts shared sidebar and llms.txt navigation
src/lib/generated-markdown.ts data-backed Markdown reference expansion
src/styles/volli.css  the brand layer
src/components/       Starlight components and overrides
scripts/check-docs.mjs built-page integrity checks
astro.config.mjs      Starlight configuration
```

Add a `.mdx` file and list its route in `src/data/navigation.ts`. Both the
sidebar and `/llms.txt` use that definition. The build rejects an unlisted or
missing page. Every page also has a Markdown mirror at `/<slug>.md`, used by
**Copy page**.

The build checks local links and anchors, retained fragments from split pages,
heading hierarchy, Markdown mirrors, Copy page targets, and the agent index. Data-backed reference components must
also be expanded in `src/lib/generated-markdown.ts`; a component tag without
its content is not a usable copied page.

## Brand

`src/styles/volli.css` maps Starlight's `--sl-*` custom properties onto Volli's
palette. The values come from two places, and both are upstream of this file:

- Page, text, border, and brand-accent values match
  `apps/website/src/styles/site.css`.
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
notice and license text travel with the fonts. `src/pages/licenses.txt.ts`
imports the font package's `package.json` and `LICENSE`, and publishes them as
`/licenses.txt`, which the footer links. Nothing is transcribed by hand, so
bumping the font package rewrites the notice on the next build.

That route names the fonts this site redistributes. The rendering comes from
`@volli/font-notices`, shared with `apps/website`. To add a family, declare the
package in `package.json`, load it in `astro.config.mjs`, and add it to the list
in `src/pages/licenses.txt.ts`.

`pnpm -C apps/docs build` finishes by running `check-font-notices`, the gate that
`@volli/font-notices` installs. It fails the build if `dist/` holds a font file
that `/licenses.txt` does not cover. `pnpm -C apps/docs deploy` builds first, so
it runs there too, and CI builds both sites.

## Writing

Use both `product-docs` and `.agents/skills/google-developer-docs`. Before
drafting, record the page's reader, goal, dominant type (tutorial, how-to,
explanation, or reference), prerequisites, and product fact sources. Review the
outline against that contract before writing.

Use second person, active voice, exact UI labels in bold, and sentence-case
headings. Procedures name the location before the action. Keep alternatives
out of the main tutorial path. Run the product-docs voice checklist and the
Google reference checklist on every substantive rewrite. Do not add generic
warm-ups, marketing praise, synonym cycling, or repeated summaries.

`CONTEXT.md` supplies terminology; implementation and tests establish current
behavior. Record unverified facts as open questions in the audit rather than
publishing guesses. Do not change screenshot alt text to disguise an outdated
control. Prefer one canonical procedure with links from related pages.

The comparison, page contracts, source links, and follow-ups for the 0.2 pass
are in `docs/research/docs-0-2-audit.md` at the repository root.

## Deployment

Cloudflare Pages project `volli-docs`, serving `docs.volli.app`. DNS and TLS are
in place; `pnpm -C apps/docs deploy` builds and ships to it.
