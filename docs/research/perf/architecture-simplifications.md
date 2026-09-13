# Architecture simplifications: stop doing work we do not need

VC-360 · 2026-09-13 · source baseline `09acc82e67c810d48e791d80b1605e86daa224d9`

**Proposal, not an implementation or performance result. Application source is unchanged.**

## Executive summary

**Make a composer cheap by not making it a Session.** Finish VC-358 rather than adding another Session optimization. Today `+ Chat` immediately creates durable identity and starts attachment in the background; an abandoned empty composer consequently buys Session history, model/tool-surface recording, worktree preparation and runtime initialization. A draft promoted on first send removes that entire abandoned-work path. Identity-before-execution still holds: a draft is not an executor or a Session. Confidence in the removed work is high; the abandoned-session share and interaction-time saving remain unmeasured. Keep automatic/agent-created Sessions immediate and keep unsent words recoverable.

**Make persistence subscribe to persistent state, not every store mutation.** The existing 200 ms debounce saves IPC writes but runs after JSON serialization. Settings dialogs, terminal focus and navigation history still enter persistence even though their fields are explicitly excluded from disk. Stop those actions before projection/serialization rather than add another debounce or merge Zustand stores. Keep the same stored envelopes and project ownership; do not replace the acknowledged draft outbox with best-effort preferences. This removes a category of work with no intended product loss. Source confidence is high; VC-354's profile must establish whether its interaction-time benefit is large or merely tidy.

**Stop using the boot payload as the planning-refresh API.** A ticket invalidation sends only scope, but each renderer responds by fetching all projects, tickets, labels **and all `app_state`**, then ignores `app_state`. The first subtraction is a planning-only snapshot: preserve wholesale planning recovery while removing preferences/drafts from recurring reads and clones. The later, more invasive step is scoped planning projections when a domain surface is touched—not a big-bang IPC rewrite. The two IPC surfaces are converging in ownership, unevenly in transport; replacing `invoke` with tRPC everywhere does not itself remove any payload or database work.

## Evidence and limits

### What was read and checked

- VC-360's body and full program-map comment; all VC-353–VC-359 comment streams, with particular attention to VC-353, VC-354 and VC-355; relevant history on VC-38, VC-325, VC-326, VC-340 and the current ticket inventory to avoid duplicate follow-ups.
- `AGENTS.md`, `CLAUDE.md`, `CONTEXT.md`, `docs/BOUNDARIES.md`; implementation comments, codecs, reducers, consumers and tests around the six questions below.
- All four supplied prior-research documents, read **reference-only** from the main checkout's `docs/research/perf/`: `electron-app-prior-art.md`, `react-zustand-streaming.md`, `ipc-rpc-sqlite.md`, and `ephemeral-sessions-and-load.md`. Their external measurements are attributed prior research, not experiments rerun here. Their source assertions were checked where used; several need the corrections below. VC-353 was asked to retain the shared research with its harness rather than have multiple branches claim it.
- `rg` source/consumer searches, tracked-file line census, focused `git log`, `git worktree list --porcelain`, and `volli conflicts`. No profile database, credential store or worktree contents outside this checkout were inspected; no cleanup was performed.
- One **index-only structural experiment** using Python 3.14.3 / SQLite 3.53.3, arm64 macOS 26.5.1: execute the exact `MIGRATION_042_CREATE_SESSION_COMMAND_RECEIPTS` SQL in `:memory:`, inspect indexes, compare three query plans with/without the redundant named index. No application dependencies, full migration chain, Electron runtime or production SQLite driver were used. Results are recorded in P4, not offered as a latency benchmark.

**Measurement checkpoint: 2026-09-13 13:45 UTC.** The program comments available during this review contain coordination but no VC-353 real-fixture idle/load baseline, VC-354 re-render/persistence profile, or VC-355 new SQLite/RPC results. All seven neighboring comment streams were checked again at that checkpoint; VC-357 reported that the existing instruments still separate streaming from scrolling, and VC-354 was awaiting the shared baseline. No combined-interaction result can therefore be imported into this review yet. Thus the recommendations below are structurally costed, not measured speedups. Missing measurements are explicit implementation gates, not evidence that a suspected hotspot exists. In particular, there is no defensible verdict yet that synchronous SQLite must leave main, or that a particular store is the dominant renderer cost.

The prior RPC research reports a synthetic 120k-row `.all()` scan at approximately 290 ms / +109 MB heap and an indexed 1,714-row read at approximately 2 ms. Its approximately 630 ms figure at 260k is an **extrapolation**, not an app measurement; neither figure measures a Session open or renderer dropped frames. It supports avoiding full-log materialization, not abandoning event sourcing.

### Correct the starting map before spending against it

