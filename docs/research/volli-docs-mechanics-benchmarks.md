# Volli Code documentation mechanics benchmarks

---
research_date: 2026-09-15
scope: "Docs mechanics for Volli Code (apps/docs; 14-page Astro Starlight site)"
method: "Read public benchmark pages and documentation; compared navigation, search, release, media, reference, maintenance, accessibility, and onboarding mechanics against the repository baseline and Google developer-docs guidance."
---

## Baseline and reading rules

[observed] Volli currently has three sidebar groups—Get started, Using Volli, and Reference—plus Pagefind search, edit-on-GitHub links, a per-page Copy page control, generated `/llms.txt`, and a dark-only palette. Source: [`astro.config.mjs`](../../apps/docs/astro.config.mjs).

[observed] The benchmark set is Stripe, Linear, Raycast, Zed, and Supabase, with Mintlify as an optional docs-platform benchmark. The public pages below are the evidence set; a result is not treated as evidence until its URL was fetched.

[interpretation] Recommendations favor small, local-first changes that preserve Starlight and do not import a hosted docs platform. They are mechanics recommendations, not product-content recommendations.

## Navigation and information architecture

[observed] Stripe’s home page offers use-case entry points such as “Accept payments online,” then a product-oriented “Browse by product” structure. This gives a goal-first route alongside product browsing: https://docs.stripe.com.

[observed] Zed’s getting-started page uses a numbered path—open a project, learn commands, configure, set up a language, then try AI—and adds links for people migrating from other editors: https://zed.dev/docs/.

[observed] Raycast’s manual exposes a “Start Here” area, an “Explore Raycast” area, “Latest Releases,” and “Get in Touch” from its landing page: https://manual.raycast.com/.

[observed] Supabase documents that it revised its information architecture after sections became miscellaneous collections; the change is itself recorded as a changelog entry: https://supabase.com/changelog/29798-improved-docs-information-architecture.

[interpretation] Keep Volli’s three groups, but make the first group an explicit success path: Install → Quickstart → Concepts. Add a short “Next steps” block to the end of each tutorial/how-to, linking to exactly one likely next task and one relevant reference.

[interpretation] Add breadcrumbs or an equivalent visible location trail only if Starlight does not already supply one. Do not add top-level tabs merely to imitate larger sites; 14 pages do not need another navigation layer.

## Search and findability

[observed] Linear documents keyboard-first search with `/`, exact or partial issue identifiers, search across titles/descriptions/comments, recent searches, filters, and relevance/status ordering. It also distinguishes workspace search from find-in-view: https://linear.app/docs/search.

[observed] Stripe exposes a docs-search CLI command, allowing a reader to search the docs from the terminal as well as the website: https://docs.stripe.com/cli/docs/search.

[observed] Mintlify supports result snippets, page/group ranking boosts, exclusion of low-value pages, and product/version filters when the navigation contains those dimensions: https://www.mintlify.com/docs/optimize/search.

[interpretation] Keep Pagefind, but make the search affordance visibly keyboard discoverable (for example, a `/` or `⌘K` hint) and ensure the shortcut does not steal focus from code blocks or form controls. Add result context/breadcrumbs if the current Starlight integration permits it.

[interpretation] With only 14 pages, do not add AI answers or semantic retrieval yet. First measure zero-result queries and clicks; use search ranking metadata only for a clearly high-value Quickstart or CLI page.

## Versioning, releases, and change discovery

[observed] Stripe’s changelog groups changes by API release/date and labels affected products, breaking status, and category; API versioning and upgrades are linked from the docs: https://docs.stripe.com/changelog and https://docs.stripe.com/api/versioning.

[observed] Supabase maintains a dated changelog with entry types such as New Feature, Improvement, Bug Fix, Breaking Change, and Deprecation, plus product tags and detail pages: https://supabase.com/changelog.

[observed] Raycast’s public changelog is separate from the manual and lists macOS product releases: https://www.raycast.com/changelog.

[observed] Zed links release notes from its docs index and publishes release information separately, including stable-release notes: https://zed.dev/docs/ and https://zed.dev/releases/stable.

[interpretation] Do not introduce full versioned docs for a local desktop app at 0.2.0. Add a lightweight “What’s new” or release-notes page when releases become regular; each entry should state date, user-visible change, affected area, and migration/breaking status.

[interpretation] Link release notes from the docs landing page and footer, not from every how-to. If behavior diverges by app version later, add version selectors only when there are two supported behaviors worth maintaining.

## Media, code, and interactive examples

[observed] Linear’s search page uses screenshots to expose the search interaction and pairs them with descriptive alt text in the page source: https://linear.app/docs/search.

[observed] Zed’s getting-started page favors copyable command blocks and a compact keyboard table, then links out to deeper procedures: https://zed.dev/docs/.

[observed] Raycast presents a large, scannable shortcut inventory with platform variants and action-oriented grouping, rather than embedding every shortcut in prose: https://manual.raycast.com/keyboard-shortcuts.

[interpretation] Add screenshots only when they convey state or control placement that prose cannot. Give every non-decorative screenshot concise alt text describing the screen, control, and useful state; add a caption when the reader needs interpretation. This matches Google’s image guidance: https://developers.google.com/style/images.

[interpretation] Prefer short, focused clips for a multi-step UI gesture over long product tours. Keep commands copyable, include safe sample data, and avoid interactive demos until a real procedure cannot be understood without one.

## Reference ergonomics

[observed] Zed puts common commands and platform-specific shortcuts in a compact table and tells readers to use the command palette when they forget a shortcut: https://zed.dev/docs/.

