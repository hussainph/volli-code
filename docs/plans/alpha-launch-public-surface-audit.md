# Alpha launch public-surface audit (VC-64)

**Baseline:** `9b186dd1` on `main` at the time of this audit. Findings marked
**verified** come from current source, the running `volli` CLI, or the public
URLs named below. This is an audit, not a claim that every proposed feature is
already ready to ship.

## P0 status (updated after the P0 fix session)

The alpha contract was decided: **one Alpha channel, no Canary card on the
website.** Anyone who wants a canary goes to GitHub Releases directly. That
wording is now applied identically to the website, docs, README, and Security
policy.

| P0 finding | Status |
| --- | --- |
| Production website is not the current website | **Source fixed, not deployed.** Needs `pnpm -C apps/website deploy` (wrangler, Pages project `volli-code`). |
| Production docs are not the current docs source | **Source fixed, not deployed.** Same deploy gate. `llms.txt` regenerates from source and was verified in the build. |
| Public availability contradicts itself | **Fixed in repo.** Website, docs, README, and `SECURITY.md` now agree. GitHub repo description/topics and the release notes are manual GitHub actions and still stale. |
| Latest public binary is stale relative to audited code | **Not done — requires a release decision.** No tag was cut. Everything above describes "the current alpha build" generically and reads whatever is newest from the releases feed, so it does not lie about a specific version, but the published binary is still `v0.1.0-canary.9`. |
| Live onboarding teaches a different execution model | **Fixed in source.** `start/install.mdx` and `start/quickstart.mdx` rewritten around Home, project vs ticket chats, worktrees, and review; terminal use separated as optional. Ships on the docs deploy. |
| Landing page has no above-the-fold promise/`h1`/alpha context | **Fixed.** Site header, `h1`, alpha disclosure, and CTAs now precede the demo; skip link added. |
| Landing page foregrounds Pi/terminal over chat-first Home | **Fixed.** Hero leads with the outcome; Pi and terminal detail moved below. |
| Docs missing current install and first-run path | **Fixed** (no screenshots — see below). |
| Docs missing current quickstart | **Fixed** (no screenshots — see below). |
| Demo nav says Board / Sessions / Files / Settings | **Fixed.** Home / Configure, Settings in the footer, Home tab strip with its permanent Board tab. (Originally landed as Home / Files / Configure; VC-122 then retired the Files nav row, and the demo followed.) |
| Demo presents a terminal as the primary experience | **Fixed.** Structured chat with model and effort chips; terminal named as the optional companion. |
| Demo mixes Pi wording with Claude styling and internal ticket names | **Fixed.** Brand-ambiguous classes and glyphs removed; board now shows an ordinary team's tickets. |
| README says "does not have a packaged release yet" | **Fixed.** |
| Security policy says there is no packaged release | **Fixed**, including an explicit "no SLA, no backports" statement. |

**Still open, and deliberately not invented:**

- **Screenshots.** The P0 docs pages ask for screenshot-backed walkthroughs.
  None were captured — that needs a running release build. The pages are
  written so screenshots slot in without restructuring. `guides/board.png` and
  the README hero remain stale; the README hero was **removed** rather than
  left showing the old Board/Sessions navigation.
- **Deploy, tag, and GitHub metadata.** All three are actions outside the
  worktree and were not performed.

Everything below is the original audit, unchanged.

## Scope and evidence

The audit covered:

- `apps/website` and `https://volli.app`
- `apps/docs` and `https://docs.volli.app`
- the interactive `VolliDemo` component
- the public GitHub repository, README, security policy, release page, and
  release workflow
- the current desktop renderer and product vocabulary in `CONTEXT.md`

Four read-only audit sessions were also started for the docs, website/demo,
public repository, and desktop-product inventory. This audit document is the
only planned repository change from the audit.

### Verification limits

This session has no `node` or `pnpm` on its adopted `PATH`, so it could not run
`pnpm -C apps/website build`, `pnpm -C apps/docs build`, or browser-based
responsive/a11y checks. Those are launch gates below, not assumed green.

## Executive result

There are two different public products today:

