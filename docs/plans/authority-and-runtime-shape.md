# Agent authority and runtime shape

**Status:** Part I slices 1–4 shipped, except slice 4's second half — the drawer
above the composer — and the five other items its checklist names. Part II
candidates 3 and 1 shipped (1 as #205 → #206 → #207); 2, 5 and 6 remain, in the
order below. Part III decision complete, not started — all four slices.

**Date:** 2026-08-11

**Scope:** The policy a Session executes under, the shape of the seam the Agent
Runtime sits behind, and how a user signs in to Model Access.

## Why this plan exists

Three efforts follow the Pi migration. They are recorded here rather than in
`pi-native-ticket-session.md` because that document describes a migration that is
finished. They interlock, which is why they share a document: Part I makes auto
mode honest, and its last step gave the `SessionInteraction` surface a producer,
which is a question Part II would otherwise have answered by deletion; Part II
collapsed the adapter registry into a single runtime port, which is where Part I's
evaluation seam belongs; and Part III moves sign-in into the app, removing one of
the two ways packaging currently breaks things that work today — the other being
Part I's sandbox note.

**One thing Part III must not do:** reuse Part I's `SessionInteraction` channel
for auth prompts. The two look alike and are not. See "The interaction channel"
below.

## Part I — Agent authority

### Product decision

Auto is the default authority mode for every Session. The user is not asked to
approve individual tool calls.

The reasoning is Anthropic's, from making auto mode the Claude Code default on
2026-08-14: users approve about 97% of permission prompts, which is reflexive
clicking rather than review, while they reject about 39% of proposed plans. A
prompt on every action buys the appearance of control and little of the
substance. Scrutiny belongs at the level of intent, not the individual call. (The
97% and 39% are the product announcement's; the engineering post states 93% for
the same rate — quote 93% when citing that post.
`docs/research/claude-code-auto-mode-semantics.md` holds the full semantics.)

It does not mean unbounded execution. Their auto mode routes every tool call
through a classifier that blocks irreversible, destructive or outward-aimed
actions; keeps a category it will never approve; checks whether a git push
destination is public, private or trusted; reads repository state before a
destructive git command; and escalates after three consecutive denials or twenty
in a session.

Prompt injection is screened by a *different* mechanism, and the distinction
matters because it is a layer Volli does not have: a server-side probe scans tool
outputs before they enter the agent's context, and the transcript classifier is
defined by never seeing tool output at all — that stripping is itself the
defence, since an injection would have to beat the probe and then steer the agent
into a call the classifier independently judges safe. Nothing in Volli screens
injection.

### What the boundary already enforces

This matters more than any gap, because it is why the rule layer above it can
stay small. `packages/agent-runtime/src/pi/scoped-execution-env.ts` runs every
bash call inside a Seatbelt sandbox through `@anthropic-ai/sandbox-runtime`: all
network denied (`deniedDomains: ["*"]`, `strictAllowlist: true`, no Unix sockets,
no local binding); the child environment sanitized, so no credential reaches it;
home-directory reads denied and reads and writes scoped to the Session workspace;
file tools rejecting any path outside the root **and rejecting symlinks**. The
process-global config carries no workspace paths at all — each Session's root
travels per command, and a gated integration test proves two Sessions at sibling
roots cannot read each other's files in either attach order.

The categories Anthropic's classifier exists for — exfiltration, actions aimed
outside your environment — are therefore largely unreachable for a Session in a
Ticket worktree. That is a real boundary enforced by the kernel, not a policy
layer that can be reasoned around.

### The shape that shipped

**The Authority Snapshot is a record, not a literal:** `mode`, the work-location
kind (`worktree` or `main-checkout`), the tool bundle, a rule-pack **id and
hash** rather than the rules inline, `classifierModel` (still `null`), and the
fallback thresholds. Pinning the pack by identity satisfies `CONTEXT.md`'s
requirement that "a Settings change does not silently change a running Session's
authority" without freezing machine facts that must stay live. Resolved paths,
the current branch, remote visibility, repository status before a destructive
command and the denial counters are all computed at call time — they are not
policy, they are the state policy reads.

**It is not persisted, and never was**, which corrects what slice 1 claimed for
itself. `PiBinding.runtimeSpec()` constructs the record on every attach; no
Session Event carries it, no SQLite column holds it, and `SessionProjection` has
no field for it, so it is not projected to the UI either. What shipped is the
record's *shape*. The only durable trace of authority is the consequence of a
denial — the `authority.denied` event and the
`SessionProjection.authorityDenials` fold.

**The evaluation seam is `AgentOptions.beforeToolCall`**, Pi's in-process
equivalent of `canUseTool`, wired to a pure `evaluate(call, snapshot, context)` in
`@volli/shared` so the policy table is a unit test with no runtime, no process and
no model. Only the decision is pure: resolving a path, following a symlink and
lexing a command line all need `node:fs`, so normalizing a call into the value the
pure function judges stays in `@volli/agent-runtime`. A block commits its Session
Event **before** it reaches the model, which is what turns the boundary from an
error string the model can route around into product behaviour — countable for the
thresholds, visible in the transcript as a Volli semantic fact rather than a
failed tool, and available to Attention.

### Role policy

The two Session Roles do not deserve the same policy, and this is the sharpest
product question in Part I. **Only the ticket half shipped.**

A **ticket** Session runs in a Ticket worktree: branch-isolated, disposable, and
already sandboxed away from the network and the home directory. Auto is nearly
free there, and the residual risk inside the tree is what the forbidden set
covers — `.git/hooks`, `.git/config`, `.volli/`, and git subcommands that leave
the worktree.

A **project** Session runs in the Main checkout, on the user's real working tree,
with their uncommitted work, on whatever branch is checked out. It inherits the
same sandbox widened to that root. It must not inherit the worktree's policy, and
does not yet have one of its own: forbid `reset --hard`, `checkout -- .`,
`clean -fd`, `stash drop`, `rebase` and `commit --amend`; forbid branch
switching; and take an automatic pre-image commit of dirty work before the first
edit, so the user's uncommitted work is recoverable. That last idea is Aider's,
and it is the single best pattern in the survey for agents working a checkout a
human also uses.

### Why no classifier yet

Keep `classifierModel: null`. A classifier earns its cost when the dangerous
categories are reachable: three of Anthropic's four block-rule groups need the
network or the home directory and Seatbelt denies both outright, and their own
tier 2 skips the classifier for in-project file writes on the same blast-radius
reasoning.

**That covers most of the realistic risk, not all of it, and the gap is accepted
rather than absent.** Their classifier is an *intent* checker, not a boundary
enforcer: its rules are anchored on the user's own messages, and "everything the
agent chooses on its own is unauthorized until the user says otherwise." A kernel
guarantees nothing about intent. A branch sweep, a `push --force`, or an
over-broad `rm` entirely inside the workspace is legal under every rule we wrote
and legal under Seatbelt. The second thing only a classifier reaches: "evaluate
the real-world impact of an action, rather than just the surface text of the
invocation" — the rule a lexer cannot implement, and the same gap our `eval`,
base64 and command-substitution residuals name. It becomes warranted when network
egress is allowlisted, which reopens exfiltration, or when the Main-checkout Role
ships at scale. Keep the field so the seam exists before it is needed.

### External evaluation

**`czottmann/pi-automode`** (`bd82e29e`, v1.11.0, MIT) was **rejected as a
dependency**: it is a Pi *extension* registered for `pi-coding-agent`, the CLI
and TUI layer, while Volli embeds `@earendil-works/pi-agent-core`, so adopting it
would pull the whole terminal stack into Electron main. It also has no notion of
two work locations, no fallback-to-manual, and its own README states it is not a
sandbox. Its deterministic layer was worth having and was vendored with
attribution — a shell lexer that understands quoting, redirects and operators,
plus path helpers — with its classifier taken as design only. Vendoring rather
than depending also reflects that 51 of its 56 commits are from one author.

The honest caveat: porting a shell lexer copies its bypass surface. It does not
handle `eval`, base64, command substitution or `xargs`. Sound as defence in depth
beneath Seatbelt, unsound as a standalone boundary.

**From the wider survey**, the useful borrowings are Codex's policy shape — a
capability tier (`writable_roots`) kept orthogonal to an approval axis, the only
surveyed model where work location *is* the policy variable — and its habit of
carving protected metadata paths out of every writable root. Claude Code
contributes the precedence order and the thresholds. Goose demonstrates the
failure mode to avoid: approval at tool-name granularity, where one approved
shell tool chains anything.

### Deliberately not in the first pass

The classifier, network allowlisting, the Main-checkout policy and its pre-image
commit, per-project rule packs, and data-aware git rules.

### Risks and unverified assumptions

- The sandbox's enforcement inside Volli was established by reading the config it
  passes and by a gated two-root test, not by a full adversarial pass. If
  `wrapWithSandboxArgv` ever degrades to a passthrough, the "no classifier
  needed" conclusion weakens materially.
- `beforeToolCall` is advisory and covers tool calls only. The sandbox remains
  the real boundary. A future tool that bypasses the scoped execution
  environment would sit outside both.
- `sandbox-exec` is formally deprecated and cannot nest, so a Mac App Store build
  under the App Sandbox would lose this boundary entirely. That is a packaging
  constraint worth knowing before it is discovered late.
- The 3-consecutive / 20-per-Session thresholds are inherited, not earned — see
  slice 4's record below, which is where they now have a consequence.

### Slices 1–3 record (2026-08-10)

`authority.denied` carries which tool, which rule, and the refusing rule's own
words, from `beforeToolCall` through the adapter to SQLite. Three decisions in
that durable fact are load-bearing. `cause` is stored as a
bare string, not the rule-id union, because history outlives the pack that wrote
it and `sqlite-ledger.ts` decodes with `default: throw` — a decoder rejecting a
retired rule id would not degrade one event, it would fail every later read of
that Session. The count is projected but the streak cannot be:
`SessionProjection.authorityDenials` exists because a counter that reset on every
attach would never reach twenty, while an *allowed* call is not an event, so only
a live runtime can know a run of refusals was broken. And a refusal goes through
the same `OrderedObservationDelivery` queue as everything else — one that overtook
its turn would be filed against the wrong turn — which works without a
`try`/`catch` because `commitObservation` never rejects, and a ledger that cannot
be written is not a reason to let the call through.

**Where the plan was wrong, corrected in the build:** the vendored hard-deny
layer could not sit in `@volli/shared` beside `evaluate`, because its path helpers
need `node:fs`. Only pi-automode's lexer and path helpers were vendored, not its
rule body — two rule tables able to disagree, with no way to say which refused, is
worse than one — and not `permissions.ts`, which matches configured patterns like
`bash(git push *)` against a call, a question Volli does not ask. Work location is
not derivable from the Session Role, because a Ticket that never took a worktree
runs in the Main checkout, so `PiRuntimeContext` carries a **required** `location`
set from `ticket.usesWorktree`; a default would have marked every Session a Main
checkout and rotted quietly.

**Two boundary decisions worth not relitigating.** `path.outside-workspace` judges
writes, not every command operand: the per-command Seatbelt policy deliberately
leaves `/usr`, `/etc` and `/opt/homebrew` readable so ordinary build and test
commands work, and a first pass that checked every operand denied `ls /usr/bin`,
`cat /etc/hosts`, `2>/dev/null` and any explicitly-pathed toolchain binary. A rule
layer stricter than the boundary it backs up is a second, worse boundary —
`2>/dev/null` alone would have tripped the three-consecutive threshold on ordinary
work. Rules 9 and 10 still read operands, because destructive removal and a git
flag aimed at another tree are intent-level cases the kernel permits. And
`cp evil.sh <workspace>/.git/hooks/pre-commit` is closed one layer down rather
than in the rule table, which would need per-program positional parsing: the
sandbox denies writes to `<workspace>/.git/hooks` and `<workspace>/.git/config`,
the two paths normal git operation never writes and the two that change what later
commands do. Rule 3 stops file tools and `git config`; the sandbox stops every
other writer. Neither is complete alone.

**Accepted residual:** `cp <workspace>/secret /tmp/leak` is not refused. With the
network denied outright, that is a file elsewhere on a machine the user already
owns, not exfiltration, and the sandbox's `denyWrite` already covers the
agent-controllable scratch paths.

**`rm` is strict on every operand, and that has a priced cost.** An unresolvable
`$VAR` fails closed as an `rm` operand, so `for f in build dist; do rm -rf $f; done`
is refused — an ordinary cleanup loop, and a self-amplifying one, because the
natural retry is another `rm` in the same loop and three of them trip the
consecutive-denial threshold. `git` was narrowed away from this cost, to the
values of its path-bearing flags; `rm` was not, because every one of its operands
is a deletion target. The refusal names the remedy — write the paths literally —
so the model has a next move rather than a dead end. Resolving `$PWD`, which is
derivable, would shrink this further if it proves noisy.

**A Session can no longer set its own git identity**, and that costs nothing: the
agent is not the commit path, since `apps/desktop/src/main/worktree/publish.ts`
resolves identity in main and runs `add`/`commit` outside the sandbox. It would
matter only if a Session were ever expected to commit through its own bash.

### Slice 4 — the escalation producer

**Shipped across two PRs**: the port, the counters and the shared ask vocabulary
first (#210), then the Pi adapter implementing that port against the interaction
card the renderer already had (#211). The answer pipe is complete end to end —
renderer, IPC, tRPC, Engine, durable event, adapter dispatch, and the last hop
into Pi — so the roughly 1400 renderer lines that sat at 100% coverage verifying
behaviour nothing produced now have a producer, which is what retires Part II
candidate 4. What has *not* shipped is the second half of the original two-PR
plan — the drawer above the composer, which is where the existing card moves —
and five other items. Both are in the checklist below.

**The ask is a typed port, not an observation.**
`SessionRuntimeSpec.ask?: (request: RuntimeAskRequest, signal: AbortSignal) =>
Promise<RuntimeAskChoice>`, `RuntimeAskChoice = "allow" | "refuse" | "stop"`. The
adapter implements it by emitting `interaction.opened` and parking a resolver,
then claiming it back from the `interaction.resolve` dispatch, which keeps
`@volli/agent-runtime` free of ledger types entirely. It blocks with no invented
timeout — the runtime awaits it with none of its own, and a question left up
overnight costs a parked promise. The `AbortSignal` is the other half of that
bargain: the host's only notice that the turn its question belongs to has stopped
waiting, and a host that ignores it strands the card it opened.

**One question ends three ways, not two,** and the distinction decides what
history says. `AskResult` in `packages/agent-runtime/src/pi/escalation.ts` is
`answered` — a decision; `abandoned` — a signal fired first, so nobody was asked
and nothing is recorded; or `unavailable` — the host could not obtain an answer at
all, so the refusal stands and *is* recorded, because nothing was cancelled and
the call really was refused.

**The interaction id is `ask:<toolCallId>`, and it is frozen.** It lands inside
`pi:interaction:<attachmentId>:ask:<toolCallId>:opened` on disk, and every relaunch
re-derives that event id and dedupes by exact match — so changing how it is built
would not fail, it would write a second copy of every question a Session ever
asked. The tool call id is the identity because the runtime blocks exactly one
question per refused call.

**Counters.** `#consecutiveDenials` is runtime-only and necessarily so: an
allowed call leaves no durable trace, so nothing outside a live attachment can
tell three refusals in a row from three spread over a day. `#sessionDenials`
seeds from `SessionRuntimeSpec.priorAuthorityDenials` and advances only in the
branches that ask for a record, so it can drift below the projection but never
above — toward one question missed, never toward one invented on evidence that
does not exist. `#sessionTrip` is a moving target rather than a comparison,
because the fallback names an *interval*: once a person has answered at twenty
the next question belongs at forty, where a fixed comparison would ask again on
the twenty-first refusal and every one after. A threshold that is not a finite
number ≥ 1 coerces to infinity — never ask — rather than to zero, because a
broken config must not turn escalation into a prompt on every refusal.

**Both causes ask; they differ in what they offer.** `askOffer` mints both pairs
from the ledger's own option lists rather than restating them, because the
surface that offers a choice and the runtime that reads the answer are one
decision made twice with the option ids as the wire between them. An overridable
rule offers `[once, reject]` as a `permission` — **no `always`**, because there
is no durable policy store to write a standing grant into and an option that
silently meant `once` would be a lie told in the one place a person is being
asked to trust us. A rule that only reports offers `[continue, stop]` as a
`question`: "Keep working" accepts the refusal and lets the turn run on, "Stop
the turn" ends it. Neither grants anything — the call is refused either way,
which is why the title says the call was blocked rather than asking permission
for it. It is still a real question: not "may it run", which is settled, but "is
this policy in your way badly enough to stop". That is why it is an interaction
rather than an Attention — it has a consequence either way, and it avoids
widening the Attention reason union for a state none of its members describes.

**The renderer widens the polarity, and only the renderer.** `optionPolarity`
groups `stop` with the refusing ids and `continue` with the allowing ones, so an
escalation draws like every other two-sided ask. That widening must stay
renderer-local: `askChoice` tests `SESSION_REFUSAL_OPTION_IDS` *before* it tests
`stop`, so an id moved into that shared list would resolve "Stop the turn" to a
plain refusal and the turn would never stop. The transcript gained `continued`
and `stopped` receipt verdicts for the same reason — an escalation's outcome is
neither "allowed" nor "rejected", and printing it as either would misreport what
the person decided.

**We park where Anthropic terminates, and that is deliberate.** Their rule is
that in headless mode "there is no UI to ask the human, so we instead terminate
the process." Volli has no headless mode and no manual-approval mode to fall back
*to*, so terminating would destroy a Session to avoid asking a question the
product can hold open indefinitely. `sessionAwaitsUser()` surfaces an unanswered
interaction in the sidebar and the chat listing, so a parked Session is visible
rather than silently stuck. Their word "fallback" should stop being borrowed for
this: ours is a check-in that re-arms auto, not a demotion to manual.

**The thresholds are inherited, not earned.** 3-consecutive and 20-per-Session
were tuned against a decider measured at 0.4% false positives over 10,000 real
sessions. A deterministic rule table is not that decider and its false-positive
rate here is unmeasured — the record above documents one narrowly avoided case
where `2>/dev/null` alone would have tripped three-in-a-row. Slice 3 made the
rate measurable and slice 4 made it consequential. They ship as provisional: read
the ledger before defending them.

**An unreadable call counts toward the streak.** A command the lexer cannot parse
is refused like any other and pushes the Session toward being asked. That is
right — the agent genuinely cannot proceed and the user genuinely should know —
but it means a parser limitation, not a policy judgement, is what interrupts
someone. Recorded so it is a decision rather than a side effect.

**No new event kind for an override.** The `authority.denied` emit happens *after*
the ask resolves and fires only when the call is actually refused; otherwise
history would record a denial for a call that ran. What the user permitted is
already durable as `interaction.opened` plus `interaction.resolved` — the user's
decision is an interaction fact, not a policy fact.

**`NativeAttachmentSpec` does not carry a projection and must not grow one.**
Whatever seeds the session counter travels through `PiRuntimeContext`, the way
`location` did in slice 2. The spec describes an attachment; threading a
projection through it would make every attachment a reader of Session state it has
no business holding.

**Cancelling an ask reaches the runtime now.** `#cancelInteraction` used to write
`interaction.cancelled` and dispatch nothing, which left the Pi turn blocked
inside `beforeToolCall` forever while `sessionAwaitsUser()` went false and nothing
on screen said so. `BindingHandle` carries an optional
`withdrawInteraction(interactionId)`, and the Engine makes a best-effort hop to it
after the durable fact, swallowing whatever it does — including a throw — because
the cancel already holds and an unheard withdrawal changes no Session fact. It
deliberately does not attach a binding to say it: cancelling a question is the last
intent that should ever start a harness.

**A withdrawn ask rejects; it never resolves with a refusal.** A refusal is a
decision and a withdrawal is the absence of one, so resolving would print a choice
nobody made — the exact failure `interaction.cancelled` exists to avoid. The
runtime reads the rejection as "the host could not obtain an answer" and lets its
own refusal stand. The one case where a refusal is *not* recorded mirrors this: a
question was put and a cancellation arrived before any answer, so a denial written
on nobody's behalf would be a claim about a person that is not true. Everything
that can end an ask — answer, withdrawal, abort, release — goes through one claim
on the parked map, so the second arrival finds nothing; and release withdraws what
is still parked *before* setting its released flag, since the sink admits nothing
after that and a later cancellation would be dropped on the floor.

**`stop` reaches `agent.abort()`,** because `beforeToolCall` cannot end a turn on
its own: Pi's `terminate` flag takes effect only when every finalized tool result
in the batch sets it, and one refused call is not the whole batch agreeing to
stop. The call goes through a closure assigned the statement after `Agent` is
constructed, since the callback needs something the constructor argument cannot
yet close over. That abort does not end the turn cleanly — Pi runs one more loop
pass and synthesizes an assistant message with `stopReason: "error"` rather than
`"aborted"`, which the existing `failure.reason === "aborted"` guard never saw, so
a deliberate stop surfaced as the unrecoverable "Session stopped" banner. An
`interrupting` flag in `packages/agent-runtime/src/pi/runtime.ts` closes it: set
when the runtime calls the abort, cleared at `agent_start`, and read alongside
`failure.reason` so this abort is told apart from a genuine model failure
**before** classification rather than after.

**Accepted residual: the model is told "Operation aborted", not why.**
`beforeToolCall` returns `{ block: true, reason }` after `agent.abort()` has
already run, and Pi re-reads its own cancellation before it looks at the block
result, so it discards the reason. Pi offers no hook that reorders those two
reads. The ledger still holds the truth — `authority.denied` records the refusing
rule's words before the abort runs — but only the ledger. The turn is ending
regardless, so the model is told the run stopped rather than why, which is the
honest reading of what happened to it. This is documented on the `reason` field
in `escalation.ts` so nobody rediscovers it as a bug.

#### What remains

1. **Seed the session counter.** `SessionRuntimeSpec.priorAuthorityDenials` is
   declared and read — `runtime.ts` passes it to `AuthorityEscalation` as
   `priorDenials` — but nothing supplies it. `PiBinding.runtimeSpec()` never sets
   it and `PiRuntimeContext` has no field for it, so the per-Session half of the
   threshold restarts at zero on every attach and a Session that accrued denials
   across attaches is never asked on that count. It seeds from
   `SessionProjection.authorityDenials` through `PiRuntimeContext`.
2. **Put `pi-adapter.ts` under the coverage gate.**
   `apps/desktop/src/main/session-runtime/pi-adapter.ts` is absent from the
   `include` list in `apps/desktop/vite.config.ts`, so the file this slice is
   mostly about is not measured by the 100% gate at all. Measured on 2026-08-11
   it sits at **78/88 branches** and 141/146 statements — ten uncovered branches
   and five uncovered statements (lines 233, 301, 484, 493, 518), most of them
   pre-existing. Adding the entry means closing all of them.
3. **A live smoke.** `apps/desktop/e2e/authority-escalation-smoke.mjs` does not
   exist. Three refusals in a row, a card, an answer, and the turn continuing or
   stopping is the one path no unit test covers end to end.
4. **The drawer above the composer** — the second half of this slice's own
   two-PR plan, unbuilt. The card is drawn today at the foot of the transcript by
   `footInteraction` in `chat-plane.tsx`; the drawer is where it moves.
5. **Pin the denial/answer interleave with a test.** The Engine writes
   `interaction.resolved` itself, from the receipt the adapter's dispatch
   returns, while the runtime emits `authority.denied` on its own ordered queue
   once the parked resolver settles. Two independent chains, so the order they
   land in is unspecified. Slice 3 took care to make a refusal land on the turn it
   belongs to; parking reintroduces the same question one level up. Both facts are
   true and separately timestamped, so this is a known interleave to pin, not a
   reason to build ordering machinery — and neither `session-runtime.test.ts` nor
   `pi-adapter.test.ts` pins it today.
6. **Prove a blocked call is *recorded*.** The three cases in
   `packages/agent-runtime/src/pi/scoped-execution-env.srt.integration.test.ts`
   assert filesystem refusal only. The `VOLLI_SRT_INTEGRATION`-gated suite should
   gain a case asserting that a blocked call is recorded, not merely refused —
   the property the whole slice rests on.

## Part II — Runtime shape

Six deepening candidates, strongest first. Each was checked with the deletion
test: does removing the suspect module *concentrate* complexity, or merely move
it? Only "concentrates" is a reason to act. Candidates 1 and 3 shipped;
candidate 4 was answered by Part I rather than actioned.

### 1. Collapse the adapter registry into the Agent Runtime port — shipped

**Shipped 2026-08-11 (PRs #205, #206, #207).** The registry, the manifest, the
profiles and `profileId` were scaffolding and are gone; `SessionRuntime` holds one
injected executor port, which lives in `@volli/shared` so `@volli/session-engine`
— which the renderer imports, and which may therefore never take a Node dependency
— can name the type it holds. `adapterId` survives only as the discriminator
between a terminal companion attachment and the structured one.

`RuntimeObservation` is now the only observation vocabulary any layer names across
a boundary. The Session-shaped arms survive as `TranslatedObservation`,
unexported, the Engine's own intermediate shape in
`packages/session-engine/src/observation-translation.ts` — an earlier review was
right that the facade was an altitude crossing rather than a rename table, and
wrong only that the crossing had to be a *published* vocabulary. The 450 lines of
translation that left Electron main are the win.

**Three constraints from that review still bind, and outlive it:**

- **Widening `attention.reason` is a two-store migration, not a type widening.**
  It is an input to the frozen `session_events.id`
  (`pi:attention:${attachmentId}:${reason}`), *and* `isRecoverableObservation`
  whitelists exactly five values and **throws** on anything else, so markers
  already on disk would be rejected and the attach dies as `PI_RECOVERY_FAILED`
  rather than degrading. Adding an *arm* is safe in a way widening `reason` is not
  — the recovery sidecar validates by `kind` and never sees one it does not know —
  which is why the `interaction` arm could simply be added. Four Attention kinds
  (`rate_limited`, `quota_exhausted`, `transport_retrying`,
  `adapter_disconnected`) consequently have no writer: the union derives from
  `AttentionObservation["reason"]` through `ATTENTION_KINDS` and nothing maps to
  them. Nothing could reach them before either; `retryAt` and `resetAt` went with
  them.
- **Replay stays a separate, state-free translation path.** Routing it through
  the live translator would let a reconcile during an active turn reset
  `messageSequence` to 0, re-mint the same message id and emit `reset` over
  accumulated text — and `SessionRuntime.reconcile` is public and not gated on
  the binding being idle. The two share only the id counter.
- **The frozen id derivations moved verbatim**, with the `pi:` namespace supplied
  by the adapter through `NativeHarnessAdapter.durableIdNamespace`, so the Engine
  mints ids it does not name.

`attachment.closed.outcome` narrowed to `completed` in the *translation*, which
cannot say how the work inside an attachment went, only that it closed. The
durable event kind still carries all three, and the other two keep their
producers: a native failure arrives as `attachment.failed` and is written down as
`attachment.closed` with `outcome: "failed"`, and `interrupted` is written by the
boot sweep retiring local attachments a relaunch cannot reconnect to.

**Two defects that review surfaced are still open**, neither blocking:
`RuntimeFailure.reason` is dropped in translation (only `failure.message` survives
onto `attachment.failed`), and `transcript.delta` ids are computed and never
read. A third — `observationCursor()` exported with no production caller — was
resolved by deletion; the symbol is gone from the tree.

### 2. One codec for the Session Event

**Strength: strong.** `packages/shared/src/session-ledger.ts`,
`apps/desktop/src/main/session-control/sqlite-ledger.ts`,
`packages/session-rpc/src/index.ts`,
`apps/desktop/src/renderer/src/chat/wire.ts`.

One event kind must be written six times: the payload union, the SQLite encoder
and decoder, the renderer-safe scrub, the renderer's structural re-validation and
the transcript fold. The RPC edge validates inbound commands with a schema but
scrubs outbound frames with a mapped type plus a separate runtime switch, so the
two can silently disagree, and nothing fails to compile when a new kind falls
through to `default`.

Give the Session Event one codec owning its persisted form, its renderer-safe
form and its parse, exhaustive by construction.

**Deletion test: concentrates.** Deleting any single switch today just
re-scatters the same arms.

### 3. Retire the capability probe — shipped

**Shipped 2026-08-10 (PR #204).** `probe()` was doing three jobs, and only the
capability declaration had no reader; the runtime identity is a product fact
rather than a claim about a model, so it survives as static data on the profile,
and `volli.native-binding.v1` is unchanged on the wire. Two consequences were not
separable from it: `projectSession` lost its `now` parameter, capability expiry
having been its only reader, so the fold is now the pure total function over the
log its own comment already claimed, and `ProjectedHistory.staleAt` went with it.
Retiring a durable event kind also needed the read path to tolerate one it does
not know — now a convention in `CLAUDE.md`, since it is a property of the codec
rather than of this kind.

### 4. The interaction modules have no producer — resolved

**Resolved by Part I slice 4; nothing to action.** The premise was that roughly
1400 renderer lines sat at 100% coverage verifying behaviour nothing in
production emitted, while the Pi adapter refused `interaction.resolve` outright
(`PI_INTERACTION_UNSUPPORTED`) — a coverage gate certifying unreachable code.
Both halves of that are now false: the adapter emits `interaction.opened` for
every escalation and answers `interaction.resolve` from its parked map.
`apps/desktop/src/renderer/src/chat/interaction.ts` and
`apps/desktop/src/renderer/src/components/chat/interaction-ui.tsx` are exactly
what is needed. Do not revisit this as a deletion candidate.

### 5. One Session-start module

**Strength: worth exploring.**
`apps/desktop/src/main/session-runtime/{structured,ticket,project}-sessions.ts`,
`packages/session-rpc/src/index.ts`.

`ticket-sessions.ts` and `project-sessions.ts` are the same three steps — create,
record model, attach — differing by Role and one guard, behind four RPC
procedures each with its own unavailable branch. Both are shallow: the interface
is nearly as large as what sits behind it, and answering "how does a Session
start" means bouncing between four files.

One `sessions.start({ role, … })` and one `sessions.attach({ sessionId })`, with
the Role guard inside a single module.

**Deletion test: concentrates.** The Role rule stops being stated three times.

### 6. Move the Electron transport contract out of `@volli/shared`

**Strength: speculative.** `packages/shared/src/ipc.ts`,
`packages/shared/src/ipc-descriptors.ts`.

Two thousand lines of channel names, argument tuples and invoke validators live
in the package documented as pure domain code with no transport knowledge. The
module's own header is a set of rules about which process may import it at
runtime, which is a sign the seam is in the wrong place.

**Deletion test: moves rather than concentrates.** Worth doing for layer honesty,
not for leverage. Lowest priority here.

### Recommended order

**2 → 6**, with 5 available at any point as an independent slice.

Candidate 2 is next, and candidate 1 sharpened it: removing `profileId` from the
ledger, the RPC schema and the scrub shrank the codec's fan-out before the codec
is written. The rule that made candidate 3 go first — delete before you rewrite,
since porting a thing you intend to remove is strictly more work — applies again
if anything else turns out to be scaffolding.

Candidate 6 stays last because nothing depends on it, but it is **no longer
optional**, and on a product direction rather than on leverage. Layer honesty
alone made it speculative. The stated intent to keep the surface open for a
cloud-native or mobile client does not: `@volli/session-rpc` is already
transport-agnostic and can travel, while 129 raw Electron channels and their
2047-line contract sit inside `@volli/shared` — the one package such a client
would import for domain types.

## Part III — In-app Model Access sign-in

### Product decision

Signing in to a provider happens inside Volli. The bundled `pi` CLI, the terminal
handoff it exists for, and the integrity machinery that guards it are all deleted
in the same effort.

### What is true today

"Auth" covers three separate things here, and only one of them is missing.
**Credentials are not bundled and never were** — `PiFileCredentialStore` reads and
writes `~/.pi/agent/auth.json`, the same file the `pi` CLI uses. **Token refresh
already happens in-process**, since `piOwnedModels()` calls
`registerBunOAuthFlows()` and `Models.getAuth()` runs the refresh itself under the
store's lock, so staying signed in is solved. **Only initial sign-in is a terminal
handoff:** there is no login IPC anywhere in the tree, and Model Access Settings'
"Sign in" calls `openExternalSignIn` → `createModelAccessTerminal` → a `shell`
terminal running the bundled binary under `RESTRICTED_LOGIN_FLAGS`.

That binary is bundled by mechanism only. `verifiedPiCliResource` resolves
`resources/pi-cli/<target>/pi` and gates it on a `sha256` **and** a `treeSha256`
recorded in a tracked `manifest.json` (Pi 0.84.1). The binaries are gitignored,
arrive via `pnpm prepare:pi-cli` which is **not** part of `postinstall`, and exist
for `darwin-arm64` and `darwin-x64` only.

### Why it must change

1. **Sign-in is broken out of the box.** A fresh clone has no binary, so
   `modelAccessTerminal` stays `null` and the button fails with "Bundled Pi CLI
   is unavailable".
2. **It is macOS-only**, so on Windows and Linux there is no sign-in path at all.
3. **It is large** — roughly 66MB of archives across two targets, more unpacked,
   for one interactive flow.
4. **The first signed build will break it, silently.** `codesign` rewrites
   Mach-O bytes, so a `treeSha256` computed before signing cannot match after.
   The gate fails closed and the user is told the CLI is unavailable — a true
   statement with a misleading cause.
5. **It leaves the product surface.** Model Access is a Settings page; sign-in
   drops the user into a terminal to finish a Settings task.

### The API is public and sufficient

Verified against `@earendil-works/pi-ai` 0.84.1:

- `Models.login(providerId, type: AuthType, interaction: AuthInteraction): Promise<Credential>`
  and `Models.logout(providerId, options?)`, with `AuthType = "api_key" | "oauth"`.
- `AuthInteraction { signal?; prompt(AuthPrompt): Promise<string>; notify(AuthEvent): void }`.
- `AuthPrompt` is `text`, `secret`, `select` (options of `{ id, label, description? }`)
  or `manual_code`, each with an optional per-prompt `signal`. `prompt()` resolves
  with the entered or selected string — `select` returns the option id — and
  rejects on cancel or abort.
- `AuthEvent` is `info` (message plus links), `auth_url` (url plus instructions),
  `device_code` (user code, verification URI, interval, expiry) or `progress`.
- OAuth flows shipped in 0.84.1: anthropic, github-copilot, kimi-coding,
  openai-codex, openrouter, radius, xai. `OAuthAuth` carries `loginLabel` and
  `isSubscription`, which is what a provider picker should render.

pi-ai's own documentation states the division plainly: "Login/logout
orchestration is app-owned." Nothing here requires a CLI.

### Target architecture

**Where it runs.** Main. The credential never round-trips through the renderer
except in the one direction a human types it.

**The interaction channel.** `AuthInteraction` is a request/response protocol:
main starts a login and the flow blocks on an answer only the renderer can
supply. That is structurally identical to a `SessionInteraction`, and it **must
not be one** — it is not Session history, it belongs to Model Access rather than
to any Session, and a `secret` prompt carries an API key while the Session ledger
is durable. Build a **separate ephemeral channel**, correlated by a login-attempt
id, cancellable from either end, never persisted and never logged.

**Secret direction.** An `api_key` login means the user types a key into the
renderer and it crosses IPC to main. That is inbound and one-way: main writes it
through `credentials.modify` and never reads it back out. `CredentialInfo`
(`providerId` plus `type`) stays the only credential shape the renderer sees.

**Use `piOwnedModels()`, never `builtinModels()` directly.** `piOwnedModels`
calls `registerBunOAuthFlows()` first, which imports the OAuth flows statically;
`builtinModels()` re-takes pi-ai's variable-specifier dynamic import path, which
does not survive the Electron bundle. This landmine is defused in exactly one
place; keep it that way. Cross-process safety needs nothing new —
`PiFileCredentialStore` serializes the whole file under an advisory lock and
re-reads on each pass, so a credential the `pi` CLI refreshed concurrently is
carried forward rather than clobbered.

**UI.** Model Access Settings gains per-provider sign-in and sign-out; the four
prompt kinds and four event kinds are the entire surface. The repo's UI copy rule
applies. `auth_url` and `device_code` are the one justified exception — they need
an openable link and a copyable code, which no label alone expresses. There is no
API-key validation call: a wrong key surfaces on first use as a `ModelsError`
with code `auth`, and the UI must not imply it verified anything.

### What gets deleted

Once in-app sign-in works, in the same effort: `apps/desktop/resources/pi-cli/**`
and its `manifest.json`; `apps/desktop/scripts/prepare-pi-cli.mjs` and the
`prepare:pi-cli` script; `apps/desktop/src/main/pi-cli-resource.ts` —
`verifiedPiCliResource`, `piLoginLaunch` and the release-identity helpers; the
bundle-marker integrity module and its `.volli-pi-bundle.json`; both
`model-access` branches in `apps/desktop/src/main/pty/scope.ts`, the guards in
`pty/ipc.ts` and the `purpose` field in `packages/shared/src/terminal.ts`;
`createModelAccessTerminal` and `openProjectModelAccess`; and the `.gitignore`
entry for the binaries. Keep the **recovery concept** — a provider still needs to
distinguish "sign in" from "retry" — and rename the `external-sign-in` kind,
since after this it is not external.

### Implementation slices

1. Main-process login and logout over `piOwnedModels()`, driven by a headless
   `AuthInteraction`. No UI. Prove one real OAuth provider and one real API-key
   provider land in `auth.json`.
2. The ephemeral main↔renderer interaction channel, correlated per attempt, with
   cancellation from both ends.
3. Model Access Settings sign-in and sign-out over the four prompt kinds and four
   event kinds.
4. Delete the bundle and everything listed above.

### Testing and evidence

- Mapping `AuthPrompt` and `AuthEvent` to the surface model is pure — unit test.
- Login orchestration is testable with a fake `AuthInteraction` and no network.
- A test asserting no secret reaches the Session ledger, a transcript, or a log.
- A live sign-in is manual, paid evidence like the Pi smokes — a sibling of
  `pnpm smoke:pi` rather than a CI gate.
- After slice 4, a fresh-clone check: sign-in works with no prepare step.

### Risks and unverified assumptions

- **`device_code` and `manual_code` are what a terminal did for free.** The
  owner accepted deleting the escape hatch; verify each shipped provider's flow
  can be expressed in-app *before* slice 4, not after.
- pi-ai owns the flows. A pinned-revision bump can change prompt or event shapes.
- The API key crosses IPC. That path needs an explicit audit, and it is the one
  place this design widens secret exposure relative to the terminal.
- **"Works in the packaged app" stays unproven until a packaging lane exists.**
  `registerBunOAuthFlows` is precisely the thing that makes OAuth work there, and
  no packaged build has ever run.
- Deleting the CLI removes the only way to inspect or repair auth state outside
  Volli. A corrupted `auth.json` currently has a manual fix; afterwards it needs
  an in-app one.

## Open decisions

- Whether the Main-checkout Role ships with the pre-image commit or waits.
- Whether the fallback thresholds stay at 3 / 20 or are tuned against real usage.
  Slice 3 made denials countable and slice 4 acts on the counts, so there is both
  a record to tune against and a consequence to tuning: changing them now changes
  how often a person is interrupted, which it did not before.
- Packaging: an App-Sandboxed build cannot nest `sandbox-exec`, so distribution
  strategy and Part I's boundary are the same decision. Part III removes the
  *other* packaging hazard (the `codesign`/`treeSha256` gate), so doing it first
  leaves packaging with one problem instead of two.
- Whether any shipped provider's `device_code` or `manual_code` flow resists an
  in-app expression. That answer gates Part III slice 4, not the whole part.

## Research record

- <https://claude.com/blog/auto-mode-default-in-claude-code> — the default-mode
  change, its approval-rate reasoning, the classifier's categories and the
  fallback thresholds.
- `czottmann/pi-automode` at `bd82e29e` — evaluated and rejected as a dependency;
  its deterministic layer is the vendoring candidate.
- Claude Code permission modes, `PreToolUse` hooks and `canUseTool`; the
  Apache-2.0 `@anthropic-ai/sandbox-runtime`, already a direct dependency.
- OpenAI Codex CLI — `SandboxPolicy` × `AskForApproval`, and protected metadata
  paths carved from writable roots.
- Goose, Aider and OpenHands — respectively the granularity failure mode, the
  dirty-work pre-image commit, and model-self-reported risk.
- `@earendil-works/pi-ai` 0.84.1 `dist/auth/types.d.ts` and `dist/models.d.ts` —
  `Models.login`/`logout`, `AuthInteraction`, `AuthPrompt`, `AuthEvent`,
  `CredentialStore`, and the shipped OAuth provider set. Read directly from the
  pinned dependency rather than from documentation.