[observed] Raycast groups shortcuts by scope—global, navigation, lists, search, actions, forms, and text editing—and shows macOS and Windows/Linux variants where applicable: https://manual.raycast.com/keyboard-shortcuts.

[observed] Stripe’s changelog tables expose title, affected product, breaking-change status, and category as scan-friendly columns: https://docs.stripe.com/changelog.

[interpretation] Keep CLI flags, keyboard shortcuts, and stable labels in tables or short definition lists. Put workflow explanation on guide pages and keep reference pages terse. Use exact UI labels in bold and commands/flags in code font, with imperative numbered steps for procedures: https://developers.google.com/style/procedures.

[interpretation] For Volli’s macOS audience, show `⌘` symbols first and state the equivalent only when supported. Do not copy Raycast’s cross-platform rows unless Volli actually supports the platform.

## Maintenance and feedback loops

[observed] Volli already exposes edit-on-GitHub links and an agent-oriented Copy page control in its Starlight configuration: [`astro.config.mjs`](../../apps/docs/astro.config.mjs).

[observed] Mintlify supports page ratings, contextual notes, edit suggestions, issue creation, code-snippet feedback, status tracking, and CSV export: https://www.mintlify.com/docs/optimize/feedback.

[observed] Zed states that its docs are built on push to `main`, and its repository exposes a maintained docs source and summary: https://github.com/zed-industries/zed/tree/main/docs.

[interpretation] Add a low-friction “Was this page helpful?” control only when there is an owner and a review queue. A thumbs-only metric without triage creates noise; initially, an issue link with a prefilled page URL is enough.

[interpretation] Add a visible “Last reviewed” date only when it can be maintained automatically or in page metadata. Otherwise use release-note links and repository history rather than a stale hand-written freshness promise.

## Accessibility and platform fit

[observed] Google’s accessibility guidance calls for descriptive headings, navigable structure, accessible links/lists/tables, and concise alt text: https://developers.google.com/style/accessibility.

[observed] Raycast’s manual documents keyboard operation extensively, including escape/back behavior, focus movement, and alternate bindings: https://manual.raycast.com/keyboard-shortcuts.

[observed] The current Volli configuration intentionally removes the theme selector and pins a dark palette: [`astro.config.mjs`](../../apps/docs/astro.config.mjs).

[interpretation] Retain dark-only styling only if contrast, focus indicators, code contrast, reduced-motion behavior, keyboard navigation, and mobile sidebar operation pass an accessibility check. A dark-only brand choice must not become a dark-only accessibility assumption.

[interpretation] Test narrow screens, zoom, keyboard-only traversal, screen-reader names for icon buttons, and visible focus. Do not use screenshots as the only explanation of a control.

## Getting started and page discipline

[observed] Zed’s first page names the end-to-end path and places prerequisites/actions in reader order; its first concrete outcome is opening a project: https://zed.dev/docs/.

[observed] Stripe’s landing page offers outcome-oriented quickstarts before its broad product catalog: https://docs.stripe.com.

[interpretation] Volli’s Quickstart should promise one concrete first success, list prerequisites before steps, use one recommended path, and finish with the next action. Keep alternatives in an explicitly labeled Optional section or a linked how-to.

[interpretation] Apply the judging checklist: one reader, one goal, one dominant page type; sentence-case headings; second person; active voice; exact UI labels; and one action per procedure step: [Google developer docs reference](https://developers.google.com/style).

[interpretation] Do not put release marketing or broad product pitch inside how-to pages. Keep explanation, procedures, reference facts, and release communication separate so a reader can scan for the action they need.

## Recommended mechanics

| Mechanic | Exemplar (URL) | Adopt now/later/no | Effort (S/M/L) | Why |
|---|---|---|---|---|
| Goal-first Quickstart with explicit next step | https://zed.dev/docs/ | Adopt now | S | Shortens time to first successful workspace. |
| Keyboard shortcut hint and robust focus behavior for search | https://linear.app/docs/search | Adopt now | M | Fits an agent/developer audience and makes Pagefind discoverable. |
| Compact shortcut/CLI reference tables | https://manual.raycast.com/keyboard-shortcuts | Adopt now | S | Improves scanning without changing the site architecture. |
| Screenshot alt text and purposeful captions | https://developers.google.com/style/images | Adopt now | S | Preserves information for screen-reader and text-only readers. |
| Lightweight dated release notes with breaking-status labels | https://supabase.com/changelog | Adopt later | M | Makes 0.2.0 changes findable without premature versioned docs. |
| Per-page helpfulness plus actionable issue link | https://www.mintlify.com/docs/optimize/feedback | Adopt later | M | Creates a measurable maintenance loop only after ownership exists. |
| Search snippets/ranking controls | https://www.mintlify.com/docs/optimize/search | Adopt later | M | Useful as pages grow; unnecessary complexity for 14 pages today. |
| Separate use-case and product browsing entry points | https://docs.stripe.com | Adopt later | M | Valuable when Volli has enough tasks to justify two IA paths. |
| AI answers or semantic docs search | https://linear.app/changelog/2025-04-10-new-search | No for now | L | Adds trust, ranking, and maintenance costs before Pagefind evidence warrants it. |

## Do not copy

- [interpretation] Do not copy Stripe’s large product taxonomy; Volli’s 14 pages need a short task path, not enterprise-scale browsing.
- [interpretation] Do not put marketing language in how-to openings; Google’s page-type discipline requires the reader’s outcome and shortest supported path.
- [interpretation] Do not add version selectors without two supported behaviors and an owner for duplicated content.
- [interpretation] Do not ship screenshots without alt text, or make a screenshot the only source of a procedure.
- [interpretation] Do not add feedback widgets, AI answers, or ranking controls without a review loop and measurable problem to solve.