1. **Production is stale.** `https://volli.app/` still presents “Program the
   software lifecycle.” Both `/download` and `/download/` return HTTP 200 with
   that same home-page title instead of a download page. The current checkout
   contains `apps/website/src/pages/download.astro`, so the deployed site does
   not represent current source.
2. **The deployed docs describe the former harness-first product.** The live
   install guide says that a coding-agent CLI is required, that Volli does not
   bundle or install agents, and that moving a ticket to Doing starts an agent.
   That contradicts the current Pi-backed structured-chat product and the
   current source docs.

The public alpha cannot safely open until one release truth, one deployed web
build, and one deployed docs build agree. This is more urgent than copy polish:
a visitor can currently follow a Download CTA that has no download route, then
read onboarding for a different product.

## The current product story to preserve

This is the source-grounded story every public surface should use. It is a
baseline for the rewrite, not final marketing copy.

- Volli Code is a local-first macOS workspace for code projects. Projects,
  tickets, session history, and worktree state remain on the user's machine.
- **Home** is a tabbed project workspace: its permanent Board sits beside
  project chats and project-file tabs. It replaced the old standalone Sessions
  page (`components/home/home-surface.tsx` and `sidebar/nav-list.tsx`).
- A ticket has a Ticket Body and a scoped workspace. Ticket chats receive that
  context; a ticket worktree is a separate, isolated checkout when the work
  needs one.
- A structured **chat** is the primary session action. It uses the Pi-backed
  Agent Runtime and Model Access. A terminal is an explicit manual companion,
  not the structured-runtime fallback (`components/sessions/new-session-control.tsx`).
- Ticket work can be inspected through its files, changes, branch/worktree
  state, and review flow. Board columns organize work state; starting a session
  is a separate action.
- The only currently public install channel observed is the arm64 prerelease
  `v0.1.0-canary.9`. It is not a stable release. The checked-out `main` is 64
  commits ahead of that tag, so the alpha release needs an explicit new build
  and release decision.

## P0 — resolve before accepting alpha users

| Finding | Evidence | Required change | Completion proof |
| --- | --- | --- | --- |
| **Production website is not the current website.** | `curl` and `web_fetch` returned the old title for `https://volli.app/`, `/download`, and `/download/`; current source has `apps/website/src/pages/download.astro`. | Deploy the intended static website build to the production Pages project. Make deployment ownership and rollback explicit. | Root has the new title/content; `/download/` renders the release chooser; direct artifact links work; canonical URLs do not fall back to the home page. |
| **Production docs are not the current docs source.** | Live `/start/install/`, `/guides/board/`, `/reference/cli/`, and `/llms.txt` contain the old harness-first language. `apps/docs/src/content/docs/*` has newer, materially different text. | Deploy the reviewed docs build as one release with the website, then smoke-test every top-level route and `llms.txt`. | Live install, quickstart, board, CLI, and plain-text docs match the reviewed source and cross-links. |
| **Public availability contradicts itself.** | `README.md` and `SECURITY.md` say there is no packaged release; GitHub Releases has public canaries; source install/docs and `download.astro` advertise DMGs, Stable, and Canary. | Decide the public name and contract for tonight: **alpha**, supported architecture, download channel, update behavior, and where feedback goes. Apply the exact same wording to the website, docs, README, Security policy, GitHub release, and release notes. | A visitor can answer “what can I install?”, “is this alpha?”, “which Mac?”, “what risks apply?”, and “where do I get help?” from any entry point without finding a contradiction. |
| **The latest public binary is stale relative to the audited code.** | Git reports `v0.1.0-canary.9...HEAD` as `0 64`; the public release page also reports 64 commits to `main` since the release. | Cut, sign/notarize, publish, and manually install-test the exact alpha commit after docs/website changes are merged. Do not describe unshipped main behavior as installed behavior. | Release tag/version, GitHub assets, release notes, website download card, and installed About/version all identify the same build. |
| **Live onboarding teaches a different execution model.** | Live docs require external coding-agent CLIs and say Doing starts the agent. Current source and `volli help` show a Pi-backed structured chat, Model Access, and separate session start / board movement. | Replace live onboarding with the current flow before sending anyone to it. | A clean-machine tester can install, add a project, configure a model, start a chat, create/open a ticket, and understand when a terminal is optional. |