| Starting concern | Source-verified qualification |
| --- | --- |
| Agent-runtime is approximately 53k lines | Tracked TS/TSX/MJS/CJS: 55,642 lines; 35,856 in test/bench-named files or `bench/`, 19,786 remainder. Shared: 68,355 total, 32,273 test/bench, 36,082 remainder. These are source counts, **not shipped bundle weights**. |
| Nineteen stores | Nineteen exported store singletons, in nineteen store-directory source files: `mutate.ts` is a helper, while `sessions.ts` contains two stores. Three use Zustand `persist`: `ui`, `workspace`, `chat-drafts`; others have explicit write-through or are ephemeral. |
| Every open refolds 259,855 events | Runtime `#history` is **per Session**, with an eight-entry LRU and 500-row pages (`session-runtime.ts:624-650,2956-2984`). A cold long Session refolds its own history. Separately, engine `getSession` and `listSessions` refold without that runtime cache (`session-engine.ts:580-600`); the activity watcher calls the former. Checkpoints must account for both paths. |
| `session_event_sequence` and `session_event_sequence_match` are two duplicate tables | The first is a total-order sidecar table; the second is its `(session_id, kind, sequence)` **index**, not another ledger. They solve different query needs. The supplied 29 MB + 18 MB describes storage at an earlier profile snapshot, not a reclaimable 47 MB. |
| Broadcasts send the full planning snapshot | `broadcast.ts:26-39` sends a small invalidation. The **receiver** invokes bootstrap (`renderer/src/main.tsx:227-248`, `lib/boot.ts:77-115`), which produces the full payload. Optimize the resulting read, not a nonexistent huge event envelope. |
| JSON-safety validation runs on every RPC call | `SessionRouterJsonSafety` (`session-rpc/src/index.ts:1020-1027`) is an erased TypeScript assertion. Its runtime cost is zero. Zod input/output `.parse` calls are separate, real work. |
| Fifty worktrees means fifty live watchers | This review observed **69 git registrations including the primary checkout**, not 69 extant, live or watched directories. `volli conflicts` also reported missing/stale registrations; path overlap is not a measured merge conflict. VC-337 already shares one watcher per root and disarms it when no foreground subscriber remains. |
| Worktrees lack a lifecycle | `ensure` is lazy and single-flight; VC-113 supplies Done-dwell reclaim; VC-340 supplies trim-on-finish and manual trim; VC-284 separates inspection from confirmed orphan cleanup. The lifecycle exists. Admission and its recurring candidate set deserve scrutiny, not a second cleanup system. |

Source-size method: count lines in `git ls-files` matching the four language suffixes; classify `.(test|spec|bench).` and `/bench/` as test/bench. Fixtures outside that naming convention remain in the remainder. Counts do not imply all remaining code is runtime-loaded.

## Ranked proposals

Ranking uses **(benefit × confidence) / risk**. Benefit and risk are ordinal 1–5 judgments; confidence is confidence in the stated structural saving, not a probability of achieving a specific FPS result. Scores make the ordering contestable rather than disguise it as measurement. Implementation effort is an engineering estimate, not measured elapsed work.

| Rank | Proposal | B | C | R | Score | Route |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| 1 | P1: first-send Session admission | 5 | .95 | 3 | 1.58 | Existing VC-358; no duplicate |
| 2 | P2: persistent-slice-only persistence | 3 | .90 | 2 | 1.35 | VC-361, follow-up to VC-354 |
| 3 | P3: planning refresh without boot-only state | 3 | .85 | 2 | 1.28 | VC-362, bounded planning projection |
| 4 | P4: delete redundant receipt index | 1 | .95 | 1 | .95 | Finding handed to VC-355, not another architecture ticket |
| 5 | P5: retire unproduced event capabilities | 1 | .80 | 2 | .40 | Small deletion candidate; not scheduled |
| 6 | P6: stop recurring reads of settled worktree PRs | 2 | .55 | 3 | .37 | Opinion pending candidate census/product decision; VC-38 |

### P1 — Admit a Session on first send, not empty tab creation

**Cost today.** `renderer/src/stores/chat-sessions.ts:200-260` calls create, seeds a slice, connects a resident client and starts attach. `main/session-runtime/sessions.ts` owns mint/attach; `worktree/ensure.ts:1-23,237-256` can materialize the ticket checkout; `session-runtime/pi-adapter.ts:651-703` constructs a binding and calls `runtime.startSession`. An abandoned draft currently pays this setup without delivering any user work. A reused worktree does **not** necessarily create another directory or rerun its copy/setup steps. The app-wide Pi/model-access host still exists; this proposal removes per-Session attachment work, not that global host.

**Remove/save.** Zero Session creates, attachment attempts, client subscriptions and worktree ensures for an abandoned empty composer. For a sent composer the setup is deferred, not eliminated. Saved standing history is proportional to the measured number of abandoned creates, which is not known yet. VC-358 must count contentful versus abandoned Sessions without equating “no user text” with “no automated work.” Effort estimate: 1–2 weeks including promotion races and UI compatibility, already owned by VC-358.

