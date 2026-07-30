# Harness architecture v2

> **Superseded (2026-07-30).** Most of this plan was executed on this branch — the
> injection-kind renames (§4), the channel columns and their derivation (§2, §3), and the
> §5 deletions (`HarnessTier`, `detection`, `timeoutMs`) all landed. What did not land —
> the manifest-driven `hook-file` mechanism replacing `config-dir-env` (§1), and any
> further investment in hook-based capture — is **not to be resumed**: the direction is
> now a structured session engine (Agent SDK / ACP) whose events arrive natively, with
> the terminal demoted to an untracked utility surface. The hook/injection machinery in
> this branch is the bridge until that engine exists, kept working but not deepened.

`docs/plans/harness-events.md` designed the channel and it landed. This proposes what to
change now that it is running, against two capabilities:

1. Interpret events from the harnesses, so we can tell whether our automations are working.
2. Interpret whether a working session has material impact on the current ticket status, as
   surfaced in the left-hand inner sidebar.

The bias throughout is fewer moving parts. The plan must remove more than it adds; the
running total is kept honestly at the end of §5. The largest single recommendation is a
deletion — the three-value harness tier, which is the thing that currently lies about Cursor
— and the second largest is that **almost everything capability #1 needs is already on the
wire**, in a call that landed after this document was first drafted.

> Revised after an adversarial audit. §1, §4 and most of §5 stood; §2 and §6 are rewritten
> here. The rewrite turns on commit `c45d84e`, which added a synchronous per-launch
> `volli session harness <slug> [--mint]` call — see below.

## What is actually there today

Worth stating plainly, because two of these were surprises and the rest of the document
depends on them.

- **The adapter is pure data and that property holds.** `HarnessAdapter`
  (`packages/shared/src/harness/types.ts:227-276`) carries no methods and no closures, so a
  built-in and a manifest-registered harness are the same type
  (`packages/shared/src/harness/manifest.ts:602` builds one from JSON). The registry is a
  `ReadonlyMap` rather than a `Record<HarnessId, …>` precisely so a registered harness sits
  in it the way a built-in does (`packages/shared/src/harness/core.ts:22-27`). This is the
  seam the owner believes exists. It does, and it is good.
- **There are already two capability models, and they disagree.** One is per-session and
  in-memory (`SessionHarnessState`, `packages/shared/src/session.ts:254-289`); one is
  per-harness and durable in SQLite (`declared_events` / `verified_events`,
  `apps/desktop/src/main/db/harness-registry-repo.ts:23-26`).
- **The durable one is switched off for exactly the harnesses that lie.**
  `recordHarnessDelivery` opens with `if (isFirstClassHarnessId(harnessId)) return
  "verified";` (`apps/desktop/src/main/harness-registry.ts:280`). Claude Code, Codex, Cursor
  and Opencode never write a ledger row. The mechanism that would catch Cursor delivering
  nothing is disabled for Cursor.
- **No harness event moves a ticket.** `moveTicketCommand`
  (`apps/desktop/src/main/ticket-commands.ts:136`) has two callers: the drag/IPC path
  (`apps/desktop/src/main/data-ipc.ts:344`) and `volli ticket move`
  (`apps/desktop/src/main/agent-commands.ts:1714`). The hook path
  (`apps/desktop/src/main/agent-commands.ts:1205-1369`) writes a resume seed, a ledger row,
  at most one notification, and a renderer broadcast. `harness-events.md:203` promises
  "automatic board moves" for the Hooked tier; that promise was never built.
- **Every wrapped launch already calls the app, synchronously, exactly once.** `c45d84e`
  made the wrapper invoke `volli session harness <slug>` — with `--mint` when the adapter
  takes an id on argv, backgrounded otherwise (`packages/shared/src/harness/wrapper.ts:232-258`).
  Main handles it at `apps/desktop/src/main/agent-commands.ts:1140-1203`. **This is the
  launch boundary, and it is observable.** It changes the shape of the whole capability
  problem: a launch that bypassed the wrapper is now a *missing call*, not a timeout to be
  inferred from silence. Everything in §2 is built on it rather than beside it.
- **`HarnessTier` is not rendered anywhere.** `harnessTier()`
  (`packages/shared/src/harness/types.ts:302-307`) feeds `expectedTier`
  (`packages/shared/src/session.ts:267`) and nothing else. The three tier words appear in
  plan prose and in no UI string.

### Two corrections to the brief this work started from