## 1. Landing page copy and design

### P0/P1 product-message corrections

| Priority | Finding | Evidence | Required update |
| --- | --- | --- | --- |
| P0 | The source landing page leads visually with a simulated board. Its only `h1` and product explanation appear after the demo. There is no top-level wordmark/navigation or alpha context above the fold. | `apps/website/src/pages/index.astro` starts with `<VolliDemo>` and only then renders the statement section. | Put a plain-language product promise, alpha status, supported platform, primary download/access CTA, and Docs/GitHub paths before or alongside the visual. A person should know what Volli is before being asked to decode a fake UI. |
| P0 | The page still foregrounds “durable Pi-backed Sessions” and “manual terminal companions” without naming the current chat-first Home workflow. | `index.astro`; current `home-surface.tsx`, `nav-list.tsx`, and `new-session-control.tsx`. | Explain the user outcome first: plan work, start a project or ticket chat with context, use isolated worktrees for ticket work, review changes. Keep Pi and terminal-companion detail lower on the page or link to docs. |
| P1 | There is no alpha expectation-setting: supported macOS/architecture, prerelease status, data/privacy boundary, current limitations, or feedback path. | `index.astro` has only Download and GitHub CTAs. | Add a compact alpha disclosure next to the CTA. It must link to installation, known limitations/support, privacy/local-data explanation, and release notes. Do not promise a stable channel when only a prerelease exists. |
| P1 | The current CTA says “Download for macOS,” but the release configuration is arm64-only. | `electron-builder.yml` targets only `arm64`; `index.astro` uses broad macOS wording. | Say Apple silicon/macOS until an Intel or universal artifact exists. Include the minimum macOS version once it is verified from the actual packaged build. |
| P1 | The main page has no clear path to documentation until the footer. | `index.astro`. | Add Docs to the primary navigation/CTA group and route people who need prerequisites, privacy, or a walkthrough there. |
| P1 | The page does not state that the repository is open source or link its license/security/support surfaces where a launch visitor expects them. | Footer has GitHub and README only. | Add intentional footer/help links: Docs, GitHub, release notes, security reporting, and feedback/issue tracker. |

### Design, accessibility, performance, and discovery

| Priority | Finding | Evidence | Required update |
| --- | --- | --- | --- |
| P1 | No social-share image is defined and the website only has an icon in `public/`. | `index.astro`/`download.astro` define title/description but no `og:image`; `apps/website/public/` contains only `volli-icon-dark.png`. | Produce an accurate branded OG image and set Open Graph/Twitter image metadata for root and download pages. |
| P1 | No `robots.txt` or sitemap source is present. | `apps/website/public/` and `astro.config.mjs`. | Add a deliberate indexing policy and sitemap generation before public launch. If alpha pages should be discoverable only by direct link, make that an explicit product decision instead. |
| P1 | The main website icon is a 1024×1024, 16-bit RGBA PNG (~1.68 MB) served both as favicon and a 34px footer logo. | `apps/website/public/volli-icon-dark.png`; `index.astro` and `download.astro`. The docs source duplicates the same large asset. | Replace it with correctly sized optimized favicon/app-icon variants and a small logo asset. Keep one canonical source rather than two identical 1.68 MB copies. |
| P1 | The viewport metadata omits `initial-scale=1`. | Both website pages use `content="width=device-width"`. | Use standard mobile viewport metadata and test at 320/375/414/768/1024/1440px. |
| P1 | The page has no skip link, and keyboard users encounter the large interactive demo before the actual heading/value proposition. | DOM order in `index.astro`; `VolliDemo.tsx`. | Add a skip-to-content path and make the semantic heading/intro precede complex controls. |
| P1 | The current dark-only marketing treatment can be intentional, but it needs contrast verification rather than assumption. | `global.css` pins `color-scheme: dark`; docs do the same intentionally. | Manually test text, focus, hover, reduced motion, and forced/high contrast on the deployed build. Do not add a light mode merely for symmetry if dark-only is a brand decision. |
| P2 | The landing page has no proof or concrete use case beyond the demo. | `index.astro` has one statement grid and a lifecycle accordion. | Add one real workflow/example and, when available, alpha-user proof. Do not invent testimonials, metrics, or logos. |
| P2 | The page has no FAQ for the predictable launch questions. | No FAQ/help section exists. | Cover: Mac/architecture, what runs locally vs provider-side, model requirements, Git/GitHub CLI expectations, alpha support, and uninstall/data location. |

