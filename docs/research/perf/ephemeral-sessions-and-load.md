# Ephemeral sessions & UI smoothness under load

Research for: (a) deferring durable Session creation + executor attach until the
first message is sent (`+ Chat` opens a provisional chat with no sidebar entry,
no SQLite row, no worktree, no runtime); (b) keeping the Electron UI smooth
while many worktrees build/test concurrently.

Read-only on source. No existing file was modified to produce this document.

Conventions below: each finding is **Technique / Source (URL, read) /
Documented or measured effect**. "Applicable to Volli" sections use
`file:line` pointers verified with `rg` on 2026-09-13. §4 lists every URL
actually read; two attempted reads failed and are marked as such. Anything
labelled **synthesis** is the author's inference from read sources, not a cited
claim.

---

## Part A — the ephemeral-session model

### A.1 Findings

#### Agent/coding tools: where a conversation is first persisted

**A1.1 — Claude Code: sessions materialize as local transcript files, continuously, as you work.**
Claude Code stores each session as a `.jsonl` transcript under
`~/.claude/projects/<project>/` and documents "sessions are saved continuously
to local transcript files as you work." Resume entry points (`--continue`,
`--resume`, `/resume`, session picker) all operate on stored transcripts; the
picker only ever lists sessions that have content. Unnamed sessions get a
*default display name* (e.g. `my-app-3f`) that is explicitly **not** a resume
handle, plus a *generated title* summarized from the first prompt by a
background Haiku-class call — naming, in other words, is derived from the first
real interaction, not from session birth.
*Source:* https://code.claude.com/docs/en/sessions
*Effect (documented):* there is no observable "empty session" anywhere in the
product: no picker row, no resumable id, no title until there is content. The
session id exists from launch, but nothing durable or listable exists before
the first prompt.

**A1.2 — Codex CLI: rollout files under `~/.codex/sessions/`, replayed on resume.**
`codex resume [--last]` loads the session rollout file from
`~/.codex/sessions/`, restores full history (messages, commands, file changes,
reasoning), and reopens the TUI. The contemporaneous feature request
(openai/codex#2080, read) is revealing about ordering: users observed that
`.codex/history` files "are being recorded locally" *before* any
list/resume command existed to surface them — persistence preceded
discoverability, and the picker/index was built on top of already-written
files.
*Sources:* https://openai-codex.mintlify.app/cli/resume ·
https://github.com/openai/codex/issues/2080
*Effect (documented):* first persistence = append of turn events to a
per-session file as the conversation runs; listing/resume is a secondary index
over those files. An empty launch that never produces a turn leaves nothing
worth indexing.

**A1.3 — Cursor: client-minted `composerId` UUID; nothing durable until the first bubble.**
Reverse-engineering documentation of Cursor's local storage (SQLite
`state.vscdb`, read) shows every conversation keyed by a client-generated
`composerId` UUID, with message content in `bubbleId:{composerId}:{bubbleId}`
rows and the sidebar populated from a central `composer.composerHeaders`
index. The complementary primary data point: a Cursor forum bug report (read,
May 2026, v3.5.33) shows that starting a *new* Agent tab (Ctrl+N) and typing
without sending creates a blank tab whose draft is view-local — switching tabs
loses the unsent text entirely ("the drafted text … is permanently lost"),
confirmed by staff as "the draft state doesn't get saved when switching
between Agent tabs."
*Sources:*
https://github.com/Callum-Ward/cursaves/blob/main/docs/how-cursor-stores-chats.md ·
https://forum.cursor.com/t/drafted-message-in-new-agent-tab-is-lost-cleared-when-switching-to-previous-chats/161643
*Effect (documented):* Cursor mints the id up front (UUID, no server round
trip) but persists nothing until the first send; pre-send content is the most
fragile state in the product. This is both the model to copy (client UUID, no
swap) and the failure mode to avoid (view-local draft lost on navigation).