**Opposing argument.** `CLAUDE.md`: “A Session is durable and owns identity and ordered local history before any live executor attaches.” `chat-sessions.ts:233-242`: “The Session is durable and addressable NOW”—the optimistic-open path is deliberate. Neither requires a blank composer to be a Session. Preserve mint-before-attach and the starting/queue/release protocol after promotion; do not turn `session.create` into a nondurable operation.

**Risk / breakage.** Unsent words or files lost on navigation; duplicated first sends; broken active-tab/split-pane identity; a worktree failure discovered later; automated creators waiting forever for a human send. A client UUID is a useful target, **not an assertion about the current create API**: the reviewed renderer receives a server-created id. VC-358 must settle stable draft identity versus supported id reservation before implementing, preserve command idempotency and frozen durable derivations, and enumerate kickoff, Automation, `session_start` and subagent entry points. Terminals still need a PTY immediately; do not silently apply the chat rule to them.

**Confidence / gate.** High (.95) that admission removes unused setup; unknown latency and abandoned fraction. Require the real-fixture idle/load create interaction and draft crash/retry tests. Historical empty Sessions are not deletion candidates merely because new empty tabs cease creating them.

### P2 — Only changes to durable UI state enter persistence

**Cost today.** `ui.ts:490-602` puts persistent preferences and transient modal/focus fields under the same persist middleware. `workspace.ts:2330-2429` persists a `byProject` projection after navigation-history actions that do not change any persisted field. Its `partialize` performs `Object.entries → filter → map → Object.fromEntries`, then `createJSONStorage` serializes the result. Every relevant `set` pays this before `app-state-storage.ts:45-86,143-153` can debounce the eventual IPC write. The adapter neither compares serialized values nor avoids scheduling identical ones.

For N transient actions over a workspace blob of size S and P project records, the current path can perform N full projections/serializations, roughly O(N × (P + S)). IPC/UPSERT count is already coalesced: it is **not necessarily N**. Isolated actions more than 200 ms apart can still persist identical bytes. No benchmark of S or N from the owner's profile is available.

**Remove/save.** Give persistence one subscription/gate over the persisted slice, ahead of serialization. Unchanged persistent state produces **zero serialization and zero scheduled IPC writes**. Do not ask each new action author to remember another ad-hoc no-op guard. Preserve the public actions, stored keys, version-1 envelopes, sanitizers and one-project lifetime; a stable persisted projection is not a second canonical store to synchronize. Start with `ui` and `workspace`, not the draft outbox. Effort estimate: 2–4 engineering days plus VC-354's acceptance profile. Some cheap selector comparisons may remain; do not claim this eliminates all selector execution.

**Opposing arguments, both correct.** `ui.ts:546-552` already says “Nothing to drop means NO `set` at all” because persist wraps even an empty patch. That proves the cost is known; it does not protect transient actions elsewhere. `workspace.ts:7-9` argues for one record per project so “everything a workspace remembers lives and dies together.” Keep that ownership. Splitting into per-field stores to solve serialization would buy a second cleanup problem.

`app-state-storage.ts:45-51` explains why only the last value per key must reach SQLite after a resize burst. Keep that debounce for **real preference changes**; moving it later or lengthening it cannot recover CPU already spent serializing.

**Risk / breakage.** A gate missing a newly persistent field silently loses preferences. Test every persisted field through relaunch and keep an exhaustive typed boundary; test transient actions against a serialization/storage spy, not only against equal final bytes. Preserve in-order writes, failures/toasts, boot hydration and shutdown flush. `flushPendingAppStateKey` is an acknowledgement barrier for held messages, not incidental queue plumbing; no proposed equality shortcut may invent a successful durable acknowledgement after a failed write.

**Confidence / gate.** High (.90) structural saving; medium/unknown user-visible benefit. VC-354 owns the before/after serialization, UPSERT and re-render profile. If it already implements this outcome, close the follow-up as absorbed, not as a second store refactor.

### P3 — A planning change should not fetch preferences and drafts

**Cost today.** `main/data-ipc.ts:245-262` builds bootstrap from projects, **all app_state**, all tickets and all labels. Every `data.onChanged` invokes `refreshPlanningData`; it extracts only `{ projects, ticketsByProject, labelsByProject }` (`lib/boot.ts:83-96`). There is no in-flight join at that listener. Even a scoped comment change can therefore initiate a whole-bootstrap read/clone and new board/project objects. With W windows and M invalidations, this path can cause W × M bootstrap calls. This is a source-derived upper-path count, not an observed workload rate.

**Remove/save, bounded first slice.** Expose a JSON-safe **planning-only snapshot** through a command/projection-shaped host edge and have recurring refresh use it. Leave bootstrap for initial hydration/import/recovery. Every recurring call then omits one `getAllAppState` read and the entire app-state string payload from serialization/clone; if that payload is A bytes, approximately W × M × A logical payload bytes disappear before wire overhead. A has not been measured. Keep the initial slice a whole-planning snapshot: it does not need a delta protocol, new ledger, cursor or cache table. Estimate: 2–4 engineering days including transport and refresh regression tests.