**"`Waiting for you` is the literal string for both a PTY heuristic's guess and a
hook-verified fact"** — it is not. `sessionActivityState`
(`apps/desktop/src/renderer/src/stores/sessions.ts:151-163`) can only reach `waiting` via
its `declared` argument, which is only ever set by `receiveHarnessEvent`
(`packages/shared/src/session.ts:369`). Both `Waiting for you` strings
(`apps/desktop/src/renderer/src/components/sidebar/active-sessions.tsx:104` and the activity
label at `:39`) are hook-derived. The real collision in that slot is different and worse:
`Working` and `Idle` are PTY *guesses* rendered in the same position, weight and colour as
`Waiting for you`, which is a *fact*. Section 4 fixes that instead.

**A sixth defect, not on the list, and it ships today.** Codex binds no `session.started`
(`packages/shared/src/harness/codex.ts:57-83` — `turn.started`, `turn.completed`,
`permission.requested`, `input.needed`, nothing at launch), and neither does Opencode
(`packages/shared/src/harness/opencode.ts:36-46`). Both are `hooked` by `harnessTier`.
`sessionHarnessStatus` (`packages/shared/src/session.ts:411-431`) therefore flips them to
`activitySource: "silent"` twenty seconds after launch, and the sidebar renders `Codex · Not
reporting` (`active-sessions.tsx:112-113`) for a completely healthy Codex session that the
user simply has not typed into yet. Deriving liveness from a channel that only speaks when
the agent speaks produces a false accusation on two of four built-ins. Verified by reading
the adapters and the derivation; not verified against a running binary.

---

## 1. The seam

### Keep

The adapter stays pure data. The `ReadonlyMap` registry stays. `HarnessId` stays open.
`effectiveHarnessId` (`packages/shared/src/session.ts:99-103`) and the wrapper announce that
feeds it (`packages/shared/src/harness/wrapper.ts:179-181`) stay — "which harness is running
right now" is a question the launch record cannot answer and the wrapper can.

### The four injection kinds are not an abstraction

`HarnessConfigInjection` (`packages/shared/src/harness/types.ts:86-95`) has four kinds. Each
is used by exactly one built-in, and each is rendered by a hand-written function that encodes
that one binary's config schema:

| kind | sole user | renderer | what it actually hardcodes |
| --- | --- | --- | --- |
| `argv-settings-json` | claude-code | `claudeHooks` (`launch.ts:137-156`) | matcher groups, `timeout` in **seconds** |
| `argv-config-override` | codex | `codexHookOverrides` (`launch.ts:201-222`) | TOML inline tables, `async` |
| `config-dir-env` | cursor | `commandHooks` (`launch.ts:224-236`) | `{ "<Native>": [{ command }] }` |
| `plugin-config-env` | opencode | `renderEventPlugin` (`plugin.ts`) | a generated JavaScript module |

A kind name reads as a claim about a *mechanism* — "the harness takes a config directory from
an environment variable" — but it silently also fixes a *schema* and a *filename*. A BYO
harness declaring `config-dir-env` gets Cursor's hook schema written into Cursor's filename
whether or not that is its schema. There is no fifth harness in the world whose hook file
happens to be that shape at `$SOMEVAR/cli-config.json`.

And Cursor is not even the fourth. `config-dir-env` was derived from a misreading of Cursor:
`CURSOR_CONFIG_DIR` redirects `cli-config.json`, but `cursor-agent` reads hooks from a fixed
`hooks.json` ladder whose user entry ignores that variable. The generic name is what let the
mistake survive — it sounds like a fact about a mechanism class, so nobody re-checked it
against one binary.

**Recommendation S1 — name each kind after the binary it is a claim about.**
`claude-settings-json`, `codex-config-override`, `cursor-hooks-file`, `opencode-plugin`,
`none`. Exactly the same code, exactly the same switch in `injected()`
(`launch.ts:248-312`). What changes is that each arm is now a falsifiable statement about
one binary and one version, checkable by one live run, instead of a category that can be
wrong without looking wrong.

**Recommendation S2 — give BYO its own mechanism instead of a built-in's hand-me-down.**
One kind, and the only one a manifest may declare. It **replaces** `config-dir-env` rather
than joining it, so the kind count does not grow:

