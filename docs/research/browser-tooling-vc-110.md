# Browser tooling for Volli (VC-110)

**Status:** research record; adopted with the settled amendments below. Where a
recommendation later in this memo conflicts with this list, this list and the
implementation control:

- the control path is a native `webContents.debugger` controller speaking the
  Playwright-MCP snapshot/ref dialect as a format spec (no vendored code, second
  browser, or remote debugging port);
- visible Browser Tabs ship in both Home and Ticket workspaces;
- user-created tabs use a persistent browser-only profile and may browse public
  HTTP(S); Session-created tabs use credentialless per-Ticket or per-Project partitions;
- a Session receives full inspect/interact capability over visible user tabs and
  agent tabs in its own narrowest scope (Ticket, otherwise Project) in this slice.
  Explicit references, per-tab grants, and takeover UI are downstream rather
  than prerequisites here;
- **Playwright (npm) replaces `agent-browser` as the leading Phase 4 QA-runner
  candidate** — the latter's CLI/daemon advantages do not survive an in-process
  host.

See the VC-110 decision comment and `apps/desktop/src/main/browser/` for the
implemented product shape.
**Research date:** 2026-08-24
**Question:** Can Volli offer a user-visible, sandboxed browser that its Agent
Runtime can use for previewing, testing, artifacts, and chat references—and is
Vercel's `agent-browser` the right implementation substrate?

## Decision

Build the **interactive Browser Tab** product natively on Electron
`WebContentsView`, controlled by a product-owned Electron-main service. Do
**not** make `agent-browser` the implementation behind the tab a person sees.

`agent-browser` is nevertheless a strong candidate for a later, **separate
agent-owned QA runner**. It offers an unusually useful set of browser
observability and validation operations—accessibility-tree refs, screenshots,
console/errors, network/HAR, traces, React inspection, Web Vitals, axe audits,
and visual/semantic diffs. Bundle it only after a focused packaging and
security spike, behind a typed Volli tool rather than by placing its unrestricted
CLI on the endorsed Agent Tool Surface.

In short:

| Question | Answer |
| --- | --- |
| Can Volli redistribute `agent-browser`? | **Likely yes.** The inspected `v0.34.0` source is Apache-2.0. Preserve its license/attribution and audit the exact binary's transitive notices before shipping. |
| Can it be bundled as a macOS sidecar? | **Technically yes, with deliberate packaging.** Volli currently ships arm64 macOS only, and the package publishes a Darwin arm64 native binary. It must be pinned, checksum-verified, copied outside `asar`, code-signed/notarized with the app, and launched from a controlled environment. |
| Should it drive the same tab rendered inside Volli? | **No, not as the primary design.** It is a Rust CLI plus daemon that launches a separate Chrome or attaches to a CDP endpoint. Electron already exposes the owned `webContents` and debugger directly; adding an external CDP server and a second browser weakens lifecycle, isolation, and audit ownership. |
| Should an agent receive raw `agent-browser` shell access? | **No.** Its defaults are unrestricted, its config/flags can enable profiles, plugins, uploads, downloads, `eval`, storage, proxies, and arbitrary CDP attachment. A product tool must expose a smaller, typed policy surface. |

## What Volli has today

The current checkout contains no `BrowserView`, `WebContentsView`, `<webview>`,
remote-debugging-port, or `webContents.debugger` implementation. The desktop
shell currently has one app `BrowserWindow`; it correctly uses a sandboxed,
context-isolated, Node-disabled renderer and rejects navigation away from
Volli's own renderer origin. (`apps/desktop/src/main/index.ts`.)

That is a good starting posture, but it is not yet a browser workspace.
Electron 43.4.0 is already bundled by `apps/desktop/package.json`, so it brings
Chromium and Electron's main-process `WebContentsView`, `Session`, and
`webContents.debugger` APIs with it. A separate Chromium is not required for a
visible preview tab.

The existing Web Access implementation is also a useful architectural
precedent, not a browser implementation:

- `web_fetch` and `web_search` are optional **Agent Tool Surface** ports. The
  Session is not offered either tool when the port is absent.