## 2. Product documentation

### Deployment and information architecture

The source docs contain only 12 MDX pages: 3 Get started, 5 guides, and 3
reference pages plus the index. That is a useful start, but it does not cover
the current user path through Home, chats, files, and review.

| Priority | Missing or incomplete area | Current-product evidence | Needed documentation |
| --- | --- | --- | --- |
| P0 | **Current installation and first-run path** | `apps/docs/src/content/docs/start/install.mdx` is newer than the live page; `model-access-first-run.tsx`, `new-session-control.tsx`, and `nav-list.tsx` define the current product. | A short alpha install page: exact supported macOS/architecture, download/open/update path, Gatekeeper behavior if applicable, first project, Model Access/sign-in, first chat, and terminal/CLI distinction. Include clean uninstall/data-location guidance and a feedback route. |
| P0 | **Current quickstart** | The product begins in Home and defaults to Chat; the live guide describes agent handoff by moving to Doing. | One tested, screenshot-backed tutorial from download to a project chat, ticket creation, ticket chat/worktree, a reviewed change, and where to find the result. Keep it prescriptive and separate optional terminal use. |
| P1 | **Home and project chats** | `home-surface.tsx`, `home-rail.tsx`, and `sidebar/nav-list.tsx` show Home, its permanent Board tab, project-chat tabs, Project Files, and the right rail. | A dedicated “Home and project chats” guide. Explain when to use a project chat instead of a ticket chat, how to reopen durable chats, read the venue/rail, and return to the Board. |
| P1 | **Chat workflow and controls** | `chat-plane.tsx`, `new-session-control.tsx`, model settings, interaction UI, title logic, and command registry are current public UI. | A guide/reference for chat creation, model/effort selection, chat titles/history, model questions and recovery, interruption/retry behavior, slash commands, skills, and the explicit Terminal option. |
| P1 | **Files, attachments, and worktree-aware editing** | `ticket-detail.tsx`, `home-files-panel.tsx`, attachment components, and `external-app-menu.tsx`. | Explain Project Files vs Ticket Files, main checkout vs worktree resolution, preview/pinned tabs, saving/conflict behavior, file attachments and `@` references, diffs, and opening a file in an external editor. |
| P1 | **Review and delivery workflow** | `ticket-repository-summary.tsx`, change/diff components, worktree-done-flow models. | Explain Change Sets, branch/base, commit/push/create or view PR actions, review state, archive/cleanup, and what Volli does not verify automatically. Do not use static “tests passed” language as a product guarantee. |
| P1 | **Model Access and Web search** | `model-access-settings.tsx` has purpose-specific defaults, utility work, compaction, visibility, and accounts. `web-access-settings.tsx` supports Off/Brave/Exa/SearXNG and write-only keys. | Split the current large Settings page into task-focused pages: choose/recover a model; control compaction and model visibility; set up web search; configure a terminal harness; configure worktrees. Include privacy and billing boundaries. |
| P1 | **Environment health and CLI recovery** | Recent code adds `volli identify` environment reporting, Doctor remediation, session-path comparison, and Session environment alerts. | Document the environment report, PATH requirements, `volli doctor`/`--fix`, what differs between a terminal opened by Volli and an ordinary shell, and the recovery path. |
| P1 | **Alpha support and limitations** | There is no public alpha guide or support page. | Publish known limitations, supported platform, release/update policy, privacy/security boundaries, expected feedback, bug-report template, and how to return to a previous build if supported. |

### Page-by-page corrections