**Opposing argument.** `lib/boot.ts:58-66` explicitly says the board hydrate is “always wholesale (the recovery guarantee).” Agreed: a window can miss a push. The initial proposal keeps wholesale **planning** recovery; unrelated persistent UI blobs do not make that guarantee stronger. `data-ipc.ts:330-339` also explains why a worktree invalidation precedes its mutation reply: the refresh repairs optimistic state after a partially successful mutation. Preserve that ordering and `lib/boot.ts`'s invalidate-before/read-after venue handling, including failures.

**Later, conditional slice—not part of the initial ticket.** If VC-353/354/355 show all-project board hydration is significant, use scoped ticket/project snapshots with a revision/gap and full-recovery story. Coalesce simultaneous invalidations only while preserving the union of scopes and follow-up reads for mutations arriving in flight. Otherwise a fast response can erase a newer change. This is appreciably riskier than removing app_state; no latency saving is claimed or separate backlog tree filed for it.

**Risk / breakage.** Lost notifications, stale labels or project selection, optimistic mutations overwritten, worktree caption/venue regressions. Preserve error surfaces and full bootstrap fallback. “One door” means one domain contract; do not move planning rules into Electron dispatch or insist that a package named session-rpc must own every domain.

**Confidence / gate.** High (.85) that the payload is unused on this path, unknown byte/time magnitude. Measure bootstrap call count and app-state versus planning bytes under a mutation burst in both load arms; prove recurring refresh no longer reads/transmits app_state and planning recovery remains identical.

### P4 — Delete `session_receipts_command_sequence`, not the wake indexes

**Cost today.** Migration 042 (`main/db/migrations.ts:1845-1861`) retains both `UNIQUE(command_id, sequence)` and the named index `session_receipts_command_sequence(command_id, sequence)`. One duplicate B-tree entry per receipt, plus maintenance on every receipt insertion/deletion. Actual bytes and write latency are unmeasured. This is separate from `session_events_session_sequence`, whose duplicate was **already removed** in VC-326.

**Remove/save.** A new forward migration can drop the redundant named index. Do not edit shipped migration 042; databases already at head would not run it again. Keep the UNIQUE constraint and the genuinely different session-scoped receipt index. Saving: exactly one secondary B-tree's storage and maintenance; disk shrink may await existing compaction policy, not the DROP itself. Estimate: less than a day for migration/plan/integrity tests, no application query rewrite.

**Evidence / opposing argument.** Indexed ordered receipt lookup and idempotent acceptance are required, not optional. The retained autoindex has identical key columns/order. `rg` found no production name-dependent `INDEXED BY` consumer. The in-memory schema experiment found:

| Query shape | Before drop | After drop |
| --- | --- | --- |
| command receipts ordered by sequence | SEARCH named index | SEARCH `sqlite_autoindex_session_command_receipts_2` |
| command `MAX(sequence)` | COVERING named index | COVERING same autoindex |
| Session receipts ordered by sequence | session-scoped index | unchanged |

This proves index equivalence under that SQLite version/schema, not production migration safety. VC-355 received the finding and the request for production-driver `EXPLAIN`, `dbstat`, FK/integrity and receipt tests. Risk low; confidence .95 in redundancy. No separate ticket for a one-index fix already in the SQLite lane.

### P5 — Retire three unproduced event capabilities, without rewriting history

**Precisely what appears dead.** Searches across app and package TS/TSX/MJS find no production producer of Session `adapter.observed`, `run.started` or `run.completed`; hits are shared declarations/translation/codec/reducer plumbing and fixtures, plus a smoke vocabulary check. Do not confuse them with **Automation** `automation.run.completed`, which is live. The structured runtime emits turn boundaries and settled activity messages instead.

**Cost / saving.** Three live-authoring union arms remain in `shared/src/session-ledger.ts:643-644,745-750,843-858`; their mapping arms, three codec entries (`session-event-codec.ts:279-295,445-455`) and fixtures keep a capability available that nothing ships a producer for. Removing that capability saves dozens of production lines and associated fixture cases, plus future exhaustive-handling obligations. It saves **zero current live event writes**, because no current producer was found. Historical counts/bytes are unknown and are not claimed as reclaimable. Estimate: 1–2 days to retire carefully with replay/backup/cursor regression coverage.

**Opposing argument.** `session-ledger.ts:1630-1648`: “Runs and transcript references are the transcript's shape, read from the event stream directly”; “`adapter.observed` is adapter evidence that no projected field is derived from.” The first sentence requires checking stream consumers, not just the projection switch. Those searches found no production handler for the three kinds; they do not prove no old backup carries them. `session-event-codec.ts:12-19` supplies the compatible direction: a kind must be retireable, and unknown-kind tolerance is distinct from corruption.

