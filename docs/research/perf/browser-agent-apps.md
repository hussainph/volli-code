# How other agent applications implement the human + agent browser

**Status:** research record for the Browser Tabs product (follow-up to `docs/research/browser-tooling-vc-110.md`, which covered Replit, Chrome DevTools MCP, Webwright, and `agent-browser` — none of that is repeated here).
**Research date:** 2026-09-13
**Question:** What do other AI/agent applications do for an embedded browser that both a human and an agent drive, and what is Volli's Browser Tabs product missing?
**Method:** primary sources only (product docs, repos, engineering blogs, official announcements), read with `web_fetch`. Closed products (Dia, Comet, Atlas agent internals) are reasoned from documentation, demos, and one independent instrumentation study, and are marked as such. Fetch failures are recorded in Sources rather than silently dropped.

Volli baseline assumed throughout (all verified in-tree on 2026-09-13):
`apps/desktop/src/main/browser/tab-host.ts` (registry, holds, partitions),
`cdp-controller.ts` (CDP over `webContents.debugger`, generation-gated refs),
`agent-port.ts` (scope + hold policy), `snapshot-format.ts` (Playwright-MCP-dialect
AX printer), `cursor-overlay.ts` (session cursor), `hold-notices.ts` (in-band takeover
steers), `picture-store.ts`, `packages/agent-runtime/src/pi/browser-tools.ts`
(8 tools: tabs / navigate / snapshot / act / screenshot / console / acquire / release),
plus Tickets VC-253 (offscreen-rendering spike), VC-267 (hold follow-ups), VC-277
(no-op clicks / empty snapshots / screenshot timeouts).

## 1. Comparison table