| Source page | Finding | Required update |
| --- | --- | --- |
| `index.mdx` | It opens with the old board/Sessions framing and has no Home/project-chat entry point. | Reframe around the current journey and add cards for Home/project chats, chat workflow, files, Model Access, and alpha support. |
| `start/install.mdx` | The source is much closer to current behavior than production, but its signed/notarized and update claims must be verified against the actual alpha artifact. It lacks alpha status, architecture clarity, first-run screenshots, and recovery/uninstall. | Make it the authoritative install contract and keep it synchronized with the download page, README, release notes, and Security policy. |
| `start/quickstart.mdx` | It names `New chat`, but does not orient the reader to Home, project chat vs ticket chat, or the real initial UI. | Rewrite as the tested end-to-end tutorial above and capture the current product rather than describing the former Sessions page. |
| `start/concepts.mdx` | It omits Home, chat-first behavior, skills, attachments, Web Access, current file surfaces, and the relationship between the Board and project chats. | Expand the glossary only with terms a user needs; link detailed procedures instead of making Concepts a second reference manual. |
| `guides/board.mdx` | Its broad board rules align better with current source than the live page, but the screenshot is from the former navigation and it overburdens a first read with retention/PR internals. | Recapture the board; separate everyday board use from archive/retention/reference behavior; verify every context-menu label against the release build. |
| `guides/ticket-workspace.mdx` | It is text-only and does not cover current chat-first tabs, attachments, file save/external-edit behavior, or a complete review flow. | Split/expand into Ticket Body, ticket chats, files/diffs, and review/branch workflow pages with current screenshots. |
| `guides/agents-and-worktrees.mdx` | It explains the conceptual split well but lacks task-oriented project-chat, terminal-companion, and worktree lifecycle guidance. | Rename and restructure around Sessions and worktrees; link to separate chat and terminal guides. |
| `guides/settings.mdx` | It tries to be an exhaustive reference for seven Settings categories and Configure in one page. It will drift quickly and is hard to use during setup. | Break it into focused pages, with the navigation updated in `apps/docs/astro.config.mjs`. |
| `guides/theming.mdx` | It contains an explicit TODO for the missing canvas-editor screenshot and makes detailed UI claims that need release-build verification. | Capture the current light/dark/system and project-override UI; remove any behavior that cannot be verified. |
| `reference/cli.mdx` | Its checked-out source is close to current `volli help`, while the deployed page is old. Manual command tables will drift again. | Deploy it now; add a repeatable generation/contract check against `volli help`, especially for new session and environment commands. |
| `reference/keyboard-shortcuts.mdx` | It needs a direct source/test pass before launch because Home, chat tabs, files, and terminal focus changed recently. | Verify each shortcut against the release build and keep only shortcuts users can actually discover/use. |
| `reference/troubleshooting.mdx` | It lacks the alpha-specific install, model sign-in, Home/chat, release/update, and support paths. | Organize by user symptom and link each recovery action to the relevant current UI. |

### Docs visuals and generated plain text

- `apps/docs/src/assets/screenshots/board.png` and
  `ticket-workspace.png` show the old board/Sessions-era navigation. Current
  code calls the primary surface **Home** and no longer has a standalone
  Sessions navigation item. `ticket-workspace.png` is currently unreferenced;
  either retire it or use a newly captured version in the expanded ticket
  workspace guide.
- The README hero (`docs/assets/volli-code-ticket-session.webp`) also shows
  the old Board/Sessions navigation. Replace or remove it with a deliberately
  current capture.
- The two PNG screenshots are 2880×1800 (~600 KB each). Re-export responsive,
  compressed images and retain accurate alt text.
- `llms.txt` is useful, but its live copy carries the old product story. Treat
  it as a launch artifact: regenerate/check it in the same deploy and verify
  its URLs and descriptions after publication.

## 3. Interactive product demo

`apps/website/src/components/VolliDemo.tsx` is polished as an interaction
exercise, but it currently teaches an obsolete product surface.