**Risk / confidence.** Medium risk; .80 confidence in absent current producers, lower confidence in retiring every old read without semantic loss. Keep historical bytes and raw backup/export fidelity. Verify trailing retired events, page refill, cursor monotonicity and unknown-kind behavior on **every** reader before deleting codecs; a codec-only removal is not enough. In particular, `main/db/session-events-cursor-repo.ts:194-212` directly decodes the payload with no local unknown-kind catch, unlike the ordinary ledger's refill path; retirement cannot assume every caller already implements tolerant reads. Do not turn malformed known kinds into ignorable history. This is a modest cleanup opportunity, not a performance-program headline, so no ticket is filed now.

### P6 — Bound recurring worktree PR observation by live demand

**Cost today.** `db/tickets-repo.ts:402-416` admits every nonarchived ticket with a branch or path to retention polling. `worktree/watch.ts:51,245-359` rediscovers/reads PRs on a nominal 60-second cycle with failure backoff. A merged PR stays in that set while its ticket remains unarchived—even after directory reclaim, because the branch is deliberately kept. For K such entries the successful steady-state upper cadence is approximately K `gh pr view` calls/minute, subject to poll duration; K and process CPU are not measured here.

**Remove/save.** Treat a durably known merge **for the same PR URL/identity** as settled retention evidence, and refresh current checks only when an interested surface explicitly needs them. Keep local Done/Keep/busy/trim/reclaim gates live and cheap. The possible saving is those K background network/process reads, not K worktree directories or watchers. A changed PR identity invalidates settlement. Estimate: 3–5 days plus a candidate/process-count profile.

**Opposing argument.** `worktree/watch.ts:179-196` compares check **names and states**, not just failures/counts, because otherwise the rail reads “3 running” until something unrelated changes. Its header also deliberately keeps readiness transient so Keep and dismissal take effect immediately. Freezing the entire retention state would regress both. Only the irreversible merge fact may settle; live check visibility needs its own demand/freshness policy. Splitting those responsibilities may add more machinery than K justifies.

**Risk / confidence.** Medium risk; .55, an **opinion pending a census and the owner's freshness choice**, not a finding of material CPU cost. Commented onto VC-38 rather than filed as another cleanup system. Keep worktree-per-ticket for independent writers; shared mutable checkouts trade disk for concurrent-edit ambiguity already tracked by VC-266.

## Answers across the architecture

### IPC: converging semantics, still multiple active transports