- `SafeWebFetch` deliberately allows only public HTTP(S) targets, has bounded
  output, and wraps page text as untrusted content. It must not silently become
  a JS-rendering browser or a credential-bearing browser profile.
- The Session's tool list is recorded before attachment and must match on
  recovery. A new browser capability needs the same frozen-surface treatment;
  a live tab grant must not mutate the provider tool array mid-Session.

There is an important limit on any near-term promise: the current Pi execution
path has no active authority gate or OS shell sandbox. A sandboxed remote page
can be kept away from Electron/Node privileges, but a product browser tool
cannot by itself prevent an ungated Session from using its ordinary shell tool
for unrelated local actions. Browser grants should therefore be presented as
an auditable product capability, not as complete containment, until the
planned authority boundary exists.

## Competitor and adjacent-tool findings

| Product / tool | Publicly evidenced shape | Lesson for Volli |
| --- | --- | --- |
| **Replit Preview** | A live in-workspace app view with address/navigation controls, responsive presets, and developer tools for console, DOM, network, and storage. | A preview is more valuable when it is a first-class work surface rather than an external-browser escape hatch. Console and network evidence belong beside the app view. |
| **Replit App Testing** | Agent uses a real browser to click through an app; the user can watch the cursor, take over for login/CAPTCHA, and review an interactive replay. | Agent browser work needs visible progress, human takeover, and replayable evidence—not merely a final “tested” assertion. |
| **Chrome DevTools MCP** | Lets coding agents control a live Chrome and inspect screenshots, DOM snapshots, console, network, traces, and performance. Its documentation explicitly warns that an authenticated browser lets an agent act as the user. | Live-browser debugging is now a baseline expectation. The decisive product question is not whether control is useful; it is which profile, tabs, permissions, and data an agent is allowed to use. |
| **Microsoft Webwright** | Treats browser work as code: the agent writes/reruns Playwright scripts and keeps screenshots/logs/trajectories as the durable result. | Make browser testing leave reviewable, rerunnable evidence. An opaque click trajectory should not be the only artifact of a QA claim. |
| **Vercel `agent-browser`** | A compact native CLI with a daemon-held browser session, accessibility refs, browser interaction, diagnostics, testing/audit commands, and opt-in policy controls. | It is a high-leverage automation engine, but it is an automation sidecar—not a product data model, visible-tab host, grant system, or Electron isolation boundary. |

The strongest shared pattern is a three-part loop:

```text
run the local app → observe the same rendered state → preserve evidence / let a human intervene
```

Volli can differentiate by making the rendered state a **Browser Tab** that is
owned by its Ticket workspace and referenceable from a Session, rather than a
separate browser window, an opaque cloud VM, or a tool-specific transcript.

## `agent-browser` assessment

### Version and distribution examined