```ts
| { kind: "hook-file";
    /** Written under <userData>/harness/<slug>/. Content is the manifest's, verbatim,
     *  with {volliHook:<canonical-event>} substituted for the hook command line. */
    filename: string;
    /** How the harness is told where it is. */
    locate: { via: "env-file"; envVar: string }
           | { via: "env-dir";  envVar: string }
           | { via: "argv";     flag: string }
           | { via: "fixed-path"; path: string };
    content: string }
```

This is simpler *and* strictly more capable than what BYO has today. The manifest author
knows their harness's hook schema; Volli does not, and every attempt to guess it is a fifth
hardcoded renderer. YAML works. A fixed path outside `<userData>` works — which is what
Cursor actually needs. The trust dialog already shows the exact argv
(`packages/shared/src/harness/trust.ts:65-74`); it gains the file path and a content hash.
This is less Volli-authored code reaching a user's machine than `plugin-config-env` already
emits (`launch.ts:292-310` writes a generated `.js` module today).

**Recommendation S3 — the seam must carry a startup signal.** Add to the adapter:

```ts
/** The bound event that fires on harness boot, before the user does anything.
 *  `null` means the channel cannot prove itself alive until the agent acts —
 *  which disqualifies the harness from being expected to report. */
readonly startupEvent: HarnessEvent | null;
```

Claude Code and Cursor already bind `session.started`. Codex has a real `SessionStart` hook
field — its own adapter comment enumerates it (`packages/shared/src/harness/codex.ts:11-13`)
and then does not bind it. Bind it. Opencode's plugin can fire on load, which is itself proof
of load.

This is the field that makes silence *mean* something, and it is a precondition for every
silence judgement in §2. Without it, "no event yet" is ambiguous between a broken channel and
an agent nobody has typed into — which is precisely the Codex bug. With it, and with the
launch call from `c45d84e` proving the wrapper ran, the remaining window means one thing
only: the config we injected did not take. That is exactly the Cursor case, and it becomes
detectable rather than merely suspected.

`startupEvent` is also the honest gate on `expectsEvents` (§2): an adapter that declares
bindings but has no startup signal cannot be held to a reporting promise, because nothing it
does at launch is observable. Either bind one or do not expect events.

### What moves out of the adapter

- **`detection`** (`types.ts:238`) — delete. It equals `command` in all four built-ins, and
  the manifest parser literally assigns `detection: { executable: command }`
  (`manifest.ts:602`). One real consumer, `apps/desktop/src/main/agent-tools.ts:63`, which
  reads `adapter.command` just as well.
- **`HarnessEventBinding.timeoutMs`** (`types.ts:65`) — delete. Thirty bindings across four
  adapters, all `5000`. One consumer (`launch.ts:149`). Make it a constant beside the
  renderer that uses it.
- **`surfaces`** (`types.ts:239`) — keep, but understand it is install-time asset placement
  (`core.ts:99-132`), not launch-time runtime. Moving it is churn with no reliability gain.
- **`delivery: "async" | "sync"`** (`types.ts:60-64`) — keep. Nothing declares `sync`, but
  it is consumed (`launch.ts:216`), and it is where cmux's blocking-`PermissionRequest`
  lesson lands if permissions ever become a Volli surface.

---

## 2. Observed vs declared capability

Capability #1 is not "has this harness ever reported" — it is **"is our automation working
right now, and would we notice if it stopped."** That second clause is what the existing
machinery cannot express, and it is why the model below is deliberately *forgetful*.

### Three questions, three signals, no timer where a fact exists

The single largest simplification available is to stop deriving from silence what an arriving
call already states. Since `c45d84e` there are three separable questions and each has its own
evidence:

| Question | Evidence | Scope |
| --- | --- | --- |
| Did the wrapper run for this launch? | a `session harness` call arrived (`agent-commands.ts:1140-1203`) | per launch |
| Did *this* launch's channel come alive? | a `hook` call arrived for this session | per session |
| Is this harness's channel working *at all*? | did the most recent launch produce events | per harness, durable |

They are not substitutes. A per-`harnessId` aggregate structurally cannot answer the first
two — it does not know which terminal you are looking at — and a per-session state cannot
answer the third, because it dies with the PTY. Keeping all three, each answered by its own
signal, is smaller than the single conflated thing that exists today.

### The durable half: two columns, and they forget

Delete the first-class short-circuit at `harness-registry.ts:280`. Every harness — built-in
or registered — gets ledger rows. The justification in the surrounding comment (`:266-272`)
is that a built-in's bindings "are Volli's own code, checked against the installed binary
before they were written down, so there is no claim here for a ledger to keep honest." Cursor
is the standing refutation. **A built-in's declaration is not more trustworthy than a
manifest's — it is less scrutinised, because nobody had to click a dialog to accept it.**