The older surface is **not frozen**: recent source history includes trim/cleanup and watcher changes. It is not a parallel structured-executor implementation either. Ticket mutation handlers reuse `main/ticket-commands.ts`; orphan cleanup already has command/fact/receipt shape (migration 043's argument at `migrations.ts:1864-1878`). Session create/attach and model access use the tRPC edge, while Session listings/usage and host resources still have semantic IPC handlers. `ipc-descriptors.ts` has 165 channel-key declarations; its 1,940 lines and `data-ipc.ts`'s 1,746 lines include validation, host facilities and unrelated domains, not 3,686 deletable lines of duplicate Session logic.

`BOUNDARIES.md` is explicit: “The existing raw channels migrate opportunistically when a surface is touched — never as a big-bang rewrite.” This defeats a “finish all transport convergence” performance ticket. Merely translating every channel requires contracts, validators, dispatch, preload/client and test changes for each family, while retaining terminal/window/filesystem host capabilities. Rough engineering estimate: **several engineer-weeks**, not a weekend deletion; no measured CPU saving supports it. P3 is a small domain-shaped step that removes bytes now. Keep desktop-owned guards out of `@volli/shared`; the descriptor header explains the main-only runtime graph and dependency-disjoint preload bundles.

### Stores: ownership boundaries are mostly credible; write cadence is the mismatch

The nineteen stores cover different lifetimes: durable planning projections (`board`, `projects`), resident Session clients (`chat-sessions`), terminal containers and a separate harness catalog (`sessions`), listing baselines (`project-sessions`, `ticket-session-records`), draft intent (`chat-drafts`), ephemeral host resources (`browser-tabs`, `background-shells`, worktree/venue state), and preferences/view state. Their co-consumption in `ActiveSessions` is composition, not proof of duplicate ownership.

There are genuine coarse subscriptions at `components/sidebar/active-sessions.tsx:103-118` (`byOwner`, `openTabs`, `parkState`, `harness`). But that file already separates age and listing clocks, narrows output stamps by project, and reads a shared push-fed baseline. `stores/sessions.ts:697-708` routes output O(1) and throttles at one second. `chat-sessions.ts:172-176` preserves unchanged per-Session slice identity. No profile yet proves a merge will help; a merge would make more subscribers inspect every stream update. P2 attacks the demonstrated persistent/transient mismatch without changing ownership. VC-354 must decide finer subscription boundaries from its profile, not the store count.

### Ledger: the standing bill is real, but telemetry is mostly already excluded

For one accepted durable event, the current append path (`main/session-control/sqlite-ledger.ts:371-450`) validates/encodes, checks identity/order/FKs, interns provenance, inserts the event, and lets the sequence trigger append the wake sidecar. At schema head, the event row maintains **five indexes** (id primary-key autoindex, two UNIQUE autoindexes, command and attachment indexes); the wake row maintains its INTEGER primary-key table plus event-id uniqueness and the match index. AUTOINCREMENT also maintains its high-water state. Usage facts additionally insert an indexed `session_usage` row in the same transaction; receipt facts pair with and link the receipt table. Transcript facts additionally write a content-addressed artifact. These are logical writes/index obligations, **not a measured physical WAL-byte multiplier**—pages can be shared and batched.

On reads, SQLite access, payload/provenance decoding, folding, artifact reads and clone are distinct costs. The runtime caches eight histories, while direct engine reads can refold outside that cache. `snapshot` includes historical frames/artifacts; `projection` deliberately omits them (`session-rpc/src/index.ts:765-777`). A checkpoint can remove old projection replay, but it cannot by itself eliminate fetching all transcript content for a snapshot. VC-355 owns checkpoint/metadata-first/large-read work; creating another projection framework here would duplicate that effort.

The authoritative live/transient split is already `observation-translation.ts:1-26,75-144`: text deltas and compaction progress are live overlays, not durable events, and do not advance reconciliation cursors. `stream-cost.bench.test.ts:24-45` pins 39 deltas plus two activities to 41 overlays and three settled durable messages, not 39 transcript artifacts. Usage-limit windows and live shells/browser state are also transient; usage operations, refusals, questions/answers and recovery are not telemetry just because they are numerous. P5 names the small residual unused authoring vocabulary; it does not establish a large removable slice of 259,855 historical events.

The frozen-id tax is a real constraint on changes: exact strings are deduplication/recovery keys, not labels. VC-326's carefully verified rewrite/interning/compaction history shows a migration can buy storage without weakening facts; its comments report 425 MB → 241 MB on a **copy** with identical content digest. That is an attributed earlier result, not this review's current profile measurement or a new saving to claim.

### Worktrees: a lifecycle, not a new default topology

Current lifecycle: absent → `ensure` on execution (single-flight, existing branch reused) → active → finished artifact trim → Done-dwell reclaim after the default 14 days, subject to Keep/busy/dirty/PR checks → recreate on the retained branch. Orphan inspection and confirmed metadata cleanup are separate. `worktree/retention.ts:198-220` explains why “clean after push” does **not** mean disposable: review is exactly when the person comes back. `trim-sweep.ts:11-23` explains why `git worktree prune`, which cannot target a path, must not be smuggled into a different cleanup action.

Thus the proposed admission change P1 and possible recurring-read change P6 are complements, not an excuse to replace the lifecycle. No automatic migration to shared checkouts, shortened TTL, forced trimming, worktree deletion or dependency symlinking is proposed. Physical disk savings from pnpm hardlinks cannot be inferred by multiplying per-directory apparent sizes. The current watcher code already avoids the “every checkout is always watched” topology.

## Considered and rejected

### Replace event sourcing with mutable Session rows

This would remove replay machinery but would also erase the evidence needed for idempotent accepted work, historical edits/attempts, resumed interactions, authority attribution and retry reconciliation. `CLAUDE.md`: “Persist intent before delivery; make acceptance idempotent and observable through durable receipts.” An outbox plus audit tables would quickly recreate the same mechanisms under other names. The prior 2 ms indexed-session probe is evidence against calling SQLite's basic topology broken; the missing baseline cannot be filled with the 260k full-scan extrapolation. Keep the ledger and make read work proportional to the requested projection.

### Delete the 47 MB wake sidecar/index; use time or rowid

Migration 044 (`migrations.ts:1920-1979`) argues directly against this: per-Session sequence cannot order a fleet, timestamps can collide and are source metadata, and rowid may be reused after cascading deletion. `session-events-cursor-repo.ts:82-92` deliberately uses AUTOINCREMENT's high-water mark, not MAX, so deletion cannot move a cursor backwards. The match index answers owner/kind filtering; the primary key answers total-order draining. Neither is redundant with the event table's per-Session uniqueness. A same-transaction relocation of total order into the event table could theoretically remove a join, but it entails a large rebuild, cursor/high-water preservation and index redesign; it is not a free DROP and has no measured prize here.

Nor may we simply index only wakeable kinds: `session-wake.ts:31-40,118-139` drains committed events after each mutator, including facts committed before a later failure, and the cursor API can name the point before a Session or Command. Narrowing that contract requires an explicit design and event-kind distribution, not just noticing that most awaits ask for four outcomes.

### Treat usage, authority refusals or compactions as ephemeral telemetry

`shared/src/session-ledger.ts:724-771` explains both disagreements. A denial is Volli's recorded decision and contributes to authority fallback/Attention; it is not a failed tool action. Most spend produces no message—tool-only replies, billed failures, compaction and utility calls—so deriving spend from final transcript messages loses money. Compaction/reasoning-drop facts explain why the executor's context changed while history did not. Keep them durable. Exact rollback/crash behavior and historical attribution buy more than an unpriced event-count reduction.

### Delete the adapter facade, terminal registry, hooks or `adapterId`

`session-runtime/pi-adapter.ts:1-60` names the actual work: Session identity/role/brief resolution, interrupt-versus-release semantics, and parked questions settled by later commands. `NativeHarnessAdapter` is one injected port, not a selection registry. Removing the facade moves those obligations into the engine or Pi runtime; it does not remove them. The header's “one manifest id and one profile” is stale terminology, not evidence of a live profile registry. `PI_ADAPTER_ID` is aliased to the boot discriminator; `PI_DURABLE_ID_NAMESPACE` stays a separate frozen literal (`pi-adapter.ts:124-145`) because renaming an executor must not re-key history.

Terminal companions are still a product: `pty/ipc.ts:66-86` explains exact-hash trust versus mere slug validation; `agent-dispatch/harness-verbs.ts:145-189` updates terminal recovery detail from wrappers/hooks; `pty/manager.ts:956-980` records terminal exit. `boot-recovery.ts:162-178` still distinguishes Pi attachments from local terminal/retired attachments. Deleting `adapterId` would lose that distinction and require a migration without eliminating the need for a discriminator.

Precisely removable small residue: `createPiNativeAdapter` at `pi-adapter.ts:634-637` is a deprecated four-line convenience wrapper used only by `pi-adapter.test.ts` and `web/secrecy.test.ts`. Moving it into test support deletes one production export, not the adapter seam or any launch work. Not worth a standalone ticket. P5 is the more meaningful obsolete-capability audit. No live structured registry or lab backend adapter was found to delete.

### Merge stores because the sidebar reads several of them

`ActiveSessions` reads terminal output, durable Session listings, ticket ownership and view selection because it displays their intersection. These states do not have the same owner or write cadence. The O(1) output routing, one-second throttle, project-scoped primitive stamps and separate age/listing clocks are counterevidence to a naive per-token-all-sidebar-renders story. A single merged store would widen selector execution and couple ephemeral resources to durable state. Without VC-354's profile, store-count reduction is cosmetic; P2 is the narrower structural correction.

### Persist one draft row per Session; remove the acknowledged outbox

`chat-drafts.ts:16-36` explains why held messages are not redundant with the input box and why one bounded blob was chosen: `app_state` has no delete channel, so per-Session keys would leave permanent empty rows after clearing. The 50-draft cap is deliberate. Normal input typing can be batched, but clearing the user's last source before durable acceptance cannot. `app-state-storage.ts:64-74,103-118` serializes writes and exposes a key-specific acknowledgement barrier. Keep those semantics; splitting rows is a schema/lifecycle proposal with a new cleanup duty, not the cheap answer to P2.

### Replace the tail window/scroll machinery or keep all chat DOM alive

`components/chat/transcript-window.ts:10-17` explains why an anchored row is not replaceable by `slice(-60)`: appended rows would move the reader's place. Its 60-row tail/40-row reveals bound resting DOM; hidden chat planes unmount while resident clients/drafts survive. A full virtualizer adds measurement and scroll ownership; native anchoring alone must still prove prepends, disclosure height changes and reveal behavior. `<Activity>` for every hidden tab retains the DOM this design deliberately frees. The transcript and motion tickets must measure before choosing any of these; none is a cost-removing architectural shortcut established here.

Similarly, the rAF/timer race in `session-presentation/src/client.ts:296-332` is not an unnecessary timer: occluded windows stop receiving frame callbacks, and a queued send/Attention would otherwise stall until somebody looks. Keep live-model progress separate from hidden DOM.

### One global commit decorator instead of wake plus activity observers—defer

There really are two whole-engine decorators (`session-wake.ts`, `session-control/activity-watch.ts`) forwarding the same methods. But their comments distinguish two consumers: exact, uncoalesced committed facts versus 60 ms coalesced listing projections. Activity also delivers synchronous `observeBirth` before a first error fold to make Automation attention correct (`activity-watch.ts:103-122`). A later change could feed activity from the global post-commit bus and remove roughly one forwarding block, but merging delivery semantics would break wakes or first-error notification. Savings presently costed only as dozens of forwarding lines, not substantial runtime work. Do not replace two proven observers with a new abstraction solely to make the diagram smaller.

### Swap IPC transports, remove validators, or move every main service out

The prior research's small-call `invoke` and MessagePort floors are similar; VC-355 explicitly rules out a wholesale transport swap. `SessionRouterJsonSafety` is compile-time, and request guards enforce admission. Removing guards/sandboxing is not a performance strategy. A worker for a **measured** long SQLite/export task may protect main, but it introduces connection ownership, scheduling, cancellation, error and migration coordination; that is isolation, not cost removal. Batching a burst or excluding unused payload is the first experiment. Do not claim `.iterate()` yields the main event loop either: it bounds allocations, while a synchronous loop still blocks for its duration.

### Delete old migrations or the localStorage importer because this is canary software

Current version `0.2.0-canary.9` does not establish that nobody restores an older backup. `lib/boot.ts:139-205,242-283` explicitly preserves unreadable/failed imports so the user's only copy survives. The importer is reachable when projects are empty and legacy localStorage exists, not dead merely because this checkout's profile has already migrated. Its removal would delete the 70-line `shared/src/legacy-import.ts`, a substantial boot branch, main handler, descriptor, contract and tests—hundreds of maintenance lines—but virtually no ordinary post-migration boot I/O. That is a product-supported-upgrade-floor decision, not a perf finding. Archive it only after the owner specifies a supported restore path; do not silently remove it or silently clear unsupported data. Historical SQL migrations are likewise required to bring supported backups forward. Splitting the 2,827-line file changes review ergonomics, not runtime work.

### Delete all lab scratches or the largest packages

The tracked lab contains 21,525 TS/TSX lines, mostly fixture UI, but `CLAUDE.md` says it is “Dev-server only, never built; it imports the app, never the reverse.” The Vite lab-mode branch and source import search agree. Deleting it has **zero expected packaged renderer/main saving**. Chat/composer performance scratches remain useful instruments for this program; a shipped feature does not prove its regression gallery is abandoned. Retiring individually superseded galleries may save human maintenance, but no owner/use census supports a bulk deletion list here. Likewise approximately 64% of agent-runtime's counted source is test/bench. A large runtime doing authority, tools, prompt assembly, model access and recovery is not evidence for a smaller boundary until an actual duplicated obligation is named.

### Replace worktree-per-ticket or bypass the safe cleanup gates

`ensure.ts:15-22` records the VC-16 decision: async steps, no silent main-checkout fallback, creation-only copying. Replacing ticket isolation with one mutable checkout would eliminate duplicated working files but introduce concurrent edit/test contamination and unclear attribution. Subagents already share a parent's tree; VC-266 tracks that remaining safety issue. Shorter TTLs, ignoring Keep, deleting untracked config, or pruning unreviewed git metadata contradict the specific failures VC-113/284/340 fixed. These counterarguments defeat a second “automatic pruning” design. P6 asks whether we can stop **observing finished work unnecessarily**, not make more files eligible for deletion.

## Open questions for the owner

1. **Draft product shape:** is a typed-but-unsent chat a discoverable draft, or only an open tab? VC-358 already owns this fork. Should abandoned nonempty drafts be recoverable after explicit close, and for how long? Do not add a third “provisional Session” ledger state to avoid deciding.
2. **Supported history floor:** must a current canary directly import every pre-SQLite installation and restore every historical backup, or may very old installations use an explicit intermediate importer? This decides whether the localStorage compatibility path can actually be retired. It does not authorize deleting old user history.
3. **Finished PR freshness:** after a PR is merged, must an unviewed completed ticket keep live check reruns/current remote status every minute? If not, P6 can stop those reads while preserving on-demand refresh and local retention gates.
4. **Isolation versus storage:** should noncoding research/planning tickets explicitly opt out of worktrees, or should all Ticket Sessions retain isolated writable space? Keep the current default for writers unless product policy changes; do not infer “read-only” from a model's intent or ticket title.

No owner decision is required to preserve persistent UI semantics while skipping transient writes, or to stop fetching unused app_state on a planning refresh. Those are engineering changes with measurable acceptance criteria.

## Follow-up routing and validation

- **VC-358:** existing P1 implementation owner. Architecture argument linked in its comments; do not create another draft lifecycle ticket.
- **VC-361 (P2):** filed in Backlog as a follow-up to VC-354's measurement/implementation result, linked back to VC-360 and this section. If already satisfied there, close as absorbed.
- **VC-362 (P3):** filed in Backlog with the bounded planning-only snapshot scope, linked back to VC-360 and this section; VC-359 notified. No whole-IPC convergence epic.
- **VC-355:** P4's exact redundant-index finding, JSON-safety correction and engine-versus-runtime checkpoint caveat posted as comments; no source fix here.
- **VC-38:** P6 and the existing lifecycle evidence posted as a comment there; no duplicate pruning mechanism.
- P5, bulk lab retirement, legacy-import retirement and decorator consolidation are deliberately **not** additional tickets. The backlog should contain a few subtractions, not every considered architecture idea.

Validation for this document: source/call-site and counterargument review; index-only three-plan comparison; `git diff --check` and `git diff --cached --check`; local file-pointer/section and docs-only change checks. Application tests/typecheck/coverage are not claimed: no application source or runtime configuration changes were made, and no dependency-dependent command was needed. Implementation tickets must install dependencies and run the repository gates, with `$VOLLI_CONCURRENCY_HINT` supplied where explicit worker limits are required, plus the VC-353 before/after idle/load measurements relevant to their change.