**A1.4 — Zed agent panel: threads are cheap lanes; history/restore is a separate, per-agent concern.**
Zed docs (read): new threads start from the `+`/palette menu, each with its
own agent, context window, and history; the Threads Sidebar groups them by
project; idle threads are *archived*, and a cross-project Thread History can
*restore* them. Thread titles auto-generate from conversation content and are
editable. Notably, "restoring threads from history, checkpoints, token usage
display … depend on the agent integration" — the panel treats the thread lane
and its durable backing as separable layers.
*Source:* https://zed.dev/docs/ai/agent-panel
*Effect (documented):* opening a lane is near-free and reversible (archive);
durable history is an integration capability, not a birth requirement.

**A1.5 — Continue.dev CLI: the reference implementation of exactly the requested behavior.**
`extensions/cli/src/session.ts` (read as raw source):
`SessionManager.getCurrentSession()` mints a UUIDv4 **in memory** at session
start, and `saveSession()` returns early via `hasSessionContent()` unless the
history contains at least one non-system message:

```ts
if (!hasSessionContent(session)) {
  return;   // empty sessions never touch disk
}
```

`--resume` loads the most-recent `~/.continue/sessions/<uuid>.json`. New
sessions start with `DEFAULT_SESSION_TITLE`; the file appears only after real
content exists.
*Source:* https://raw.githubusercontent.com/continuedev/continue/main/extensions/cli/src/session.ts
*Effect (documented, in code):* in-memory UUID + content-gated persistence is
the whole mechanism — ~15 lines. No id swap, no tombstones, no migration: an
abandoned empty session simply never existed on disk.

**A1.6 — Aider: the log is not the session.**
Aider appends every turn to `.aider.chat.history.md` in the launch directory
(a plain Markdown log), but *restoring* that log as live context requires the
explicit opt-in `--restore-chat-history`, which **defaults to False** (options
reference, read).
*Source:* https://aider.chat/docs/config/options.html
*Effect (documented):* durable bytes ≠ resumable session. Aider keeps the
observable log unconditional and the session-ness conditional — the inverse of
Continue, and a reminder to decide which half "no persistence until first send"
actually means.

**A1.7 — Windsurf Cascade: per-session trajectory files written as the session runs**
(secondary source — unofficial reverse-engineering README, read and attributed
as such). Cascade keeps per-session chat history as files (`*.pb`protobuf
trajectories) under `~/.codeium/windsurf/cascade/` (plus `implicit/`), one file
per conversation UUID, with old turns compressed into checkpoint summaries.
*Source:* https://github.com/dayearleo/windsurf-local-user-data-decryption
*Effect (reported, unofficial):* same shape as Codex — one file per live
session, written as turns happen; sessions with no turns leave no trajectory.

**Observable-lifecycle summary across tools.** In every tool examined, the
lifecycle is some variant of: *open lane (cheap, local, possibly id-only) →
first real interaction appends durable content → listing/resume/title derive
from that content.* Nobody derives the durable id from the content (ids are
UUIDs minted at lane-open or process-start); everybody derives *listability*
from content.

#### The general UI pattern: provisional entity, promoted on first interaction

**A2.1 — Linear: two draft tiers with explicit abandonment policy.**
Linear docs (read): navigating away from the issue composer keeps a
*temporary* draft that "is saved locally and only available on the client used
to create it" and is cleared by logout/restart/reset; pressing Esc/close offers
an explicit *saved* draft that "persists across clients," is listed on a
Drafts page, and "stored for 6 months before being deleted automatically."
Real issues get consecutively-assigned numbers **at creation** — the durable id
is never pre-assigned to a draft.
*Source:* https://linear.app/docs/creating-issues
*Effect (documented):* promotion = server create; abandonment of temp drafts is
silent and local, abandonment of saved drafts is time-boxed (6 months) and
user-visible. The id question is sidestepped: drafts have no issue id at all.