The review was pinned to [`v0.34.0`](https://github.com/vercel-labs/agent-browser/tree/v0.34.0)
(commit `548b159b30eef119ccf6846c8bc807d0eaa3f6f8` from `git ls-remote` on
2026-08-24). The repository's moving `main` was at
`021d9255e543d2f1ab66b87f338d85c3d7a910be` when checked; do not use that as a
shipping dependency reference.

At that tag:

- The package is a Node launcher around a native Rust executable; the Rust
  crate and package declare Apache-2.0.
- `postinstall` downloads a platform-specific binary from the corresponding
  GitHub release. That is convenient for an individual CLI install, but is not
  an acceptable implicit production-build supply chain for Volli.
- It needs a Chrome-family browser. It discovers an installed browser or asks
  the user to run `agent-browser install` to download Chrome for Testing.
- Its daemon preserves state across short CLI invocations using local socket,
  PID, and config files. Its default location is under `~/.agent-browser` when
  no runtime directory is supplied.
- The package includes axe-core license files; a release integration must audit
  and include every required notice from the exact release, not only the top
  level Apache license.

### What is especially useful

The interaction model is suited to an LLM without requiring it to reason over
raw pixels on every step:

```text
snapshot → accessibility-tree refs such as @e2 → click/fill/get → fresh snapshot
```

It also has product-relevant commands that are expensive to recreate early:

- navigation, tabs, frames, dialogs, form/input interaction, waits, screenshots
  and PDFs;
- semantic locators and accessibility snapshots;
- console messages, page errors, network request inspection/HAR, profiling,
  traces, screenshot/snapshot diffs;
- React tree/inspection/render profiling, Web Vitals, and embedded axe-core
  accessibility audits;
- stable tab handles and an explicit `--pin-tab` mode for avoiding accidental
  cross-session actions in a shared CDP browser.

Those are excellent inputs to a later QA runner. They are not all appropriate
Agent Tool Surface operations: `eval`, uploads/downloads, cookies/storage,
clipboard, profile loading, plugins, proxy configuration, and arbitrary CDP
attachment are materially more consequential than taking a screenshot.

### Security and integration constraints

`agent-browser` has meaningful safeguards, but they are opt-in. Its own
security documentation says the default permits unrestricted navigation,
actions, and output. It supports output boundaries/length limits, domain
allowlists, action policies, and confirmations; those controls should inform
Volli's design, not replace it.

Specific constraints found during review:

1. **It is a second browser process by default.** It launches Chrome with a
   temporary user-data directory and a CDP listener, or it attaches to an
   existing CDP endpoint. Its headed Chrome window is not an Electron
   `WebContentsView` inside Volli's layout.
2. **CDP is powerful, not an app-private API.** An upstream issue documents that
   a locally launched Chrome currently uses an unauthenticated loopback CDP
   port; controlling that endpoint means controlling the browser. Treat an
   exposed debugging port as a sensitive capability, not as an internal bridge.
3. **Electron compatibility needs a real spike.** The current documentation
   advertises Electron as a CDP use case and a recent pull request addresses
   Electron webview support. Historical upstream issues show `file:`/blank-page
   filtering and webview handling have been integration trouble spots. This
   research did not run a Volli/Electron compatibility test, so it must not be
   assumed that every `agent-browser` command works against a `WebContentsView`.
4. **An attached user profile and a restricted agent context conflict.** The
   tool's own domain allowlist refuses profile/restore/CDP attach modes because
   it cannot enforce containment before pre-existing pages run. That is the
   correct tension: a user's signed-in research tab is not equivalent to a
   fresh, credentialless dev-test tab.
5. **Global discovery is unsafe by default for a product host.** User/project
   `agent-browser.json`, environment variables, plugin executables, socket
   locations, profiles, and browser choice all influence the CLI. A Volli
   integration must supply an explicit config/environment and never inherit an
   arbitrary project configuration.
6. **Its `read` path must not replace `SafeWebFetch`.** `agent-browser read`
   can fetch or extract active-page content, potentially with browser auth
   state. Public web retrieval remains governed by Volli's existing
   main-process fetch policy; browser-tab inspection is a different,
   explicit-grant capability.

### Feasible later sidecar contract

If the spike succeeds, Volli can launch the pinned binary as a child process
from Electron main—not through a Session's `execute` tool—with all of the
following owned by Volli:

```text
Volli Browser QA port
  → fixed absolute sidecar path in app resources
  → per-run 0700 state/socket/profile directory below Electron userData
  → scrubbed environment + explicit generated configuration
  → fresh, credentialless Chrome profile
  → strict target/origin policy and action allowlist
  → bounded JSON result parsing
  → screenshots / traces / audit summaries materialized for review
  → lifecycle cleanup when the run or app exits
```

Do not put the executable on the agent `PATH`, let the model choose
`--cdp`/`--profile`/`--plugin` flags, or reuse `~/.agent-browser`. A typed port
should expose only the operations Volli has decided to support and translate
results into product-owned observations and reviewable outputs.

## Recommended native Browser Tab architecture

### Ownership boundary

```text
Renderer Browser workspace
  └─ typed preload IPC: user intent + measured host rectangle only
       ↓
Electron-main BrowserTabHost
  ├─ BrowserTab registry / durable metadata
  ├─ WebContentsView per live tab, attached to the main window
  ├─ isolated Electron Session partitions and permission policy
  ├─ navigation/popup/download lifecycle
  ├─ webContents.debugger-based inspector/controller
  └─ Browser Agent Tool port
       ↓
@volli/agent-runtime (Electron-free)
  └─ small, typed Browser Tool Surface
```

`WebContentsView` is the right native surface: it displays an owned
`webContents`, can be placed by Electron main, and can be controlled through
that `webContents` without opening a remote debugging server. The renderer
should never load an arbitrary URL into its own app webContents and should
never receive Electron privileges from a remote page.

A renderer `ResizeObserver` can report the browser plane's pixel rectangle over
typed IPC; main sets the child view's bounds and hides/detaches it when its
Ticket tab is not active. This is analogous to the existing resident-terminal
layout: React owns the workbench chrome and intent, while main owns the native
surface's lifetime.

### Proposed modes

One shared browser profile would conflate the most dangerous cases. Start with
explicit modes instead:

| Mode | Profile/storage | Agent access | Intended use |
| --- | --- | --- | --- |
| **Personal Browser Tab** | Persistent, isolated from Volli's app renderer and from QA profiles | None until the person explicitly references/grants that tab; observing or controlling it is separately visible | Reading docs, research, a user completing an auth step |
| **Dev Preview Tab** | Per-project or per-ticket credentialless partition | Limited inspection and low-risk interaction on the registered local dev origin | See the app a Ticket is changing, reproduce UI bugs, validate a flow |
| **QA Run** | Fresh ephemeral profile | Agent-owned through a restricted tool/sidecar; no personal cookies | Repeatable screenshot/a11y/flow/performance checks with outputs |

The first version does not need persistent personal browsing. A Dev Preview Tab
is the high-value, lower-risk beginning because it solves the ticket's stated
“see the app live” loop without exposing a signed-in browsing profile.

### Browser Tab identity and chat reference

A tab should have a product-owned opaque id and explicit ownership/provenance,
not be inferred from a positional Chromium tab index. A future record might
contain only bounded metadata such as:

```text
BrowserTab
  id, projectId, ticketId?, mode
  createdBy: user | session
  currentUrl (redacted when displayed in history where necessary), title
  partition key, live generation, createdAt, updatedAt

BrowserGrant
  tabId, sessionId, capability: inspect | interact
  grantedBy: user | agent-created-dev-tab
  grantedAt, revokedAt?
```

When someone references a tab in chat, create a **Browser Tab reference** that
names the stable tab and an observed generation/snapshot. It must not silently
grant the Session access to every tab or every future navigation. The runtime
should reject an action if the tab disappeared, changed ownership/mode, or no
longer has the reference's grant.

Do not inject a full live DOM, cookies, browsing history, or network bodies
into a Runtime Brief. Fetch a bounded, fresh observation only when the Session
uses the granted tab. Every page-derived string—accessibility snapshot, visible
text, console message, DOM detail, network error, and OCR-equivalent
screenshot description—is untrusted third-party content and needs the same
provenance envelope and output budget that `web_fetch` already uses.

### Tool design

Add a small optional Browser port beside `webFetch`/`webSearch`; do not expose
50+ third-party subcommands directly. Its presence belongs in the frozen Session
Agent Tool Surface, while a tab reference/grant is checked per call.

A plausible first split is:

1. **`browser.inspect`** — list only accessible tabs; return bounded URL/title,
   accessibility snapshot, screenshot reference, and console/error summary.
2. **`browser.interact`** — a narrow semantic action (`navigate`, `click`,
   `fill`, `press`, `select`, `wait`) against a granted dev tab. Require a
   current snapshot/ref token so stale selectors fail rather than act on a new
   page.
3. **`browser.capture`** — take a screenshot or a bounded diagnostic report and
   materialize it for human review.
4. **Later QA-only operations** — axe audit, network summary, screenshot diff,
   trace, and Web Vitals; these map well to `agent-browser` but do not belong in
   the first interactive-tab slice.

Do not initially offer raw JavaScript evaluation, arbitrary headers, proxy
changes, arbitrary CDP connections, uploads, downloads, clipboard read/write,
cookie/storage export/import, browser extensions, WebAuthn, or browser
permission grants. Those need a separate authority and audit design.

### Security baseline

For every remote Browser Tab, use a separate Electron session/partition and at
least:

- `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`, and no
  general-purpose preload bridge;
- no reuse of the app renderer's default session, cookies, storage, or IPC;
- default-deny permission request/check handlers; downloads blocked until a
  deliberate product flow exists;
- `file:`, `javascript:`, untrusted custom schemes, and uncontrolled popups
  denied; `window.open` becomes a managed Browser Tab or is refused, never an
  unreviewed `shell.openExternal` call;
- explicit navigation policy by mode. Local development needs a deliberately
  registered `localhost`/loopback origin; it cannot use the public-only
  `SafeWebFetch` policy unchanged;
- a stable, bounded audit record for tool action, target tab, policy outcome,
  elapsed time, and output digest—not secrets, cookie values, full request
  bodies, or unbounded DOM content.

Electron's own security guidance supports this direction: remote content must
not have Node integration, should use context isolation and sandboxing, and
sessions that load remote content need explicit permission, navigation, and
window-creation handling.

## Delivery sequence

### Phase 0 — native-surface spike

Build a small internal proof before any product UI commitment:

1. Create/destroy several `WebContentsView` instances under the main window;
   measure renderer-reported bounds, tab switching, resize, fullscreen, and
   window recreation.
2. Use `webContents.debugger` to obtain a title, accessibility snapshot,
   screenshot, console error, and simple click in a local fixture—without
   enabling `--remote-debugging-port`.
3. Prove isolation with tests: remote page has no `window.api`/Node access,
   default app cookies do not appear, permissions/downloads/popups are denied,
   and a destroyed tab cannot receive an action.
4. Prove a registered local dev origin works while an arbitrary loopback/private
   target does not become agent-accessible by accident.

**Exit criterion:** Electron can host and inspect the visible tab securely enough
for a Dev Preview; otherwise stop and reassess the view host before adding chat
or agent control.

### Phase 1 — visible Dev Preview

Add a Ticket workspace Browser Tab that can open a local app, show loading/error
state, expose back/forward/reload/device size, and keep the native view resident
while the Ticket is open. No personal profile and no agent interactions yet.

**Exit criterion:** a human can run their workspace app and review it in the
Ticket workspace without external browser setup.

### Phase 2 — inspect and evidence

Give Ticket Sessions a browser-inspect port for agent-created Dev Preview Tabs:
bounded screenshot/accessibility snapshot/console errors, with untrusted
provenance. Render the resulting capture and action summary visibly in the
Session/Ticket workspace.

**Exit criterion:** the agent can substantiate “I checked the UI” with a
reviewable capture and diagnostic receipt.

### Phase 3 — explicit user references and interaction

Add `@`-style Browser Tab references, per-Session grants, takeover/approval
surfaces, and narrow semantic interaction. Keep personal authenticated tabs
opt-in and visually differentiated from agent-owned Dev Preview Tabs.

**Exit criterion:** a person can point to one tab and see exactly what the
Session may inspect or change, without giving it ambient browsing access.

### Phase 4 — evaluate `agent-browser` as QA sidecar

Only now run a pinned integration spike against a fixture and a real local
Volli project:

- package the `v0.34.0` Darwin arm64 executable from a verified artifact;
  verify its checksum before packaging; do not rely on npm `postinstall` at
  build or runtime;
- copy it outside `asar`, verify hardened-runtime code signing and notarized-app
  behavior, and add a release test for its executable path;
- choose a Chrome strategy explicitly. Do not automatically ship/download
  Chrome for Testing until its size, update, notarization, and distribution
  terms are reviewed; an opt-in component or a detected system Chrome is a
  separate product decision;
- scrub the child environment and set private `AGENT_BROWSER_SOCKET_DIR`,
  namespace, config, profile, output directory, and lifecycle ownership under
  Volli's user-data directory;
- prove a fresh profile cannot use user cookies, project configuration, plugins,
  or an arbitrary CDP endpoint; prove child/Chrome cleanup on Session abort and
  app quit;
- exercise snapshots, screenshots, console/errors, a11y, screenshot diff, and
  one local dev flow; record performance and failure behavior;
- do **not** make a direct `WebContentsView` CDP attachment a dependency of
  this phase. Treat it as an optional compatibility experiment, not the
  architecture.

**Adoption criterion:** use the sidecar only if the tests show it supplies
meaningful QA capability beyond the native controller without weakening the
interactive Browser Tab's security or lifecycle model.

## Sources

### Volli source reviewed

- [`apps/desktop/src/main/index.ts`](../../apps/desktop/src/main/index.ts) —
  current `BrowserWindow` security/lifecycle and renderer navigation policy.
- [`apps/desktop/electron-builder.yml`](../../apps/desktop/electron-builder.yml)
  and [`build/entitlements.mac.plist`](../../apps/desktop/build/entitlements.mac.plist)
  — existing asar, signing, hardened-runtime, and notarization posture.
- [`packages/shared/src/agent-runtime.ts`](../../packages/shared/src/agent-runtime.ts),
  [`packages/agent-runtime/src/pi/tools.ts`](../../packages/agent-runtime/src/pi/tools.ts),
  and [`apps/desktop/src/main/session-runtime/pi-adapter.ts`](../../apps/desktop/src/main/session-runtime/pi-adapter.ts)
  — optional ports, tool-surface freeze, and runtime binding.
- [`docs/research/web-fetch-main-process-safety.md`](web-fetch-main-process-safety.md)
  — existing public-web and untrusted-content boundary.

### External primary sources

- Vercel, [`agent-browser` README](https://raw.githubusercontent.com/vercel-labs/agent-browser/v0.34.0/README.md),
  [`package.json`](https://raw.githubusercontent.com/vercel-labs/agent-browser/v0.34.0/package.json),
  [`LICENSE`](https://raw.githubusercontent.com/vercel-labs/agent-browser/v0.34.0/LICENSE),
  [security documentation](https://raw.githubusercontent.com/vercel-labs/agent-browser/main/docs/src/app/security/page.mdx),
  and [CDP mode documentation](https://raw.githubusercontent.com/vercel-labs/agent-browser/main/docs/src/app/cdp-mode/page.mdx).
- Vercel, [`postinstall.js`](https://raw.githubusercontent.com/vercel-labs/agent-browser/main/scripts/postinstall.js)
  and [`connection.rs`](https://raw.githubusercontent.com/vercel-labs/agent-browser/main/cli/src/connection.rs)
  — native binary download and daemon/socket behavior.
- Vercel upstream issue reports: [Electron/CDP #187](https://github.com/vercel-labs/agent-browser/issues/187),
  [Electron webview #580](https://github.com/vercel-labs/agent-browser/issues/580),
  [webview support PR #671](https://github.com/vercel-labs/agent-browser/pull/671),
  and [loopback CDP concern #1592](https://github.com/vercel-labs/agent-browser/issues/1592).
  These are compatibility/security signals to validate, not proof of current
  upstream behavior.
- Electron, [`WebContentsView`](https://raw.githubusercontent.com/electron/electron/v43.4.1/docs/api/web-contents-view.md),
  [`webContents`](https://raw.githubusercontent.com/electron/electron/v43.4.1/docs/api/web-contents.md),
  [`Session`](https://raw.githubusercontent.com/electron/electron/v43.4.1/docs/api/session.md),
  [`WebPreferences`](https://raw.githubusercontent.com/electron/electron/v43.4.1/docs/api/structures/web-preferences.md),
  and [security guidance](https://raw.githubusercontent.com/electron/electron/v43.4.1/docs/tutorial/security.md).
- Replit, [Preview](https://docs.replit.com/features/editor/preview) and
  [App Testing](https://docs.replit.com/features/agent/app-testing).
- Google, [Chrome DevTools for agents](https://developer.chrome.com/docs/devtools/agents/get-started)
  and [`chrome-devtools-mcp`](https://github.com/ChromeDevTools/chrome-devtools-mcp).
- Microsoft, [`Webwright`](https://github.com/microsoft/Webwright).
- Electron Builder, [macOS notarization](https://www.electron.build/docs/features/code-signing/notarization/),
  and Electron, [code signing](https://raw.githubusercontent.com/electron/electron/v43.4.1/docs/tutorial/code-signing.md).