But turning the ledger on is not sufficient, and this is the audit's sharpest point.
`harnessEventStatus` (`packages/shared/src/harness/trust.ts:92-98`) is **monotonic**: one
verified event pins that capability `verified` forever. A Claude Code upgrade that renames a
hook field, a `volli doctor --fix` never run after a path change, a wrapper deleted by a
dotfile sync — every one of these reads as perfectly healthy for the rest of the install's
life. A capability model that can only ever gain capability cannot tell you when automation
*stops* working, which is the half of capability #1 that matters.

Leave `harnessEventStatus` alone — it is monotonic on purpose, it gates per-event manifest
claims, and it is correct at that job. Freshness is a different question, and it gets its own
two columns rather than a rewrite of a working function:

```
harness_channel(harness_id PK, last_launch_at INTEGER, last_event_at INTEGER)
```

- `last_launch_at` — written by the `session harness` handler
  (`agent-commands.ts:1140-1203`). **This is the only honest increment point.** Incrementing
  at PTY spawn would count launches that bypassed the wrapper entirely and manufacture a
  false `silent` out of a user running `/opt/homebrew/bin/claude` by hand. The wrapper call
  is the one event that *proves* Volli's configuration was in the loop.
- `last_event_at` — written by the `hook` handler, beside the existing
  `recordHarnessDelivery` call (`agent-commands.ts:1279`).

Three states, **derived, not stored**, and non-monotonic by construction:

- **`reporting`** — `last_event_at >= last_launch_at`. The most recent launch reported.
- **`silent`** — `last_launch_at` is set, older than the grace window, and greater than
  `last_event_at`. The most recent launch ran through our wrapper and said nothing. **This
  is Cursor**, and it is the state the UI has to be able to say. It is also what a harness
  upgrade that breaks hooks flips to on the very next launch, which monotonic status cannot.
- **`unproven`** — `last_launch_at` is null, or inside the grace window. Say nothing.

Two integers, no counter, no stored enum, no per-event extension. The comparison — *did the
latest launch report* — is what makes it forget, and forgetting is the feature.

### Keep the grace window; change one input

`HARNESS_EVENT_GRACE_MS` (`session.ts:402`) stays. It answers a question the durable table
structurally cannot: *was this particular launch's wrapper bypassed, or is its channel dead.*
An earlier draft of this document proposed deleting it, which was wrong.

What changes is one input. Today the window is measured from the PTY launch
(`stores/sessions.ts:439`, `startedAt: launch.createdAt`) — a moment at which nothing has
happened yet and the harness may not have been typed. Measure it from **the `session harness`
announce** instead. That single substitution:

- makes the window mean "the wrapper demonstrably ran, and then N seconds of nothing", which
  is a real diagnosis rather than a stopwatch on user behaviour;
- fixes the Codex false accusation once `startupEvent` (S3) is bound, because a healthy Codex
  now has a launch-time event to deliver inside the window;
- fixes the harness-swap disagreement below, for free.

And it needs no new plumbing: main already broadcasts the announce
(`options.onSessionHarness`, `agent-commands.ts:1169-1175`) and the renderer already rebuilds
`SessionHarnessState` from it (`stores/sessions.ts:703-730`).

### The harness-swap disagreement, and the one-line cause

`announceHarness` rebuilds `SessionHarnessState`, resetting `startedAt` and `delivered`
(`stores/sessions.ts:718-728`). Under the new model that reset is not a bug — **it is
exactly right**, because a `session harness` call *is* a new launch, and a new launch's
channel has genuinely proved nothing yet.

The actual defect is narrower: main only broadcasts when the harness **changed**
(`agent-commands.ts:1166`, `const changed = harnessId !== effectiveHarnessId(session)`), and
the renderer independently early-returns on the same condition
(`stores/sessions.ts:710`). So quitting Claude Code and starting Claude Code again in the
same terminal — the exact case `c45d84e` exists to serve, since it mints a fresh id for it —
leaves the session carrying the *first* launch's `startedAt` and a stale `delivered: true`.
The second launch inherits the first's good reputation.

Fix: broadcast whenever a launch is proven, not only when the slug differs. A mint already
marks that unambiguously (`agent-commands.ts:1188`); for the backgrounded no-mint path, the
call itself is the proof. Keep `changed` as a field on the notice — the renderer still needs
it to decide whether to repoint labels — but stop using it as the gate.