**A2.2 — Notion: the client id IS the durable id; the outbox is durable.**
Notion's data-model writeup (read): "a block's life starts on the client" —
the client generates a random UUIDv4 for every block, applies the transaction
to local state in milliseconds, and queues it in a TransactionQueue persisted
in IndexedDB/SQLite "until they're persisted by the server or rejected" via
`/saveTransactions` (server commits or rejects the group).
*Source:* https://www.notion.com/blog/data-model-behind-notion
*Effect (documented):* because the id is minted client-side and never remapped,
there is no swap to handle — references created before the server ack stay
valid. Crash-safety comes from persisting the *outbox*, not from persisting
early.

**A2.3 — Gmail: server draft with a stable container id over mutable content.**
Gmail web UI auto-saves every compose to the server `Drafts` label (support
page, read). The API guide (read) documents the id design precisely: "the
`drafts` resource is a container that provides a stable ID because the
underlying message IDs change every time the message is replaced"; sending
deletes the draft and creates a *new* message with a new id and the `SENT`
label.
*Sources:* https://support.google.com/mail/answer/9259768?hl=en ·
https://developers.google.com/workspace/gmail/api/guides/drafts
*Effect (documented):* when content ids churn, hand out a stable container id
and let references point at the container. Promotion (send) explicitly destroys
the provisional entity and mints a new id — callers follow the container, never
the content.

**A2.4 — Slack: drafts are a listing keyed by destination, with no message id at all.**
Slack's drafts announcement (read): "those unsent messages now appear in a
dedicated Drafts section in your channel sidebar, so you can easily jump back
to them."
*Source:* https://slack.com/blog/productivity/in-case-you-missed-it-drafts-email-dark-mode
*Effect (documented):* pre-send state is keyed by *where it will go*
(channel), not by an entity id. No id exists until send, so no swap exists.

**A2.5 — Figma: the opposite pole — persist everything immediately, curate by location.**
Figma help (read): "everyone with a Figma account will have their own drafts
folder… a sketchbook"; "there are no limits on how many files you can create
in your drafts"; drafts are private until shared; promotion is *moving* the
file into a team project; deletion goes to Trash (archive with restore or
permanent delete).
*Sources:*
https://help.figma.com/hc/en-us/articles/360038511153-Create-a-new-file ·
https://help.figma.com/hc/en-us/articles/14381406380183-Guide-to-the-file-browser
*Effect (documented):* no provisional state at all — creation and persistence
are the same act, and abandonment is handled by location (Drafts vs project)
plus Trash-with-restore. Worth naming because it is the model Volli has *today*
(create row up front); Figma shows its cost is paid in curation UI, not in
lifecycle machinery.

**Pattern summary.** Three proven answers to "what id does the client use
before the server has one": (1) a client-minted UUID that *becomes* the
durable id — no swap (Notion, Cursor composerId, Continue sessionId); (2) no
id at all, keyed by destination or held view-locally — swap avoided by absence
(Slack, Linear temp drafts, Cursor pre-send); (3) a stable container id over
churning content ids (Gmail). Nobody remaps references after the fact.

#### Hazards

**A3.1 — Id reassignment breaking in-flight references.** The read sources
agree by construction: systems that mint the final id up front (Notion UUIDv4,
Cursor composerId, Continue UUID) never reassign, so composers, queues,
attachments, and activity clusters can't dangle. Gmail confines churn *inside*
a stable container. *Synthesis for Volli:* the queued-message ids
(`newMessageId()` in session-create.ts), the chat client registry, and the
Activity Island's agents cluster all key off the Session id — a promote-time
remap would have to rewrite every one atomically. Mint-once (client UUID that
survives promotion) eliminates the hazard class.

**A3.2 — Two tabs racing to promote.** Notion: the server commits or rejects
each transaction *as a group*; conflicts surface as rejections, never silent
merges. Continue CLI: `saveSession()` is last-writer-wins by file mtime, and
`loadSession()` reads the most recent file — acceptable because one terminal
owns its session. *Synthesis for Volli:* the codebase already serializes
creates per owner (`underOwnerGuard` in session-create.ts — one create per
owner in flight). A provisional-draft design should keep that single-promoter
invariant: one owner, one promotion path, with the second attempter resolving
to the already-promoted id rather than minting a duplicate.