| Priority | Finding | Evidence | Required update |
| --- | --- | --- | --- |
| P0 | The demo navigation says **Board / Sessions / Files / Settings**. | `VolliDemo.tsx`; current `sidebar/nav-list.tsx` is **Home / Files / Configure**, with Settings in the footer and chats as Home tabs. | Redesign the demo around the released Home/ticket workspace hierarchy. Do not show a separate Sessions page. |
| P0 | The demo presents a terminal-looking “Pi Session” as the primary execution experience. | `TerminalPreview`/`SessionScreen`; current `NewSessionControl` defaults its main press to **Chat**, with Terminal under the menu. | Show the default structured chat, model/effort/interaction state, and a clearly optional terminal companion. |
| P0 | The terminal demo combines Pi wording with Claude-styled class names/glyph treatment and hard-coded historical ticket names. | `VolliDemo.tsx` uses `is-claude` / Claude bullets while labeling Pi. | Remove brand ambiguity and replace historical/internal-looking tickets with a current, plausible alpha workflow. |
| P1 | The demo claims outcomes such as “Tests passed,” “Change Set inspected,” and “Waiting for review” as static facts. | `DonePreview` and `SessionScreen`. | Show evidence as user-visible review data or label it as an example. Do not imply Volli independently certifies implementation success. |
| P1 | The project/nav rail buttons are focusable `<button>` elements with no action handlers. | `DemoRailButton` and `DemoNavButton`. | Make decorative controls non-interactive/hidden from the tab order, or make each work. Preserve a keyboard-complete ticket/demo flow. |
| P1 | The demo appears before the actual product explanation and consumes initial JS for React and GSAP. | `index.astro` uses `<VolliDemo client:load />`; `VolliDemo.tsx` imports GSAP/Flip. | Make a current static screenshot/visual the baseline; progressively enhance only the interaction that helps conversion. Measure the shipped bundle and LCP before retaining a heavy above-the-fold island. |
| P1 | Mobile users see a horizontally scrollable five-column demo but the prompt only tells them to drag/open tickets. | `VolliDemo.css` sets a 920px minimum board width below 720px. | Give an explicit mobile affordance/instruction or use a smaller guided state. Test touch, keyboard, reduced motion, and zoom. |
| P1 | The demo is a bespoke dark desktop visual rather than a reliable representation of the current, theme-capable app. | Desktop supports generated light/dark/system appearance; demo hard-codes its own palette. | Either keep it honestly labeled as an illustrative workflow or update it from current screenshots/components. It must not masquerade as a current pixel-accurate product capture. |
| P2 | There is no visible completion path inside the demo. | The CTA lives later in the statement section. | Add a single outcome-oriented CTA adjacent to the demo: download/request alpha access or read the quickstart. |

## 4. Stale public repository material and release hygiene

| Priority | Finding | Evidence | Required action |
| --- | --- | --- | --- |
| P0 | README says “does not have a packaged release yet.” | `README.md`; public GitHub Releases lists canaries. | Replace with the agreed alpha/download language and current screenshot. |
| P0 | Security policy says there is no packaged release and supports only `main`. | `SECURITY.md`. | State which alpha versions/builds receive fixes, where to report vulnerabilities, and the policy for prerelease users. Keep claims modest if no SLA exists. |
| P1 | Public GitHub repository metadata still describes “OSS planning & terminal-agent execution.” | Public GitHub repository page title/description. | Update repository description, topics, social preview, and pinned links manually in GitHub settings to the chat-first Pi-backed product. |
| P1 | Release notes are internal merge/commit text, not an alpha release communication. | Public `v0.1.0-canary.9` release page. | Publish user-facing alpha notes: what changed, supported platform, known limitations, installation/update steps, feedback path, and checks/signing status that were actually performed. |
| P1 | `release.yml` retains a public “dogfooding-solo policy” comment that conflicts with a semi-public alpha. | `.github/workflows/release.yml`. | Update the release-policy comments and operational checklist once the alpha policy is decided. Keep secret names out of public docs; the workflow itself can remain technical. |
| P1 | `docs/ai-architecture-now.html` is a standalone, styled “now” page that says the authority gate is inactive and execution is ungated/unsandboxed. | `docs/ai-architecture-now.html`. | Decide deliberately whether this is public transparency or internal architecture material. If internal, move/remove it from the public repository; if public, add an owner, date, scope, and current security wording. Do not leave a permanently stale “now” page. |
| P1 | Public plans/research and agent guidance include future architecture and internal operating detail. | `docs/plans/*`, `docs/research/*`, `AGENTS.md`, `CONTEXT.md`. | Audit these as a separate disclosure decision. They are valuable to contributors, but should not be mistaken for shipped product documentation or silently advertise unreleased features. |
| P1 | The README’s hero visual is obsolete relative to Home/chat-first navigation. | `README.md` → `docs/assets/volli-code-ticket-session.webp`; current nav source. | Replace it with an approved alpha capture and alt text that describes the actual released UI. |
| P2 | `CONTRIBUTING.md` does not tell contributors how to validate the public website/docs change they are making. | `CONTRIBUTING.md`; public builds live in `apps/website` and `apps/docs`. | Add the scoped site build/link/a11y checks once the toolchain is available. |