This also removes the keying disagreement the audit raised. The durable table keys on the
announced `harnessId`, and the announce is the same write that sets `activeHarnessId`
(`agent-commands.ts:1168`), which is what `effectiveHarnessId` returns. One write, one key;
they cannot drift.

### Then collapse the dead per-session model

`sessionHarnessStatus` (`session.ts:411-431`) returns three fields, of which **one has a
consumer**:

- `.tier` — zero consumers. Delete, and with it `HarnessTier` (`types.ts:289`) and
  `harnessTier()` (`types.ts:302-307`). Dependents to update:
  `session.ts:12,267,293,391`, `stores/sessions.ts:25,437,723,810`. Replace
  `expectedTier: HarnessTier` with `expectsEvents: boolean` — which is the only question
  `:423` actually asks, and which S3 lets us answer honestly (`injection.kind !== "none" &&
  startupEvent !== null`). **This deletes the Cursor tier lie by deleting the thing that
  lies.** Nothing in the app renders a tier, so nothing regresses.
- `.input` (`SessionInputReporting`, `session.ts:387`) — zero consumers, confirmed by grep.
  Delete. The durable ledger answers the same question better: it survives relaunch and
  aggregates across sessions.
- `.activitySource` — one consumer (`active-session-listing.ts:123`). Keep; the function
  becomes `sessionActivitySource(state, now): SessionActivitySource`.

And `declaresInputNeeded` (`session.ts:275`) is currently hand-copied into main
(`agent-commands.ts:754-757`, gating the notification at `:1285`) and into the renderer's
fold (`session.ts:368`). Two copies of one rule, which this codebase's own comments warn
against everywhere else. Source both from the ledger's declared set.

### Where observed capability becomes visible

**Two existing render slots. No new screen, and no new IPC channel.**

1. **The picker.** `composer-footer.tsx:103-107` renders `{harness.label}` and a check mark.
   Add one trailing muted word, and only for one state: `Not reporting` when `silent`.
   Nothing for `reporting` or `unproven` — a harness that works needs no label, and one that
   has not been tried has not earned a warning.
2. **The sidebar row.** The slot already exists (`active-sessions.tsx:112-113`) and already
   renders that exact string. What changes is that it becomes right: driven by the
   announce-anchored window per session, and by the durable `silent` state for a harness
   already known broken, so Cursor says so on the first frame rather than at t+20s and Codex
   stops saying it at all.

Both read the same derived state. Deliver it on the existing harness-catalog hydration
(`harness-ipc.ts`, `hydrateHarnessCatalog`) rather than a new channel — it is already the
per-harness metadata read the picker performs.

**A settings screen is explicitly out of scope for this plan.** It was in the first draft and
it is cut: it is a diagnostics surface, not a reliability mechanism, and `volli doctor`
already occupies that ground. If the picker word turns out to be too thin, that is evidence
gathered cheaply and a settings list can follow later.

---

## 3. Material impact on ticket status

Capability #2. It needs a definition, because today the sidebar's tiering mixes board state,
voluntary CLI signals, involuntary hook events and PTY recency without ever saying which is
which.

### The governing principle

**A harness event never changes a ticket's status. It changes what the sidebar says about
the ticket.**

The board column is the human's statement of intent; the sidebar row is Volli's statement of
observation. Conflating them is what makes automation feel unreliable — a ticket that moves
itself is a ticket the user has to police. This also keeps the settled rule that automation
only de-escalates, and it means `harness-events.md:203`'s unbuilt "automatic board moves"
should be struck rather than implemented.

So: **a session has material impact when it produces evidence that changes what a human
should do next about this ticket.** Three positive claims and one negative, ranked by
evidence quality.