**A3.3 — Crash between "typed" and "promoted."** Notion: the TransactionQueue
is in IndexedDB/SQLite, so a crash replays the outbox; the editor state is
never only in memory. Volli already owns this pattern: `chat-drafts.ts`
persists `held` messages and rehydrates every held message as `unsent` on boot
("a crash mid-send show[s] up as words waiting rather than as words gone").
*Synthesis:* whatever holds the provisional chat's text must sit on the same
durable path as `CHAT_DRAFTS_APP_STATE_KEY` (chat-drafts.ts:52), not in tab or
component state — Cursor's draft-loss bug (A1.3) is the published consequence
of getting this wrong.

**A3.4 — Undo/restore of an abandoned draft.** Linear: saved drafts live on a
Drafts page with a 6-month TTL, then auto-delete. Figma: Trash archives with
restore or permanent delete. Gmail: discard is an explicit user act on a
visible draft. *Synthesis:* if provisional chats are durable anywhere, they
need an explicit, discoverable, time-boxed recovery story; if they are purely
local/view-state (Continue's choice — never written), there is nothing to
restore and the design must say so plainly, because "Drafts" UI that silently
drops content reads as data loss (again, A1.3).

**A3.5 — Event-sourced visibility: the entity must not appear in history until promoted.**
Fowler's Event Sourcing (read): the event log is the record; application state
— including listings — is derived, rebuildable by replay, and snapshots are a
performance cache, not truth. *Synthesis:* two clean options exist. (a)
*Nothing in the ledger until promotion* (Continue's `hasSessionContent`
gate, applied at the Volli level: `session.create` simply isn't called). (b) A
provisional flag on early events that every projection (sidebar, history,
⌘K, usage, attention) excludes — strictly more machinery, and it collides with
the repo's "Session Events are exhaustive on write" posture (see A.4). Option
(a) is smaller and matches every tool in A1.

### A.4 Applicable to Volli

**Where the durable write happens today (the cost being deferred).**
`+ Chat` → `bootChatSession` (session-create.ts:501) → `createChatSession`
(chat-sessions.ts:200), which calls `session.create` (SQLite row + `mint` in
main/session-runtime/sessions.ts:592 — records `session.create`,
`model.select`, tool-surface freeze, and the `session_started` planner event)
and then `session.attach` (sessions.ts:607 → `adapter.attach`, sessions.ts:655)
*without awaiting it* (chat-sessions.ts:233-242: tab lands on the create while
"worktree ensure + Agent Runtime boot … runs in the background"). The attach
path is what materializes the ticket worktree (pty/manager.ts:485 calls
`ensure`, worktree/ensure.ts:237) and boots the Pi runtime (pi-adapter.ts).
Deferring *create* to first-send therefore defers, in one move: the SQLite
row, the model-policy recording, the planner event, the worktree
materialization, and the runtime boot. That is the prize — essentially all of
`+ Chat`'s current cost sits behind the promotion gate, not just the row.

**What already looks like the target model.** VC-16 already split
create/attach (sessions.ts:592 vs :607) for the optimistic open; the task is to
move the *create* call itself behind the first-send gate and park the
pre-send composer on the existing draft substrate (chat-drafts.ts:50-52 —
`MAX_DRAFTS = 50`, single `volli:chat-drafts` app_state blob, already the
crash-safe outbox per A3.3). Continue's `hasSessionContent` (A1.5) is the
direct template for the promotion predicate.

**The repo's own constraints — quoted verbatim — and the honest tension:**

1. `CLAUDE.md:21` — "A Session is durable and owns identity and ordered local
history before any live executor attaches. The temporary native-adapter
contract, processes, terminal panes, and UI views never own Session lifetime."
2. `CONTEXT.md:71-80` — "A Session is created before any executor attaches
and outlives terminal panes, processes, the Agent Runtime, UI surfaces, and
execution venues."
3. `session-create.ts:318-320` — "The durable row is NOT deleted — no delete
channel exists, by design."
4. `CLAUDE.md:31` — "A durable id derivation is frozen the moment it ships.
`session_events.id`, Attention ids and the transcript artifact digest are all
re-derived from live data on every relaunch and deduped by exact string match,
so changing how one is built does not error — it duplicates history, or
leaves a row nothing can ever clear."

The tension, stated plainly: rules 1–2 say a *Session* owns identity from
birth — so a provisional chat **cannot be a Session**; it must be a different
kind (a Draft) that *becomes addressable as* a Session only at promotion, with
a client-minted id carried across (the Notion/Cursor/Continue answer in
A2/A3.1). Rule 3 then cuts in favor of deferral: with no delete channel, every
abandoned `+ Chat` today is a permanent row, ledger presence, and sidebar
history entry — exactly the clutter the product owner wants to stop creating.
Rule 4 constrains the migration: the promotion must not invent a new id
derivation for `session_events.id` or Attention ids at promote-time; minting
the final UUID in the draft (pre-promotion) and reusing it at `session.create`
keeps every frozen derivation untouched. Two further entanglements to design
around, not hand-wave: `mint` (sessions.ts) records the `session_started`
planner event and the model's `model.select` at create-time, so deferring
create defers planner history and model-policy recording — correct for
user-typed chats, but kickoff/Automation/Subagent sessions (which have no
"first user message") need an explicit non-interactive promotion path; and the
durable `sessionId` is referenced by the delegation ledger and the agents
cluster, so promotion must be single-writer per owner (extend
`underOwnerGuard`, don't duplicate it). None of this violates the four rules
— but a design that remaps ids at promotion, deletes abandoned rows, or writes
provisional events into the Session ledger would, and is therefore not a
proposal.

---

## Part B — UI smoothness under concurrent background load

### B.1 Findings

#### Process priority and scheduling on macOS

**B1.1 — `taskpolicy`: one mechanism to background a whole process tree.**
macOS `taskpolicy` (documented reference, read) can launch a program with an
altered scheduling/I-O policy or retarget a live pid: `-b` downgrades to
background (`setpriority(PRIO_DARWIN_BG)`), `-c` sets a QoS clamp
(`utility`/`background`/`maintenance`), `-d`/`-g` throttle disk I/O via
`setiopolicy_np`, `-t`/`-l` set throughput/latency tiers — and "all children
of the specified program also inherit these policies." On Apple Silicon,
backgrounded work runs on efficiency cores.
*Source:* https://ss64.com/mac/taskpolicy.html (redirected from
…/osx/taskpolicy.html)
*Effect (documented):* priority is inheritable at spawn: backgrounding the
session leader backgrounds its compilers, test runners, and grandchildren
with no per-tool cooperation. Verified present on this machine
(`/usr/sbin/taskpolicy`, plus `/usr/bin/nice`, `/usr/bin/renice`).

**B1.2 — What Node/Electron exposes.**
Node exposes the same `setpriority(2)` surface as `os.setPriority([pid,]
priority)` / `os.getPriority` — verified present in this repo's Node runtime
(`node -e` prints `setPriority: function | getPriority: function`), alongside
`os.availableParallelism()` (8 on this machine). Semantics are POSIX nice
values (higher number = less favorable; unprivileged callers can only raise,
never lower). Caveat: this is runtime verification, not a docs read — the
Node API page was not fetched.
*Sources:* local `node -e` check (method, not a URL) ·
https://ss64.com/mac/taskpolicy.html (for the underlying `setpriority(2)` /
inheritance semantics)
*Effect:* Volli main *can* lower its own spawned children's priority today
with no new dependency — but nice values are coarse (no E-core pinning, no I/O
throttle); QoS clamps require spawn-attr or `taskpolicy` wrapping.

**B1.3 — What build tools and IDEs actually do: cap parallelism, not priority.**
The published norm is concurrency budgets, not `nice`:
- ninja runs `-j N` with "default = derived from CPUs available" (man page,
read); Kitware documents the default as cores+2 and GNU make guidance as
cores+1 (`make -j5` on a quad-core).
- Kitware (read): "Xcode build performs parallel builds by default"; MSVC
`/MP` "will use as many cores as it sees on the machine" — and warns that
stacking target-level and object-level parallelism "can lead to excessive
parallelism grinding your machine and GUI to a halt."
- VS Code does *not* deprioritize its background workers: ripgrep runs with
its default implicit-multithread heuristic (`-j0`), and the read issue
(microsoft/vscode#206030) is a user asking for a *thread-cap* option because
unbounded rg threads degrade the machine — i.e. even VS Code's answer to
background-load jank is caps and cancellation, not OS priority.
*Sources:* https://manpages.org/ninja ·
https://www.kitware.com/cmake-building-with-all-your-cores/ ·
https://github.com/microsoft/vscode/issues/206030
*Effect (documented):* every mainstream tool assumes "cores belong to me
unless capped." No examined IDE lowers background-indexer OS priority; they
bound thread counts. (JetBrains/Xcode indexer QoS specifics were searched for
but no citable primary source was found in this pass — stated as a gap, not a
claim.)

#### Electron-specific: why a busy machine still janks the UI

**B2.1 — Blocking main freezes everything, by architecture.**
Electron's official performance tutorial (read): "Electron's main process …
is special … It handles windows, interactions, and the communication between
various components … It also houses the UI thread. Under no circumstances
should you block this process … Blocking the UI thread means that your entire
app will freeze." The mechanism is spelled out: "when the operating system
tells your app about a mouse click, it'll go through the main process before
it reaches your window. If your window is rendering a buttery-smooth
animation, it'll need to talk to the GPU process about that — once again going
through the main process." Prescribed remedies: worker threads / dedicated
processes for CPU-heavy work, never sync IPC (`@electron/remote`), always
async I/O; on the renderer side, `requestIdleCallback()` and Web Workers.
*Source:* https://www.electronjs.org/docs/latest/tutorial/performance
(redirected from electronjs.org)
*Effect (documented):* **yes — main-process CPU starvation janks the renderer
despite separate processes**, because input routing and GPU-process
coordination both transit main. Sidebar open/close jank during parallel builds
is consistent with main-thread contention (SQLite writes, worktree git ops,
Pi-runtime hosting, PTY fan-out all live in main here), not only with renderer
load. (GPU-process contention beyond this transit role, and the
`backgroundThrottling` option's exact behavior, were not verified against
read sources in this pass — marked as gaps.)

#### CSS/compositor causes of jank that survive a fast machine

**B3.1 — Animate `transform`/`opacity` or pay layout+paint per frame.**
web.dev (read): only `transform` and `opacity` are handled by the compositor
alone; everything else re-runs layout and/or paint. Promote animated elements
with `will-change` (sparingly — "every layer … requires memory and
management … textures need to be uploaded to the GPU"), and keep compositing
work around ~4–5ms per frame.
*Source:*
https://web.dev/articles/stick-to-compositor-only-properties-and-manage-layer-count
*Effect (documented):* any sidebar open/close that animates `width` (or
anything that changes siblings' boxes) is layout work on the main thread, in
*every* frame, on *any* machine.

**B3.2 — Animating `width`/`height` on a container is the canonical bad case;
JS-driven animation halts when the main thread is busy.**
Chrome Developers (read): "animating `width` and `height` … require
calculating layout, and paint the results on every frame … will typically
cause you to miss out on 60fps." Recommended replacement: scale transforms
(with counter-scaling children), baked as CSS keyframes or Web Animations so
the animation runs on the compositor; "the downside of any JavaScript-based
animation is what happens when the main thread … is busy … your animation can
stutter or halt altogether." Also note `getBoundingClientRect()` /
`offsetWidth` mid-animation forces sync style+layout.
*Source:* https://developer.chrome.com/blog/performant-expand-and-collapse
*Effect (documented):* rAF/JS width animation + busy main thread = the exact
reported symptom (jank proportional to background load).

**B3.3 — Sidebar-specific writeup: width animation janks under load; the
Notion pattern avoids sibling reflow.**
Joshua Wootonn's sidebar-animation study (read) animates a sidebar `width`
0→auto with framer-motion and measures: fine on a clear main thread, dropped
frames then visible slowdown as main-thread load rises (M1 Mac mini). It then
dissects Notion's sidebar: a `position: relative` container animates `width`
while the sidebar itself is `position: absolute` and slides via `transformX`
— absolute positioning "removes the sidebar from the document flow … the
sidebar content doesn't reflow as the width animates." Caveat documented in
the same piece: Notion drives it with JS animation, so its main thread still
spikes during the transition — only CSS/WAAPI transform animation fully
escapes the main thread.
*Source:* https://www.joshuawootonn.com/sidebar-animation-performance
*Effect (measured by the author):* width-driven sidebar animation degrades
with main-thread load; transform-with-absolute-positioning degrades less but
still needs compositor-driven animation to be immune.
*Why a sidebar toggle is specifically expensive here (synthesis):* unlike an
overlay, it resizes every sibling pane — re-laying-out the flex/grid tree and,
in this app, re-flowing terminal emulators (restty/WebGPU) and editors, each
of which re-measures and repaints. That multiplies one layout pass into N
expensive subtree reflows (xterm-style grids reflow text; canvases resize
backing stores), which is why the symptom shows on open/close rather than on
hover or selection changes.

#### Concurrency budgets

**B4.1 — Industry default: derive from CPU count; Volli's hint matches, then goes further.**
ninja: default parallel jobs derived from available CPUs (man page, read).
Volli's `VOLLI_CONCURRENCY_HINT` (CLAUDE.md:63): machine cores divided by the
Sessions working when this one started, exported in the spellings toolchains
already read (`CARGO_BUILD_JOBS`, `MAKEFLAGS`, `CMAKE_BUILD_PARALLEL_LEVEL`,
`GOFLAGS`, `PYTEST_XDIST_AUTO_NUM_WORKERS`, `UV_THREADPOOL_SIZE`,
`GRADLE_OPTS`, `VITEST_MAX_WORKERS`), computed per session in
`apps/desktop/src/main/session-concurrency.ts` (via
`readSessionConcurrencyEnv`) and injected into PTY env at spawn
(pty/manager.ts:355 `sessionConcurrencyEnv`).
*Sources:* https://manpages.org/ninja · CLAUDE.md:63 (repo)
*Effect:* the hint meets the published norm (cores-derived default) and
exceeds it (divided by live-session count — the correction Kitware's MSVC
warning (B1.3) shows is necessary when N independent tools each assume they
own the machine).

**Is the hint enough? No — it is necessary but covers one of three load axes.**
What it does: caps *child-process CPU fan-out* for cooperating toolchains, and
children inherit it via env. Gaps, each grounded above: (1) tools that read no
env var ignore it (CLAUDE.md itself says to pass `-j` by hand); uncapped
fan-out is exactly VS Code's rg problem (B1.3). (2) It does not lower *priority*
— 8 background-nice builds still contend equally with the UI on saturated
cores; nothing here uses `PRIO_DARWIN_BG`/QoS-clamp (B1.1–B1.2). (3) It does
not touch *main-process* work (SQLite, git/worktree ops, PTY fan-out) or
*renderer main-thread* work (layout-driven animations) — the two jank paths in
B2.1/B3. Budget caps keep total load ≤ machine; priority keeps the UI's share
first; compositor-only animation keeps frames off the contended thread. The
app needs all three; it has one.

### B.2 Applicable to Volli

- **Main-process contention (B2.1):** audit what runs synchronously on main
around builds/tests — better-sqlite3 writes (main-owned DB), worktree git
ops (`ensure`, worktree/ensure.ts:237), PTY data fan-out
(pty/manager.ts output pipeline), Pi-runtime hosting — against the tutorial's
"never block main / never sync IPC" rules. Every `window.api.*` round trip
that blocks on one of these stalls the renderer interaction that issued it.
- **Priority (B1.1–B1.2):** `sessionConcurrencyEnv` (pty/manager.ts:355) is
the single choke point where every terminal shell's env is composed — the
natural place to also wrap heavy children (`taskpolicy -c utility`/`-b`) or
call `os.setPriority` on spawned pids. Children inherit (B1.1), so one change
covers grandchildren (compilers, test runners).
- **Sidebar/terminal jank (B3.1–B3.3):** check whether sidebar open/close (and
any resizable split) animates `width`/flex-basis vs `transform`; whether
terminal/editor siblings reflow per frame during it; and whether
`getBoundingClientRect`/`offsetWidth` reads interleave with those writes
(B3.2's forced-layout warning). The Notion container-plus-absolute-panel
pattern (B3.3) is the citable template if the sidebar must push content; an
overlay + compositor-driven transform is cheaper still.
- **Budget hardening (B4.1):** extend the hint's coverage (pass-through for
tools that don't read env, e.g. explicit `-j` in agent-invoked commands),
verify agent-spawned grandchildren actually inherit the PTY env through the Pi
`execute` path (not just interactive shells), and consider a load-average
guard in the style of ninja's `-l` ("do not start new jobs if load average is
greater than N", man page, read) for kicking off new heavy work while N
sessions already build.

---

## Sources (every URL read; failures marked)

*Agent-session lifecycle:*
1. https://code.claude.com/docs/en/sessions
2. https://openai-codex.mintlify.app/cli/resume
3. https://github.com/openai/codex/issues/2080
4. https://zed.dev/docs/ai/agent-panel
5. https://github.com/Callum-Ward/cursaves/blob/main/docs/how-cursor-stores-chats.md
6. https://forum.cursor.com/t/drafted-message-in-new-agent-tab-is-lost-cleared-when-switching-to-previous-chats/161643
7. https://raw.githubusercontent.com/continuedev/continue/main/extensions/cli/src/session.ts
8. https://aider.chat/docs/config/options.html
9. https://github.com/dayearleo/windsurf-local-user-data-decryption (unofficial reverse-engineering; attributed as such)
10. https://github.com/continuedev/continue/blob/main/core/util/history.ts — FETCH FAILED (page chrome only, no file content returned); not cited.

*Provisional-entity pattern:*
11. https://linear.app/docs/creating-issues
12. https://www.notion.com/blog/data-model-behind-notion
13. https://support.google.com/mail/answer/9259768?hl=en
14. https://developers.google.com/workspace/gmail/api/guides/drafts
15. https://slack.com/blog/productivity/in-case-you-missed-it-drafts-email-dark-mode
16. https://help.figma.com/hc/en-us/articles/360038511153-Create-a-new-file
17. https://help.figma.com/hc/en-us/articles/14381406380183-Guide-to-the-file-browser
18. https://martinfowler.com/eaaDev/EventSourcing.html

*Performance:*
19. https://ss64.com/mac/taskpolicy.html (redirected from …/osx/taskpolicy.html)
20. https://manpages.org/ninja
21. https://www.kitware.com/cmake-building-with-all-your-cores/
22. https://github.com/microsoft/vscode/issues/206030
23. https://www.electronjs.org/docs/latest/tutorial/performance (redirected from electronjs.org)
24. https://web.dev/articles/stick-to-compositor-only-properties-and-manage-layer-count
25. https://developer.chrome.com/blog/performant-expand-and-collapse
26. https://www.joshuawootonn.com/sidebar-animation-performance
27. https://developers.google.com/web/fundamentals/performance/rendering/avoid-large-complex-layouts-and-layer-thrashing — FETCH FAILED (redirected to web.dev home); not cited.

*Deliberately not cited:* JetBrains/Xcode background-indexer priority
(no citable primary source found); GPU-process contention beyond main-transit
and `backgroundThrottling` exact behavior (docs not read); Node
`os.setPriority` semantics beyond local runtime verification (API page not
fetched); Windsurf official docs surfaced by search but not read.