| Product | Representation the agent reads | Act loop | Human/agent co-driving | Isolation & identity | Notable features Volli lacks |
|---|---|---|---|---|---|
| **OpenAI Operator / ChatGPT agent** (cloud VM browser; now "agent mode") | Screenshots only ("see"), no DOM: CUA drives mouse+keyboard. ChatGPT agent adds a separate *text-based* browser for reasoning-heavy reads. | Visual grounding; self-corrects by reasoning; asks confirmation before consequential actions. | User can interrupt and **take over the remote browser anytime**; takeover mode collects/screens nothing the user types; on-screen narration of what the agent is doing; "Watch Mode" supervision on sensitive sites. | Agent runs on its own virtual computer; cookies persist per site policy; one-click "delete browsing data + log out everywhere"; secure takeover keeps credentials out of model context. | On-screen narration feed; scheduled/recurring tasks; parallel task conversations; text-browser vs visual-browser split. |
| **OpenAI Atlas** (Chromium + OWL out-of-process layer) | Agent-mode model takes a **single composited screen image** (popups re-composited into the frame); agent also gets rendered + raw HTML over Mojo IPC (per independent instrumentation study). | Agent events routed **directly to the renderer, never through the privileged browser layer**; no code execution, no downloads, no extension installs by the agent. | Agent works in the user's own tabs with their browsing context; **pauses to require the user to watch on sensitive sites** (e.g. financial); per-site visibility toggle in the address bar; logged-out ephemeral mode. | Ephemeral logged-out sessions use Chromium `StoragePartition` in-memory stores, one per agent session, discarded at end — the closest published analog to Volli's per-Ticket partitions. Publisher guidance: add ARIA tags to be agent-friendly. | Browser memories (opt-in cross-session context); multi-profile (roadmap); ARIA-for-agents publisher guidance. |
| **Perplexity Comet** (Chromium fork; closed) | Closed internals. Independent study (HUMAN Security) observed an **internal extension active during agentic mode** (`overlay.js`) that highlights/annotates elements in the DOM and orchestrates interaction in-renderer. | Sidebar-driven; agent highlights elements on the page as it works (observed, not documented). | Assistant sidebar drives the visible tab the user sees; user watches and can intervene in the same tab. | Standard Chromium profile behavior; pinned tabs, bookmarks, autofill, password suggestions; Chrome extensions supported. | AdBlock built in; page translation; full consumer-browser surface (bookmarks/history/passwords). |
| **Dia** (Chromium fork; closed) | Chat over tab contents (current tab, Tab Group, or profile via `@`-mentions). No published agent-actuation API; agent answers, human clicks. | N/A — no agent actuation in sources read; "Skills" are reusable NL shortcuts that compose across tabs. | No co-driving: single driver (human) + advising assistant. | Profiles in separate windows; Memory system learns from open tabs (flagged as privacy trade-off in coverage); E2EE sync claimed. | **Skills** (NL skill builder, chainable); **Memory** (auto retrieval from tab activity); **Tab Groups for Meetings** (auto-group from calendar); integrations (Gmail/Calendar/Slack/Notion); Focus Mode. |
| **Cursor** (IDE pane/window + MCP-driven browser) | **Screenshots as images** plus console logs and network traffic; logs written to files the agent greps instead of dumping into context. | Navigate/click/type/scroll/screenshot/console/network tools; dev-server aware; screenshots integrated with file-reading. | Browser opens **as a pane in Cursor or a separate window**; browser actions + screenshots render inline in chat; **approval modes**: manual per-action (default), allow-list, auto-run. | **Per-workspace isolated browser context**; cookies/localStorage/IndexedDB persist across sessions; token auth per session + random tab IDs; **enterprise origin allowlist** for agent navigation (with documented bypass caveats); MCP allow/deny governance. | Origin allowlist; log-to-file + grep pattern; network-traffic tool; pane-or-window presentation choice. |
| **Windsurf** | *Not verified — both fetch attempts failed (404, 429); see Sources.* Search results describe an in-IDE browser preview feeding tab state, console errors, and selected DOM elements to Cascade. Treat as unconfirmed. | — | — | — | — |
| **Zed** | **No embedded browser.** Agent tools are read-only web: `fetch` (URL→Markdown) and `search_web`. Embedded webview is a long-open feature request (`zed#10533`), not shipped. | N/A | N/A | `fetch` governed by tool permissions/profiles/project trust, outside the terminal sandbox. | Counter-example: ships no browser at all and relies on MCP for anything more. |
| **Devin** (cloud Linux/Windows desktop + Chrome) | **Screenshot-action loop** at 1024×768 (screenshot → identify elements → click/type → re-screenshot). Plus scripted Playwright via a **CDP endpoint on port 29229** against Devin's own running Chrome, so scripts and point-and-click share cookies/auth. | Point-and-click for exploration; checked-in Playwright scripts (`.agents/skills/`) for repeatable flows like SSO login; **"Test the app" button** runs a test plan and returns an annotated video recording. | Testing is user-invoked ("test the changes") or autonomous; user watches the **recording**, not the live desktop. | Full sandboxed VM per session; secrets via env vars; per-platform desktop (Linux/Windows/macOS Outposts with TCC notes). | Annotated session recordings as review artifact; CDP-bridged Playwright scripts sharing live browser state; testing Skills. |
| **Manus** (cloud browser + local extension) | Operates the browser "like a real person" (visual); user watches in real time. | Cloud Browser for general tasks; **Browser Operator extension** for the user's local Chrome/Edge with existing logins. | Explicit **"Take Over"** handoff both ways: agent prompts the user to take over for CAPTCHA/SMS/2FA, user hands back after; local-operator tasks run in a **dedicated tab the user can grab or close to stop**. All actions logged. | Two-tier model: isolated per-user encrypted cloud instances (no password storage, user-managed sessions, data-center-IP caveats documented) vs local browser (residential IP, existing sessions). | Take-over-on-stuck pattern; close-tab-to-stop kill switch; published cloud-vs-local decision table. |
| **browser-use** (open-source Python agent + cloud) | **Hybrid**: merged DOM snapshot + `DOM.getDocument` + AX tree + JS probes → `EnhancedDOMTreeNode` tree; serialized to indexed interactive-element lines + clean screenshot with post-hoc highlights. Index **is the CDP `backend_node_id`** — stable across steps until the page changes. | Handle→node→coordinates via CDP; **new-since-last-step elements marked** in the serialization; cache reuse with invalidation on navigation/focus-change/scroll. | Cloud product adds stealth browsers, profiles, recordings; local run opens a visible browser the user can watch. | Cookie-only profile sync (localStorage/IndexedDB/extensions do NOT transfer — documented footgun); real-Chrome profile reuse or cloud profiles. | backend-id-stable refs; new-element marking; recordings + data policies (cloud). |
| **Stagehand / Browserbase** (open-source agent SDK) | `observe()` returns candidate actions (selector + description + method) from NL instruction; `act()` takes NL or an observed action. | **Self-healing**: cached action re-inferred when its selector no longer resolves; `domSettleTimeoutMs`; `act()` returns `{ success, actionDescription, actions[] }` with selectors; server-side result caching with token-saved accounting. | SDK pattern, no human UI of its own; determinism-first (Playwright-style APIs + selective AI). | Local or Browserbase-hosted browsers; session/token lifecycle caller-owned. | Self-healing actions; observe-then-act split (plan targets before acting); per-operation LLM usage metrics. |
| **Playwright MCP** (Microsoft; Volli's format donor) | AX snapshots, refs `eN` (`f1e12` iframe-scoped), **every acting tool returns a fresh snapshot**; `browser_find` (text/regex search returning matching subtree); optional bounding boxes; selectors also accepted as targets. | Stale ref → named error: `Ref <ref> not found in the current page snapshot. Try capturing new snapshot.` No generation counter — server-side current-snapshot lookup. | Headed by default so the human watches; `browser_highlight` element ring; `browser_annotate` (agent asks the *user* to draw on the page); record-manual-actions-as-code; video chapters. | Login state/cookies persist by default; `isolatedContext` per page; storage-state save/restore; `--caps=` gating (network/storage/testing/devtools/pdf/vision). | `browser_find`; `browser_highlight`; `browser_annotate`; record/replay as code; tracing + video; network mocking (`browser_route`); cookie/storage tools; `browser_evaluate`; PDF export; vision-coordinate tools. |
| **Puppeteer MCP** (reference server; **deprecated 2025**) | Screenshots only, no refs at all. | CSS-selector click/fill/hover/select + `evaluate` (raw JS). | NPX opens a visible window; Docker headless. | `allowDangerous` launch-option gate (its only notable safety idea). | Negative example: selector+`evaluate` design is exactly what Volli correctly excludes. |
| **Chrome DevTools MCP** (Google) | `take_snapshot` (a11y tree, `uid` refs) + screenshots; every input tool takes `pageId` + `uid` with optional `includeSnapshot`. | Dialog handling, `fill_form` batch, `wait_for` text, `evaluate_script`, emulation, perf traces, Lighthouse, CSS inspection, heap snapshots. | Drives the user's **live Chrome**; `screencast_start/stop` streams what the agent does; extension install/reload/uninstall tools. | No isolation story of its own — inherits whatever Chrome profile it attaches to (the risk Volli's partitions address). | Screencast; `fill_form`; network request inspection; Lighthouse + Web Vitals; CSS rule inspection; PWA/extension tooling. |
| **Claude in Chrome** (Anthropic extension in the user's real Chrome) | Reads the signed-in page, then clicks/types/fills; side panel is a Cowork session (history, skills, connectors carry over). | Site permissions + per-action confirmations; **autonomous mode with a safety classifier verifying each action against the user's request** (GA); blocked categories (financial/adult/pirated); enterprise domain limits. | Lives where the user browses; user watches the real tab; multi-tab workflows; scheduled tasks. | **No separation**: agent uses existing logins by design; red-teamed prompt-injection defenses (probes scanning tool results + action classifiers + training; published numbers: 23.6%→11.2% attack success in pilot, 0% vs Sonnet 5/Opus 5 with safeguards on the current eval, 0.3% vs Fable 5). | Classifier-verified autonomous mode; scheduled tasks; side-panel-as-Cowork-session continuity. |
| **Anthropic computer-use / browser-use API tools** (build-your-own; docs) | Computer-use: screenshots + coordinates only. Browser-use: **AX refs `[ref_N]` plus screenshots plus coordinates**; `read_page` filters; `browser_state` tab block on every result. | **Batch actions with a halt rule**: run in order, stop at first failure, every block answered (`Not executed: an earlier … action in this turn failed`); docs recommend ending batches with screenshot; explicit anti-pattern: reading only the first block. | Host's choice (reference impl is a Docker VM + web viewer). Published hardening list: dedicated VM, no sensitive data, domain allowlist, human confirmation for consequential actions. | Prompt-injection classifiers that auto-steer the model to ask for confirmation (opt-out via support); ZDR-eligible. | The halt-rule + mandatory-screenshot batch discipline; `browser_state` tabs block as a per-result invariant. |

## 2. Top findings

Each finding: product → source → what they do → whether Volli already does it (checked with `rg` in-tree).

1. **Playwright MCP returns a fresh snapshot from every acting tool; stale refs fail with a named error, no generation counter.**
Source: https://playwright.dev/mcp/snapshots ("Valid until the page changes"; "Ref \<ref\> not found in the current page snapshot. Try capturing new snapshot.").
Volli does this *more strictly*: `cdp-controller.ts` gates on an explicit generation (`syncGeneration`, last-snapshot check) and refuses pre-dispatch. Keep Volli's design; adopt only the error-text quality (name the ref, say what to do next).

2. **browser-use keys its element handles to CDP `backend_node_id`, stable across steps until the page changes, and marks new-since-last-step elements.**
Source: https://doc.holiday/library/browser-use/how-the-agent-sees-the-page/ (index assignment, selector map, change marking, cache invalidation on navigation/focus/scroll).
Volli does NOT do this: refs are re-minted per print (`snapshot-format.ts` `refStart`), so the model cannot learn "e12 is the same button as before." Worth considering as a complement to generations (stable ids reduce re-grounding; generations still gate dispatch).

3. **Stagehand splits targeting from acting (`observe()` → `act()`) and self-heals when a cached selector dies, returning `{ success, actionDescription }`.**
Source: https://docs.stagehand.dev/v4/reference/stagehand (`act`, `observe`, `selfHeal`, `domSettleTimeoutMs`, `ActResult`).
Volli does NOT do this: `browser_act` dispatches immediately with no pre-flight observation and no success boolean — the VC-277 no-op-click complaint is exactly the gap this pattern addresses. (See recommendation 2.)

4. **Nobody else has Volli's "hold."** The nearest analogs are takeover modes, not arbitration.
Sources: Operator takeover mode (https://openai.com/index/introducing-operator/); Manus "Take Over" (https://help.manus.im/en/articles/11711218-how-can-i-take-over-manus-browser-or-vs-code and https://www.manus.im/docs/features/cloud-browser); ChatGPT agent interrupt/take-control (https://openai.com/index/introducing-chatgpt-agent/); Cursor approval modes + origin allowlist (https://cursor.com/docs/agent/tools/browser).
Volli already does this (`tab-host.ts` holds, `hold-notices.ts` steers, `browser-holder-pill.tsx`, take-over/hand-back/ask-to-leave IPC channels). Verdict: differentiator — keep, and close the known gaps (VC-267) rather than copying anyone.

5. **While the agent drives, competitors show: a cursor (nobody), a highlight ring (Comet, Playwright MCP), a narration feed (ChatGPT agent), a control bar + sidebar preview (Atlas), or the raw video (Devin recordings, chrome-devtools-mcp screencast, browser-use cloud recordings).**
Sources: https://openai.com/index/introducing-chatgpt-agent/ ("an on-screen narration provides visibility"); https://www.humansecurity.com/learn/blog/chatgpt-atlas-vs-perplexity-comet-agentic-browsers/ (Comet `overlay.js` highlights; Atlas control bar + chat-panel page preview); https://docs.devin.ai/work-with-devin/computer-use ("Test the app" + annotated recording); https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/HEAD/docs/tool-reference.md (`screencast_start/stop`).
Volli already does the cursor (`cursor-overlay.ts`) — genuinely unique in this survey — plus transcript cards via `ActivityBrowse` rows and a holder pill. Volli does NOT do: element highlight on act, narration-style progress text, or session recording. (Recommendations 3, 8.)

6. **Atlas agent sessions get ephemeral in-memory `StoragePartition`s, one per session, discarded at end — the published twin of Volli's per-Ticket partitions.**
Source: https://openai.com/index/building-chatgpt-atlas/ ("Agent mode: Special cases").
Volli already does this (`agent-port.ts`: `persist:volli-browser:user` for personal tabs, credentialless per-Ticket/Project partitions for agent tabs). Verdict: parity on the important half; Atlas additionally routes agent input past the privileged browser layer — Volli's equivalent (app-private `webContents.debugger`, no remote-debugging port) is already the documented rationale in `cdp-controller.ts`.

7. **The industry norm for agents touching *authenticated* tabs is explicit user mediation; Volli's actuate-a-user-tab grant is currently unmediated (provisionally).**
Sources: Claude in Chrome site permissions + confirmations + classifier-verified autonomy (https://claude.com/blog/claude-for-chrome; https://claude.com/blog/claude-in-chrome-generally-available); Operator confirmations + Watch Mode (https://openai.com/index/introducing-operator/); Atlas pause-on-sensitive-sites + per-site visibility toggle (https://openai.com/index/introducing-chatgpt-atlas/); Cursor manual-approval default (https://cursor.com/docs/agent/tools/browser); Manus per-session authorization (https://manus.im/docs/features/browser-operator).
Volli does NOT do this yet — and already plans to: `agent-port.ts` names `takeHold` on `createdBy === "user"` as the approval seam. This survey upgrades that from "nice" to "every shipped product does some version of it." (Recommendation 5.)

8. **Isolation postures worth copying verbatim: Cursor's per-workspace contexts + origin allowlist; Manus's published cloud-vs-local decision table; browser-use's cookie-only-sync warning.**
Sources: https://cursor.com/docs/agent/tools/browser (per-workspace persistence; origin allowlist with redirect/link-navigation bypass caveats); https://www.manus.im/docs/features/cloud-browser (data-center-IP considerations, when-to-use-which table); https://raw.githubusercontent.com/browser-use/browser-use/main/README.md (profile sync transfers cookies, not localStorage/IndexedDB/extensions).
Volli does NOT have an origin allowlist (`isAllowedBrowserUrl` in `tab-host.ts` is scheme-level only) and does NOT document a cloud-vs-local-style decision surface. (Recommendation 6.)

9. **`browser_find` (search the snapshot, return matching subtree with context) is the cheapest high-value tool Volli lacks.**
Source: https://playwright.dev/mcp/snapshots (`browser_find` with `text`/`regex`, `...` gap markers).
Volli does NOT have it (8 tools in `browser-tools.ts`; snapshot is all-or-nothing 30k chars). It also directly mitigates VC-277 symptom 1 (empty/huge trees give the model nothing to aim at). (Recommendation 1.)

10. **Anthropic's batch discipline (halt rule + mandatory screenshot + `browser_state` on every result) is stricter than Volli's one-call-per-turn loop, and for good reason.**
Source: https://platform.claude.com/docs/en/agents-and-tools/tool-use/browser-use-tool (batch actions; `browser_state` tabs block); companion computer-use doc https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool (run-in-order, stop-at-first-failure, attach a screenshot so Claude always sees current state).
Volli partially does this: every navigate/act already returns a fresh snapshot + picture (`browser-tools.ts`). Volli does NOT encode stop-at-first-failure or tab-state invariants — less applicable since Volli tools are single calls, but the *guidance text* (`SNAPSHOT_GUIDANCE`, act description) could carry the "re-snapshot before retrying a failed action" rule explicitly.

11. **Prompt-injection stances, strongest to weakest: Anthropic (probes + classifiers + published evals), OpenAI (monitor model + cautious navigation + confirmations), Cursor ("best-effort", user must review), browser-use (stealth/proxy framing, auth-centric docs).**
Sources: https://claude.com/blog/claude-in-chrome-generally-available (0% vs Sonnet 5/Opus 5, 0.3% Fable 5); https://openai.com/index/introducing-operator/ (monitor model, detection pipeline); https://cursor.com/docs/agent/tools/browser ("The allow/block list system provides best-effort protection… Review auto-approved actions regularly").
Volli already does the envelope discipline (minted markers, provenance-first envelopes in `browser-tools.ts`) — ahead of most on *representation* hygiene. What Volli lacks is any runtime detection layer; deliberately so at this stage (see Not recommended 4), but the Anthropic classifier→confirmation-steer pattern is the one to watch.

12. **Dia's Skills / Memory / meeting Tab Groups and Devin's testing Skills point at reusable NL workflows, not browser primitives.**
Sources: https://supasidebar.com/blog/dia-browser-mac-review-2026 (Skills NL builder, Memory auto-search, meeting groups — secondary source citing Dia's changelog; Dia internals closed); https://docs.devin.ai/work-with-devin/computer-use (Skills for setup/test procedures).
Volli does NOT have these; they belong to a skills/personalization layer above Browser Tabs, not to this product. Not recommended here (see Not recommended 5) — except meeting-style auto-grouping, which has no Volli analog problem (Sessions, not tabs, are the unit).

13. **Cursor's log-to-file + grep pattern beats Volli's bounded console buffer for verbose pages.**
Source: https://cursor.com/docs/agent/tools/browser ("Browser logs are written to files that Agent can grep and selectively read… total line counts and preview snippets").
Volli already has `browser_console` bounded + truncation note (`browser-tools.ts` `consoleEnvelope`); the file-backed variant is an optimization, not a gap. Not recommended now.

14. **Zed is the deliberate counter-example: no embedded browser, read-only web tools, webview as a years-open issue.**
Sources: https://zed.dev/docs/ai/tools.html (`fetch`/`search_web` only); Zed issues #10533/#21208 (feature requests, via search — not fetched, so cited as search-result claims, not read sources).
Verdict: confirms Volli's browser is a differentiator in the coding-tool space (only Cursor among editors ships one), and that deferring consumer-browser features (bookmarks/history/sync) is normal — Zed and Cursor both skip them.

## 3. Recommended for Volli

Ranked by value/effort for the Browser Tabs product. All file pointers are in-repo.

1. **`browser_find`: search the current snapshot, return matching subtree with refs.**
Playwright MCP's highest-leverage primitive; directly serves VC-277 (aim on huge/empty trees) and large local-app pages. Implement as a filtered re-print in `snapshot-format.ts` (reuse `formatAXSnapshot` traversal with a match predicate + `...` gap markers), dispatch through `cdp-controller.ts`, expose in `packages/agent-runtime/src/pi/browser-tools.ts`. Keep the generation stamp so results stay ref-compatible.

2. **Give `browser_act` observable evidence (the VC-277 fix).**
Adopt the Stagehand `ActResult` shape in miniature: after dispatch, the act result already returns a fresh snapshot — add (a) whether the tab's generation advanced as a result of the action (page changed vs swallowed event), and (b) keep the existing target-name reporting. Both facts exist in `cdp-controller.ts` (`#generation`, `TabActResult.target`) and `agent-port.ts`; they just never reach the model text. No new CDP domains needed.

3. **`browser_highlight`: ring the acted element briefly (Comet/Playwright analog).**
The cursor overlay (`cursor-overlay.ts`) shows *where the Session points*; nothing shows *what it hit*. A short-lived CDP `Overlay.highlightNode` on the resolved `backendDOMNodeId` in `cdp-controller.ts` closes the loop for the watching human. Must exclude from `Page.captureScreenshot` (overlay already is; verify highlight is too).

4. **Empty-snapshot signal + screenshot fallback (VC-277 symptoms 1–2).**
Distinguish "page has no accessible content" from "read failed/timed out" in the snapshot envelope (`browser-tools.ts` `snapshotEnvelope`), and add an adaptive `Page.captureScreenshot` retry/fallback path in `cdp-controller.ts` before failing the call. Pure product-fit work, no new architecture.

5. **Mediation gate for actuating user tabs at `takeHold` (the planned approval step).**
`agent-port.ts` already names the seam (`tab.createdBy === "user"`, once per hold). This survey finds unanimous industry precedent (finding 7). Pairs with VC-267's take-over/hand-back/ask-to-leave commands: the approval prompt is the moment those verbs get exercised.

6. **Origin allowlist for agent navigation (Cursor enterprise pattern).**
Extend `isAllowedBrowserUrl` in `tab-host.ts` with a per-scope origin policy (Ticket/Project → allowed origins, defaulting to the registered local dev origin + user-confirmed hosts). Adopt Cursor's documented caveats honestly: allowlist governs *agent-initiated* navigation, not redirects/link-follow/JS navigation — say so in the refusal text.

7. **Batch form fill + dialog handling as narrow `act` kinds.**
`fill_form` (chrome-devtools-mcp, Playwright MCP, Stagehand all have it) and `handle_dialog` (both MCPs) are the two most-missed verbs in Volli's 7-kind `act` schema (`browser-tools.ts` `actSchema`). Both resolve through the existing ref→`backendDOMNodeId` path in `cdp-controller.ts`; neither needs `evaluate` or new domains.

8. **Session recording / trace export for QA runs (Phase-4-shaped).**
Devin's annotated recordings, chrome-devtools-mcp `screencast_*`, Playwright MCP tracing/video, browser-use cloud recordings all converge: *the artifact of agent browsing is a replayable trace*, not a transcript claim. Volli's `picture-store.ts`/`picture-disk.ts` is the natural seed (persist captures per turn; export a timeline). Keep scoped to agent tabs; personal tabs excluded by construction.

9. **Read-only network inspection before any interception.**
Cursor ships network traffic; Playwright MCP gates it behind `--caps=network`; chrome-devtools-mcp lists/gets requests. Volli explicitly excludes network domains (`cdp-controller.ts` header). Recommend a read-only `browser_network`-style listing first (diagnosing local-app failures is the Dev-Preview job); keep mocking/route control out per VC-110.

10. **Publish agent-friendly AX guidance for local apps (Atlas ARIA-tags pattern).**
Atlas's publisher docs ask sites to add ARIA tags so the agent works better (https://openai.com/index/introducing-chatgpt-atlas/). Volli's Dev Preview tabs serve the user's *own* app: a short "make your app agent-testable" doc (roles, names, labels) plus the empty-snapshot signal (rec. 4) turns VC-277-class failures into actionable authoring feedback.

## 4. Deliberately not recommended

1. **Raw JavaScript evaluation / CDP passthrough.** Playwright MCP (`browser_evaluate`, `browser_run_code_unsafe`), chrome-devtools-mcp (`evaluate_script`), and Puppeteer MCP (`puppeteer_evaluate`) all ship it — and Cursor sandboxes it behind approvals + audits while Volli's VC-110 decision explicitly excluded it. The exclusion stands: `evaluate` collapses the ref-dispatch safety model (`cdp-controller.ts` acts by handle, never by selector/code) and would void the `select`-as-fixed-string guarantee.
2. **Vision/coordinates-only driving (CUA / Anthropic computer-use style) as the primary loop.** Less precise, more tokens, and strictly worse than the AX-ref loop on Volli's home turf (local dev apps with good trees). Screenshots stay as *companion evidence* (already the design), not the addressing mode.
3. **CSS-selector targeting (Puppeteer MCP style).** Brittle across mutations and smuggles page content into the addressing path; Volli's minted-ref map is the better contract. (Playwright MCP accepts selectors as a convenience; Volli should not — its generation gate has no meaning for a selector.)
4. **A prompt-injection classifier/runtime detection layer now.** Anthropic's probes + action-classifier stack is the state of the art and is expensive to build and eval (they publish attack-success percentages; Volli has no eval harness for this). Volli's envelope discipline + provisional user-tab mediation (rec. 5) is the right-sized posture; revisit when agent tabs touch untrusted authenticated sessions routinely.
5. **Browser memories / cross-session learning / Skills-over-tabs (Atlas/Dia/Devin).** Conflicts with Volli's credentialless per-Ticket partitions and Session-scoped visibility; personalization is a product above Browser Tabs, not a tab feature. Revisit only with an explicit memory consent + storage design.
6. **Agent file downloads/uploads.** Volli blocks downloads (`tab-host.ts` `secureSession` → `will-download` `preventDefault`) and offers no uploads. Cursor and the MCPs show this is where exfiltration and drive-by payloads live. Keep blocked until a deliberate, scoped flow exists (VC-110 already says this).
7. **Consumer-browser surface: bookmarks, history, tab groups, sync, password management, reader mode, find-in-page-for-humans.** Comet ships all of it; Dia differentiates on groups; Zed and Cursor both skip it. Volli's tabs are task-scoped work surfaces, not a daily browser — building sync/history is a second product.
8. **A second-browser sidecar as the interactive-tab substrate.** Re-affirms VC-110: `agent-browser`-as-QA-runner stays Phase 4; nothing in this survey (not even Atlas's OWL, which *is* a second process but a native architectural layer, not a CLI bolt-on) argues for driving the visible tab from outside Electron.

## 5. Sources

Every URL below was actually read (via `web_fetch`) for this memo. Nothing is cited second-hand except where explicitly marked.

**OpenAI**
- https://openai.com/index/introducing-operator/ — CUA vision/keyboard model, takeover mode (no collection while user drives), confirmations, Watch Mode, monitor model, parallel conversations.
- https://openai.com/index/introducing-chatgpt-agent/ — visual + text browsers, on-screen narration, interrupt/take-control, secure takeover, one-click data deletion, scheduled tasks.
- https://openai.com/index/introducing-chatgpt-atlas/ — agent mode in user tabs, logged-out mode, pause-on-sensitive-sites, per-site visibility toggle, browser memories, ARIA-tags publisher guidance, agent capability limits.
- https://openai.com/index/building-chatgpt-atlas/ — OWL architecture (Mojo IPC, out-of-process Chromium, delegated compositing), agent input routed to renderer only, ephemeral `StoragePartition` agent sessions, popup compositing.

**Anthropic**
- https://claude.com/blog/claude-for-chrome — pilot: site permissions, confirmations, blocked categories, 23.6%→11.2% red-team numbers, takeover-adjacent guidance.
- https://claude.com/blog/claude-in-chrome-generally-available — GA: autonomous mode + per-action safety classifier, probe scanning of tool results, 0%/0.3% current-eval numbers, enterprise domain limits.
- https://platform.claude.com/docs/en/agents-and-tools/tool-use/browser-use-tool — `[ref_N]` AX refs + coordinates, `read_page` filters, batch halt rule, `browser_state` tab invariant, executor-must-answer-everything discipline.
- https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool — screenshot/coordinate toolset, run-in-order/stop-at-first-failure, attach-a-screenshot guidance, VM + allowlist + confirmation hardening list, classifier auto-steer to confirmation.

**Editors / coding tools**
- https://cursor.com/docs/agent/tools/browser — pane-or-window presentation, screenshot+console+network tools, log-to-file pattern, per-workspace isolated contexts with persistence, approval modes, origin allowlist + bypass caveats, best-effort injection disclaimer.
- https://zed.dev/docs/ai/tools.html — read-only `fetch`/`search_web`, no browser; confirms the counter-example.

**Cloud agents**
- https://docs.devin.ai/work-with-devin/computer-use — 1024×768 screenshot loop, "Test the app" + annotated recordings, Playwright-over-CDP-port-29229 sharing live state, skills for test procedures.
- https://help.manus.im/en/articles/11711218-how-can-i-take-over-manus-browser-or-vs-code — user take-over of agent browser/VS Code.
- https://www.manus.im/docs/features/cloud-browser — cloud browser model, Take Over flow for verifications, encrypted isolated instances, data-center-IP caveats, cloud-vs-local decision table.
- https://manus.im/docs/features/browser-operator — local-browser extension, per-session authorization, dedicated-tab + close-to-stop, action logging.

**Open agent/SDK ecosystem**
- https://doc.holiday/library/browser-use/how-the-agent-sees-the-page/ — merged DOM/AX/CDP representation, `backend_node_id` stable handles, selector maps, new-element marking, cache invalidation rules, clean-screenshot + post-hoc highlights.
- https://raw.githubusercontent.com/browser-use/browser-use/main/README.md — product surface (cloud/CLI/library), cookie-only profile sync caveat, CAPTCHA stance.
- https://docs.stagehand.dev/v4/reference/stagehand — `act`/`observe`, self-heal, `domSettleTimeoutMs`, `ActResult{success,…}`, usage metrics.
- https://playwright.dev/mcp/introduction — 70+ tools, headed-by-default, caps gating, persistent sessions.
- https://playwright.dev/mcp/snapshots — ref format + iframe scoping, staleness error text, fresh-snapshot-per-action, `browser_find`, boxes, vision mode.
- https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/HEAD/docs/tool-reference.md — `pageId`+`uid` tool shape, `fill_form`, dialogs, `wait_for`, network tools, Lighthouse, `screencast_*`, emulation, extension tools.
- https://www.npmjs.com/package/@modelcontextprotocol/server-puppeteer — deprecated reference server: selector tools + `evaluate`, screenshot/console resources, `allowDangerous` gate. (Negative example.)

**AI browsers (closed; docs/demos/coverage, marked as such)**
- https://www.perplexity.ai/help-center/comet/en/articles/11583798-what-is-comet-s-browser-engine — Chromium base, extension support, sidebar assistant, standard browser features.
- https://www.humansecurity.com/learn/blog/chatgpt-atlas-vs-perplexity-comet-agentic-browsers/ — independent instrumentation study (vendor: bot-defense firm — read for its technical observations, not its product pitch): Comet internal extension + `overlay.js` highlights; Atlas OWL out-of-process control + chat-panel preview; Chrome-identical fingerprints. Only source for Comet/Atlas agent *mechanism*; treated as observed-behavior evidence.
- https://www.diabrowser.com/ — marketing page; confirms almost nothing technical (fetch succeeded but page is thin).
- https://thenewstack.io/ai-browsers-dias-chat-based-ui-and-the-future-of-the-web/ — Dia beta: chat-with-tabs, no agent purchasing at the time; contextualizes the chat-first paradigm.
- https://supasidebar.com/blog/dia-browser-mac-review-2026 — secondary vendor review (sells a sidebar app) citing Dia's changelog: Skills NL builder, Memory auto-search, meeting Tab Groups, integrations, Chromium rebase cadence. Used only for Dia's feature list, flagged accordingly; Dia internals remain closed.

**Volli-internal (read in-tree)**
- `docs/research/browser-tooling-vc-110.md`; `apps/desktop/src/main/browser/{tab-host,cdp-controller,agent-port,snapshot-format,cursor-overlay,hold-notices,picture-store}.ts`; `packages/agent-runtime/src/pi/browser-tools.ts`; Tickets VC-253, VC-267, VC-277 (via `volli ticket brief`).

**Attempted but not read (failures, not cited)**
- https://openai.com/index/computer-using-agent/ — 403.
- https://www.perplexity.ai/hub/blog/introducing-comet — 403.
- https://university.windsurf.build/cascade-tools/browser-previews — 404. **Windsurf is therefore absent from the comparison beyond this note**; its in-IDE browser preview could not be verified from a primary source.
- https://devin.ai/blog/windsurf-wave-10-browser — 429.
- https://raw.githubusercontent.com/modelcontextprotocol/servers/main/src/puppeteer/README.md — 404 ( consistent with the package's deprecation; npm page used instead).
- https://deepwiki.com/browser-use/browser-use/6.3-action-execution-pipeline — returned an empty loader shell; the doc.holiday field guide (same project internals) used instead.