| Claim | Evidence required | Effect on the row |
| --- | --- | --- |
| The agent is blocked on you | `input.needed`, from a harness whose ledger has it `verified`, on a live session, not superseded | → Needs you, `Waiting for you` |
| The agent says it finished | `volli session done` (voluntary; carries the agent's words) | → Needs you, `Ready for review` |
| The agent is moving | `turn.started` / `tool.started` reported, else PTY output inside the window | stays Active, `Working` |
| Volli cannot tell | harness roll-up is `silent` | stays Active, `Not reporting` **in place of** the activity word |

### The invariant to name and test

**Inferred evidence never moves a row between tiers. It only chooses the word inside the
Active tier.** Only reported evidence — an involuntary hook event, or the agent's own CLI
signal — can promote a row to Needs you.

This holds today, narrowly and by accident: promotion at `active-session-listing.ts:348`
tests `activity === "waiting"`, and `waiting` is unreachable from the PTY
(`stores/sessions.ts:151-163`). It is one line away from being violated by anyone who adds a
PTY-derived state. Write it down and assert it.

### What is explicitly not material

- **`subagent.completed`.** Already correct (`session.ts:327`, `TELEMETRY_EVENTS`) — a
  subagent finishing is not the parent moving. Keep, and keep the reason in the comment.
- **A terminal exiting.** The PTY runs the user's login shell, not the harness, so the exit
  code is the shell's `$?`. `outcomeFromExitCode` (`active-session-listing.ts:213-215`) has
  an eleven-line comment (`:201-212`) explaining precisely why that number cannot mean the
  agent succeeded — and then returns `"done"` for zero, which the sidebar renders as `Done`
  (`active-sessions.tsx:46`). A row reading `VC-12 · Done` for a ticket sitting in Doing,
  meaning "your zsh exited 0", is the single most misleading string in the surface. Delete
  the outcome vocabulary entirely (section 5).
- **The board restating itself.** A `needs_review` ticket with no live session gets a Needs
  you row (`active-session-listing.ts:406-422`). Keep it — the presence guarantee is right —
  but it must not be worded as though an agent said something. See `In review` below.

### The resume predicate disagreement

Two predicates for one affordance. The sidebar's ↻ badge tests only
`record?.harnessSessionId != null` (`active-session-listing.ts:248`, `:280`); the rail's
action uses `canResumeSession` — `launchKind === "agent" && endedAt !== null &&
canResumeHarness(effectiveHarnessId(record), …)` (`ticket/session-history.ts:154-163`).

The obvious fix — point the badge at `canResumeSession` — is wrong, and the code says so
before you try it: `session-history.ts:148-152` records that its `getHarnessAdapter` lookup
is deliberately first-class-only, because "the renderer has no channel over which a
registered manifest's adapter could reach it." That is no longer true — `launchAdapter`
(`stores/sessions.ts:404-409`) consults the built-ins *and* the hydrated catalog. Routing the
badge through today's `canResumeSession` would therefore strip the badge from BYO sessions
that correctly show it now: a regression, not a reconciliation.

So fix the lookup first, then share the predicate. Give `canResumeSession` an adapter-lookup
parameter rather than reaching for a store getter from a pure module — `session-history.ts`
imports only from `@volli/shared` today and should keep doing so — and pass `launchAdapter`
from both call sites. One predicate, one honest lookup, BYO keeps its badge. Do this in the
same change or not at all; the two halves are only correct together.

---

## 4. Vocabulary reconciliation

Today `stateLabel` (`active-sessions.tsx:115-121`) selects among three vocabularies, then
prefixes a fourth fact (`row.source`, the harness name) and sometimes appends a fifth
(`· Not reporting`, `:113`). A single row can read `VC-12 · Claude Code · Working`, or
`VC-12 · Done · 4m ago`, or `VC-12 · Ready · shipped the parser`.

**One vocabulary, nine strings, partitioned by tier so no string can appear in both.**

Needs you — the row is here because something asked for a human:

- `Waiting for you` — reported `input.needed`
- `Blocked` / `Blocked · <reason>` — `volli session blocked`
- `Ready for review` / `Ready · <reason>` — `volli session done`
- `In review` — the ticket is in Needs Review and nothing has said anything

Active — the row is here because the ticket is in Doing:

- `Working` · `Idle` · `Parked`
- `Not reporting` — replaces the activity word; never appended to one
- `Ended · <when>` — a concluded run

Deleted strings: `Done` (the shell's exit code wearing a verdict), `Ended` as an
*outcome* distinct from `Done` (they collapse into one concluded state), and `Needs review`
(it restates the column name and reads as an instruction — `In review` is a state).

`Exited` survives, narrowly: `placeLiveTab` filters it (`:339`) and fallback rows carry
`activity: null`, but a signaled-but-exited tab can still reach the label via `:365`, which
does not filter exited tabs the way `:370-372` does. Either filter it there too and delete
the string, or leave it and accept one more word. Prefer filtering.

**One further recommendation, flagged as a judgement call.** Drop the harness name
(`row.source`) from the row's second line. It is constant for the life of a session while
everything else on that line changes, and it currently consumes roughly half the width of
the only place a changing fact can be read at a glance. It stays available on hover and in
the ticket rail. The cost: in a project mixing harnesses, the row no longer says which agent
is running without hovering. Owner's call.

---

## 5. What to delete

Ordered by how much lying each removal stops. Every dependent listed has been grepped.

1. **`HarnessTier` + `harnessTier()`** (`types.ts:289,302-307`). Dependents:
   `session.ts:12,267,293,391`; `stores/sessions.ts:25,437,723,810`. Replace with
   `expectsEvents: boolean`. No UI consumers. *Deletes the Cursor tier lie by construction.*
2. **`SessionHarnessStatus.tier` and `.input`, and `SessionInputReporting`**
   (`session.ts:387,391,393`). Zero consumers. `sessionHarnessStatus` becomes
   `sessionActivitySource`.
3. **The first-class exemption** (`harness-registry.ts:280`). One line. Turns the ledger on
   for the harnesses it was built to police.
4. ~~**`HARNESS_EVENT_GRACE_MS` and the clock branches.**~~ **Withdrawn.** The first draft
   had this; it was wrong. The window answers a per-launch question no durable per-`harnessId`
   aggregate can answer, and S3 argues for sharpening it rather than removing it. What
   changes instead is one input — anchor `startedAt` to the `session harness` announce
   (§2) — which is a substitution, not an addition.
   **Deleted in its place:** the `changed` gate on the announce broadcast
   (`agent-commands.ts:1166-1176`) and its twin early-return (`stores/sessions.ts:710`). One
   condition removed from each end, and the second-launch-in-one-terminal bug goes with it.
5. **`SessionOutcome`, `OUTCOME_LABEL`, `outcomeFromExitCode`**
   (`active-session-listing.ts:32,213-215`; `active-sessions.tsx:45-48,119-120`). Replaced
   by `Ended · <when>`.
6. ~~**`permission.requested` as a canonical event.**~~ **Withdrawn — it is a breaking
   change wearing a cleanup's clothes.** The event name is *published* manifest vocabulary
   (`skill-content.ts:132` documents it to every agent that authors a manifest) and it is
   *stored*: `verified_events` rows hold it as JSON, read back through `parseEventList`
   (`harness-registry-repo.ts:69-70`) under an `isHarnessEvent` guard
   (`types.ts:45-47`) that would begin silently dropping it. Removing it therefore needs a
   db migration, a manifest-compatibility shim, and a doc revision — for a saving of one
   union member and two duplicate bindings that cost nothing at runtime. Not worth it.
   Keep the event. The duplicate `input.needed` / `permission.requested` bindings on Codex
   (`codex.ts:71-82`) and Opencode (`opencode.ts:39-45`) are deliberate and load-bearing,
   and the notification gate's single-event rule (`agent-commands.ts:1280-1284`) is already
   the correct handling.
7. **`HarnessAdapter.detection`** (`types.ts:238`). Equals `command` everywhere; assigned
   from it in `manifest.ts:602`. One consumer, `agent-tools.ts:63`.
8. **`HarnessEventBinding.timeoutMs`** (`types.ts:65`). Thirty identical literals, one
   consumer (`launch.ts:149`). Make it a constant.
9. **`config-dir-env`** (`types.ts:93`) — once Cursor moves to `hook-file` with a fixed path
   (or is demoted to `none`), the kind has no users and goes.
10. **The "automatic board moves" promise** in `harness-events.md:203`. Never built, and
    section 3 argues it should not be. Strike it so nobody implements it from the plan.

### The net-change tally

The owner asked for less surface area, so the accounting is kept explicit rather than
implied.

**Added:** one 3-column table (`harness_channel`); one adapter field (`startupEvent`); one
injection kind (`hook-file`, replacing `config-dir-env`, so the kind count is flat); one
lookup parameter on `canResumeSession`; one muted word in the picker.

**Removed:** `HarnessTier`, `harnessTier()`, `SessionHarnessStatus.tier`,
`SessionHarnessStatus.input`, `SessionInputReporting`, `SessionOutcome`, `OUTCOME_LABEL`,
`outcomeFromExitCode`, `HarnessAdapter.detection`, `HarnessEventBinding.timeoutMs` (30
literals), `config-dir-env`, the first-class ledger exemption, the `changed` broadcast gate
and its renderer twin, three sidebar strings, and the unbuilt board-move promise.

**Cut from this plan since the first draft:** the settings screen, the roll-up enum (now
derived from two integers), the new IPC channel (folded into catalog hydration), the
`expected_launches` counter (a timestamp comparison needs no count), and the
`permission.requested` deletion. Net: still a removal, and a larger one than before.

---

## 6. Migration

Six stages. The ordering constraint is **correctness, not greenness**: `startupEvent` has to
precede any stage that judges a harness silent, or a first-ever Codex launch is accused on
day one. An earlier draft got this wrong by putting the ledger first.

**Stage 1 — the seam, and Codex's missing signal.** Add `startupEvent` (S3); bind Codex's
`SessionStart`; confirm Opencode's plugin fires on load. Rename the injection kinds (S1).
Deletions 7 and 8. No behaviour change beyond Codex now speaking at launch — which is a fix
on its own and ships on its own. *Verify:* one live run per built-in confirming a launch-time
event arrives. The `hooks_path` episode recorded at `harness-events.md:352-374` is what this
stage looks like when shipped on reading alone.

**Stage 2 — anchor the window to the launch.** Stop gating the announce broadcast on
`changed` (deletion 4's replacement); seed `startedAt` from the announce rather than the PTY
launch. Fixes the second-launch-in-one-terminal staleness. Depends on stage 1: without a
startup event, re-anchoring the window would still misjudge Codex. *Verify:* quit and relaunch
the same harness in one terminal and confirm the window restarts.

**Stage 3 — the durable channel state.** Delete the first-class exemption; add
`harness_channel` and write both columns; derive `reporting`/`silent`/`unproven`; expose it
on catalog hydration. No UI reads it yet. Ships invisibly and starts accumulating evidence.
*Verify:* launch each built-in once, then confirm Cursor derives `silent` and the other three
derive `reporting`.

**Stage 4 — the dead types.** Deletions 1 and 2. `sessionHarnessStatus` collapses to
`sessionActivitySource`; `expectedTier` becomes `expectsEvents`, computed with `startupEvent`
from stage 1. Pure type churn by this point, because stages 1–3 already established every
fact it depends on.

**Stage 5 — vocabulary and surfaces.** Deletion 5, the label table from §4, the `In review`
rename, the picker's `Not reporting` word, and the sidebar repoint. The
`canResumeSession` lookup fix and the ↻ badge land together here — §3 notes the two halves
are only correct as one change. This is the stage where Cursor becomes visibly not-reporting
to a user for the first time.

**Stage 6 — Cursor itself.** Add `hook-file` (S2), move BYO onto it, delete `config-dir-env`
(deletion 9). Then resolve Cursor: a fixed-path `hook-file` into its real `hooks.json`
ladder, or `injection: { kind: "none" }` with an honest `expectsEvents: false`. Deliberately
last — by now the app tells the truth about Cursor whichever way this goes, so it is a fix
rather than a prerequisite, and it can take the time a live investigation needs.

The harness-name-off-the-row judgement call (§4) is unsequenced; it is the owner's to take or
leave and blocks nothing.

---

## Flagged: not verified

- Cursor's `hooks.json` ladder and its indifference to `CURSOR_CONFIG_DIR` are taken as
  given from the brief. **Stage 6** must confirm against `cursor-agent` before choosing
  between fixed-path `hook-file` and demotion.
- The Codex false-accusation defect (section 0) is derived from reading `codex.ts:57-83` and
  `session.ts:411-431`. It has not been reproduced against a running Codex.
- Whether Opencode's plugin can fire a load-time event is asserted from the plugin
  mechanism's shape (`plugin.ts`, `launch.ts:292-310`), not observed. Stage 1 must confirm
  it; if it cannot, Opencode gets `startupEvent: null` and `expectsEvents: false`, which is
  the honest outcome rather than a blocker.
- **The backgrounded announce is best-effort.** The no-mint path is
  `( … & ) || true` (`wrapper.ts:232`), so for Codex and Opencode — whose adapters take no
  argv id — a lost announce means no `last_launch_at` write. That direction of failure is
  safe (it under-reports launches, so it can only produce a false `unproven`, never a false
  `silent`), but it means the durable state is weaker evidence for those two harnesses than
  for Claude Code and Cursor, whose mint call is synchronous. Worth measuring in stage 3
  before trusting the picker word for them.
- Whether the announce should be made synchronous for all harnesses is left open. It would
  strengthen the above, at the cost of putting a socket round-trip in front of every launch
  of a harness that gains nothing else from it.