## Launch phases

Keep the work to three gated phases. Do not deploy a prettier source tree while
production, binary, and documentation still describe different products.

### Phase 1 — establish one alpha truth and ship it

**Deliverable:** one release/version/channel statement and production routes
that lead to that exact artifact.

1. Decide alpha name, architecture, version, support/feedback path, known
   limitations, and whether Stable exists.
2. Update the website Download messaging, source docs install messaging,
   README, Security policy, GitHub metadata, and release notes together.
3. Cut and manually install-test the exact release artifact.
4. Deploy website and docs; invalidate/verify Pages routes.

**Completion check:** root, `/download/`, docs install/quickstart, README,
GitHub release, and installed app all agree on the same version and alpha
contract.

### Phase 2 — tell and show the current product

**Deliverable:** an above-the-fold landing page and demo that accurately show
Home, chat-first Sessions, ticket worktrees, and review.

1. Replace the old terminal-first, Sessions-nav demo with a current guided
   workflow or current capture.
2. Add primary navigation, Docs/support routes, alpha disclosure, and an
   accessible conversion path.
3. Recapture README and docs visuals from the release candidate.
4. Add social preview assets and optimize the icon/image payloads.

**Completion check:** a first-time macOS developer can identify the product,
what is local, what is optional, whether their Mac is supported, and the next
safe action without reading internal architecture vocabulary.

### Phase 3 — publish the usable docs set and verify it

**Deliverable:** a task-based docs IA with a verified quickstart and all
alpha-critical reference material.

1. Publish the Home/project-chat, chat controls, files/attachments, review,
   Model Access/Web, environment recovery, and alpha support pages.
2. Split the overgrown Settings reference into task-focused guides and keep
   Concepts/glossary terminology consistent with `CONTEXT.md`.
3. Regenerate `llms.txt`; check navigation, links, images, mobile rendering,
   keyboard paths, focus, contrast, and reduced motion.
4. Run the website/docs builds and link/a11y checks in an environment with the
   required Node/pnpm toolchain.

**Completion check:** a clean-machine tester can complete the documented
quickstart, every public CTA resolves, and the build/link/a11y gates pass.

## Launch acceptance checklist

- [ ] A current signed/notarized alpha artifact is publicly available and its
      version is named consistently everywhere.
- [ ] `https://volli.app/download/` is a real download page, not the homepage.
- [ ] Live docs are deployed from the reviewed current source and `llms.txt`
      is regenerated.
- [ ] The landing page accurately describes Home, chat-first structured
      Sessions, isolated ticket worktrees, and optional terminals.
- [ ] Every screenshot/demo comes from the release candidate and has accurate
      alt text or an honest illustrative label.
- [ ] README, Security policy, GitHub description, release notes, and website
      make the same alpha/stability claim.
- [ ] Installation, privacy/local-data, model/provider, support, known
      limitation, and security-reporting paths are discoverable.
- [ ] Website/docs builds, links, responsive sizes, keyboard navigation,
      focus states, contrast, and reduced-motion behavior are checked on the
      deployed artifacts.
