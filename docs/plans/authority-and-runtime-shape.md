# Agent authority and runtime shape

**Status:** Part I slices 1–3 shipped; slice 4 remains. Part II candidate 3
shipped and the order revised — see below. Part III decision complete, not
started.

**Date:** 2026-08-10

**Scope:** The policy a Session executes under, the shape of the seam the Agent
Runtime sits behind, and how a user signs in to Model Access.

## Why this plan exists

Three efforts follow the Pi migration. They are recorded here rather than in
`pi-native-ticket-session.md` because that document describes a migration that is
finished: its Sessions 1–7 shipped, OpenCode is gone, and the singular Pi-backed
`@volli/agent-runtime` is the only structured executor. What follows is new
product work, not migration residue.

The parts interlock, which is why they share a document:

- Part I makes auto mode honest. Its last step gives the `SessionInteraction`
  surface a producer, which is a question Part II would otherwise have to answer
  by deletion.
- Part II collapses the adapter registry into a single runtime port. That port is
  where Part I's evaluation seam belongs, so the order in which they land changes
  where the code goes.
- Part III moves sign-in into the app. It is independent of Part I in code, but
  it removes one of the two ways packaging currently breaks things that work
  today — the other being Part I's sandbox note — so it belongs in the same
  conversation.

Do Part I and Part III first; they are decisions already made. Part II is a menu.

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
substance. Scrutiny belongs at the level of intent, not the individual call.

This decision does not mean unbounded execution. Anthropic's auto mode routes
every tool call through a classifier that blocks actions which are irreversible,
destructive, or aimed outside the environment; keeps a category it will never
approve; checks whether a git push destination is public, private, or trusted;
reads repository state before a destructive git command; and escalates to the
human after three consecutive denials or twenty in a session.

Prompt injection is screened by a *different* mechanism, and the distinction
matters because it is a layer Volli does not have. A server-side probe scans tool
outputs before they enter the agent's context. The transcript classifier is
defined by never seeing tool output at all — that stripping is itself the
defence, since an injection would have to beat the probe and then steer the agent
into a tool call the classifier independently judges safe. An earlier draft of
this plan collapsed the two into one clause, which made "why no classifier yet"
read as though it covered injection. It does not, and nothing in Volli does.

The 97% and 39% figures above are from the product announcement; the engineering
post states 93% for the same approval rate. Quote 93% when citing that post.
`docs/research/claude-code-auto-mode-semantics.md` holds the full semantics and
the mapping onto what Volli built.

Volli's job is to earn the same default. What follows is what that requires here,
which is less than it sounds, because much of the boundary already exists.

### What is true today

- `AuthoritySnapshot` in `packages/shared/src/agent-runtime.ts` is a single-field
  interface whose field is a literal: `{ mode: "auto" }`.
- `apps/desktop/src/main/session-runtime/pi-adapter.ts` hardcodes
  `authority: { mode: "auto" }` when it builds a runtime spec.
- The same adapter declares the `interaction.permission` capability
  `state: "unavailable"`, so nothing in the product can raise a permission
  decision.
- `packages/agent-runtime/src/pi/runtime.ts` constructs its `Agent` with
  `initialState`, `streamFn`, `sessionId` and `toolExecution`, and nothing else.

`CONTEXT.md` defines the Authority Snapshot as "the durable policy granted to one
Session when it starts: which actions are automatic, which require a decision,
which are forbidden, and the classifier model allowed to help within
deterministic boundaries." None of that is currently recorded. The glossary
describes the destination; the code has not arrived.

### What is already enforced

This matters more than the gap, because it determines how much is left to build.

`packages/agent-runtime/src/pi/scoped-execution-env.ts` already runs every bash
call inside a Seatbelt sandbox through `@anthropic-ai/sandbox-runtime`:

- All network is denied. `PROCESS_SANDBOX_CONFIG` sets
  `deniedDomains: ["*"]` with `strictAllowlist: true`, no Unix sockets, no local
  binding.
- The environment handed to a child is sanitized, so no credential reaches it.
- Reads of the home directory are denied; reads and writes are scoped to the
  Session workspace.
- File tools reject any path outside the root **and reject symlinks**, so the
  scope cannot be walked out of.
- The process-global config carries no workspace paths at all. Each Session's
  root travels per command, and a gated integration test proves two Sessions at
  sibling roots cannot read each other's files in either attach order.

The categories Anthropic's classifier exists for — exfiltration, actions aimed
outside your environment — are therefore largely unreachable for a Session in a
Ticket worktree today. That is a real boundary enforced by the kernel, not a
policy layer that can be reasoned around.

### What is missing

Three things, in order of importance.

**A block is not a durable fact.** Pi's `beforeToolCall` seam, when it blocks,
causes the loop to emit an error tool result whose text is the supplied reason.
Today Volli does not use that seam at all, and the boundary it does enforce
speaks the same way: a path escape returns a `permission_denied` file error, and
a sandboxed command gets a kernel `EPERM`. Both surface only as a failed activity
in the transcript — an error string the model reads and may route around. No
Session Event records that a denial happened. Nothing is countable, nothing is
observable, and Attention never learns of it.

**There is no forbidden set.** Auto is currently all-or-nothing within the
sandbox. Inside a worktree an agent may rewrite `.git/hooks`, edit `.git/config`,
or run any git subcommand.

**There is no fallback.** Anthropic's design tolerates an aggressive classifier
because a user can be asked when it gets in the way. Volli declares
`interaction.permission` unavailable, so a block is terminal. Without an ask
channel there is no escalation state, only failure.

The ask channel itself is not missing — it is built end to end and unused. The
`SessionInteraction` ledger types, the `interaction.opened` and
`interaction.resolved` observations, the `interaction.resolve` command, the
SQLite ledger, the pure answering rules in the renderer and the interaction card
UI all exist and are covered. Only the Pi adapter opts out.

### Target architecture

#### The durable Authority Snapshot

Replace the literal with a record written when the Session starts and projected
to the UI:

- `mode`
- the work-location kind — `worktree` or `main-checkout`
- the tool bundle
- a rule-pack **id and hash**, not the rules inline
- `classifierModel`, initially `null`
- fallback thresholds

Pinning the rule pack by identity rather than by value satisfies `CONTEXT.md`'s
requirement that "a Settings change does not silently change a running Session's
authority" without freezing machine facts that must stay live.

Resolved paths, the current branch, remote visibility, repository status before a
destructive command, and the block counters are all computed at call time. They
are not policy; they are the state policy reads.

#### The evaluation seam

`AgentOptions.beforeToolCall` is Pi's in-process equivalent of `canUseTool`. It
takes the assistant message, the raw tool call, the validated arguments and the
current agent context, and may return `{ block, reason, terminate }`. It requires
no Pi CLI and no extension host.

Wire it inside `@volli/agent-runtime` to a pure evaluation function in
`@volli/shared` — `evaluate(call, snapshot, context)` — so the policy is
testable without a runtime, a process, or a model.

Only the decision is pure. Resolving a path, following a symlink and lexing a
command line all need `node:fs`, which `@volli/shared` may not import, so they
belong in `@volli/agent-runtime`, which normalizes a runtime tool call into the
value the pure function judges.

#### Denials as durable facts

A block must commit a Session Event before it reaches the model. This is what
turns the boundary from an error string into product behaviour: it makes denials
countable for the fallback threshold, visible in the transcript as a Volli
semantic fact rather than a failed tool, and available to Attention.

#### Escalation and the ask channel

Flip `interaction.permission` to available and open a real `SessionInteraction`
when the counters trip — three consecutive blocks, or twenty in a Session. The
renderer half already knows how to render and answer it.

### Role policy

The two Session Roles do not deserve the same policy, and this is the sharpest
product question in Part I.

A **ticket** Session runs in a Ticket worktree: branch-isolated, disposable, and
already sandboxed away from the network and the home directory. Auto is nearly
free there. The residual risk is inside the tree — add a forbidden set covering
`.git/hooks`, `.git/config`, `.volli/`, and git subcommands that leave the
worktree.

A **project** Session runs in the Main checkout, on the user's real working tree,
with their uncommitted work, on whatever branch is checked out. It inherits the
same sandbox widened to that root. It should not inherit the worktree's policy:

- forbid `reset --hard`, `checkout -- .`, `clean -fd`, `stash drop`, `rebase` and
  `commit --amend`
- forbid branch switching
- take an automatic pre-image commit of dirty work before the first edit, so the
  user's uncommitted work is recoverable

That last idea is Aider's, and it is the single best pattern found in the survey
for agents working a checkout a human also uses.

### Why no classifier yet

Keep `classifierModel: null`.

A classifier earns its cost when the dangerous categories are reachable. Three of
Anthropic's four block-rule groups need the network or the home directory, and
Seatbelt denies both outright. Their own tier 2 skips the classifier entirely for
in-project file writes on the same blast-radius reasoning. Deterministic rules
plus the existing sandbox cover most of the realistic risk here.

**But not all of it, and an earlier draft of this section overclaimed.** It said a
per-call model invocation "would mostly re-derive what the kernel already
guarantees." That is wrong about what their classifier is for. It is an *intent*
checker, not a boundary enforcer: its rules are anchored on the user's own
messages, and "everything the agent chooses on its own is unauthorized until the
user says otherwise." A kernel guarantees nothing about intent. A branch sweep, a
`push --force`, or an over-broad `rm` entirely inside the workspace is legal under
every rule we wrote and legal under Seatbelt, and only an intent check catches it.
The honest statement is that we accept that gap for now, not that it does not
exist.

The second thing only a classifier reaches: "evaluate the real-world impact of an
action, rather than just the surface text of the invocation." That is the rule a
lexer cannot implement, and it is the same gap our `eval`, base64 and
command-substitution residuals name.

It becomes warranted when either of two things changes: network egress is
allowlisted (which reopens exfiltration), or the Main-checkout Role ships to
users at scale. Keep the field in the snapshot so the seam exists before it is
needed.

### External evaluation

**`czottmann/pi-automode`** (`bd82e29e`, v1.11.0, MIT) was evaluated as the
primary candidate and **should not be taken as a dependency.** It is a Pi
*extension* registered for `pi-coding-agent` — the CLI and TUI layer — while
Volli embeds `@earendil-works/pi-agent-core`. Adopting it would pull the whole
terminal stack into Electron main. It also has no notion of two work locations,
no fallback-to-manual, and its own README states it is not a sandbox.

Its deterministic layer is worth having. `hard-deny.ts`, `paths.ts` and
`permissions.ts` import nothing from `@earendil-works` — they are pure Node under
MIT. Vendor them with attribution: a shell lexer that understands quoting,
redirects and operators, plus rules for TLS weakening, persistence mechanisms,
macOS platform weakening, destructive removals against system roots, and writes
to shell profiles. Take its classifier as design only. Vendoring rather than
depending also reflects that 51 of its 56 commits are from one author.

Note the honest caveat: porting a shell lexer copies its bypass surface. It does
not handle `eval`, base64, command substitution or `xargs`. It is sound as
defence in depth beneath Seatbelt, and unsound as a standalone boundary.

**From the wider survey**, the useful borrowings are Codex's policy shape — a
capability tier (`writable_roots`) kept orthogonal to an approval axis, which is
the only surveyed model where work location *is* the policy variable — and
Codex's habit of carving protected metadata paths out of every writable root.
Claude Code contributes the precedence order and the fallback thresholds. Goose
demonstrates the failure mode to avoid: approval at tool-name granularity, where
one approved shell tool chains anything.

### Implementation slices

1. Make `AuthoritySnapshot` a real record, persisted at Session start and
   projected to the UI.
2. Wire `beforeToolCall` to a pure `evaluate(call, snapshot, location)` in
   `@volli/shared`; vendor the deterministic hard-deny layer under MIT
   attribution.
3. Emit a denial as a durable Session fact.
4. Flip `interaction.permission` to available and escalate on the counters.

Follow-up, deliberately not in the first pass: the classifier, network
allowlisting, the Main-checkout policy and its pre-image commit, per-project rule
packs, and data-aware git rules.

### Testing and evidence

- `evaluate` is pure, so the policy table is a unit test with no runtime.
- The vendored hard-deny lexer keeps its upstream test corpus.
- A denial's durable fact needs a ledger round-trip test and a projection test.
- The escalation counters need a test that trips consecutive and per-Session
  thresholds independently.
- The existing `VOLLI_SRT_INTEGRATION`-gated sandbox test should gain a case
  asserting a *blocked* call is recorded, not merely refused.

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
- The 3-consecutive / 20-per-session thresholds are copied from Anthropic's post
  with no knowledge of how they were tuned. Treat them as a starting point.
- Denials becoming durable facts is a new event kind; its downstream projection
  assumptions have not been checked.

### Part I implementation record (2026-08-10)

Slices 1, 2 and 3 shipped. Slice 4 — escalation through the interaction channel
— is scoped below and not built.

**Sequenced before Part II candidate 1, and the reason is now evidence rather
than preference.** `AuthoritySnapshot` already travelled from `@volli/shared`
through `SessionRuntimeSpec.authority` into `@volli/agent-runtime`, so the
registry never sees it and enforcement landed without touching the facade at
all. The `AgentRuntime` port the collapse is meant to produce already exists at
`packages/agent-runtime/src/contracts.ts`; candidate 1 deletes
`NativeHarnessAdapter` *above* that port rather than creating it. Only slices 3
and 4 pay a facade tax, because only they mint new observation kinds.

**Where the plan above was wrong, corrected in the build:**

- The vendored hard-deny layer could not sit in `@volli/shared` beside
  `evaluate`, because `paths.ts` needs `node:fs`. Pure policy lives in shared;
  path and shell resolution live in `agent-runtime`.
- Only pi-automode's lexer and path helpers were vendored, not its rule body and
  not `permissions.ts`. Porting `segmentHardDeny` would have left the product
  with two rule tables able to disagree and no way to say which refused, and
  `permissions.ts` matches configured patterns like `bash(git push *)` against a
  call — a question Volli does not ask, so every function in it would have been
  dead code beneath a 100% coverage gate. The `ToolPattern` transitive import of
  `@earendil-works` is moot as a result.
- Work location is not derivable from the Session Role: a Ticket that never took
  a worktree runs in the Main checkout. `PiRuntimeContext` carries a required
  `location` field set from `ticket.usesWorktree`. Making it optional with a
  default would have marked every Session a Main checkout and rotted quietly.
- `packages/agent-runtime/src/prompt.ts` told the model "Process execution is not
  available in this migration slice" while `pi-adapter.ts` shipped `execute` in
  the bundle. The Authority layer now states the real boundary.

**Two boundary decisions worth not relitigating:**

- `path.outside-workspace` judges writes, not every command operand. The
  per-command Seatbelt policy denies the home directory and deliberately leaves
  `/usr`, `/etc` and `/opt/homebrew` readable so ordinary build and test commands
  work. A first pass checked every operand and thereby denied `ls /usr/bin`,
  `cat /etc/hosts`, `2>/dev/null` and any explicitly-pathed toolchain binary — a
  rule layer stricter than the boundary it backs up is a second, worse boundary,
  and `2>/dev/null` alone would have tripped the three-consecutive fallback on
  ordinary work. Rules 9 and 10 still read operands, because destructive removal
  and a git flag aimed at another tree are intent-level cases the kernel permits.
- `cp evil.sh <workspace>/.git/hooks/pre-commit` cannot be caught in the rule
  table without per-program positional parsing, which is how bugs get into
  security rules. It is closed one layer down instead: the per-command sandbox
  denies writes to `<workspace>/.git/hooks` and `<workspace>/.git/config`, the
  two paths normal git operation never writes and the two that change what later
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
values of its path-bearing flags; `rm` was not, because every one of its
operands is a deletion target. The refusal names the remedy — write the paths
literally — so the model has a next move rather than a dead end. Resolving
`$PWD`, which is derivable, would shrink this further if it proves noisy.

**A Session can no longer set its own git identity.** `~/.gitconfig` was already
unreadable under `denyRead: [homeDir]`, and denying `.git/config` writes removes
the workaround of the agent setting a local identity itself. This costs nothing,
because the agent is not the commit path: `apps/desktop/src/main/worktree/publish.ts`
resolves identity in main and runs `add`/`commit` outside the sandbox. It would
matter only if a Session were ever expected to commit through its own bash.

### Slice 3 record (2026-08-10)

`authority.denied` carries which tool, which rule, and the refusing rule's own
words, from `beforeToolCall` through the adapter to SQLite. Three decisions in it
are load-bearing.

**`cause` is stored as a bare string, not the rule-id union.** History outlives
the pack that wrote it. `sqlite-ledger.ts` decodes with `default: throw`, so a
decoder that rejected a retired rule id would not degrade one event — it would
make every later read of that Session fail.

**The count is projected; the streak cannot be.** `SessionProjection.authorityDenials`
exists because the per-Session half of the threshold is a fact about the Session,
and a counter that reset on every attach would never reach twenty. The
consecutive half has no projection and can never have one: an *allowed* call is
not an event, so only the runtime that sees both answers can know a run was
broken.

**A refusal goes through the same ordered queue as everything else.** The first
cut called `spec.observer` directly from `beforeToolCall`, bypassing
`OrderedObservationDelivery`. A refusal that overtook the turn it belongs to
would be filed against the wrong turn. `commitObservation` also never rejects, so
the "record, then refuse" ordering holds without a `try`/`catch` deciding what a
ledger failure means — a ledger that cannot be written is not a reason to let the
call through.

**One fail-open closed on the way past.** The renderer scrubbing switch in
`packages/session-rpc` ended in `default: return safeFrame`, so any newly added
payload kind reached the renderer unscrubbed with no compile error. It now lists
its pass-throughs explicitly with a `never` guard, the way the projection reducer
in `session-ledger.ts` already did.

### Slice 4 — scope, settled

Two stacked PRs. The escalation producer first, landing in today's interaction
card so it works end to end; then the drawer above the composer, which is also
where the existing card moves. The whole answer pipe — renderer, IPC, tRPC,
engine, durable event, adapter dispatch — already exists and is tested; only the
last hop into Pi is stubbed, which is why roughly 1400 renderer lines sit at 100%
coverage verifying something nothing produces.

**Counters.** `sessionDenials` seeds from `SessionProjection.authorityDenials`
through `PiRuntimeContextFields`, the way `location` did in slice 2;
`NativeAttachmentSpec` does not carry a projection and must not grow one.
`consecutiveDenials` is runtime-only. After any escalation both trips move
forward — consecutive to zero, the session trip to `total + sessionDenials` — so
it fires every twenty rather than once and then on every call after.

**The ask is a typed port, not an observation.** `SessionRuntimeSpec` gains
`ask?: (request) => Promise<answer>`. The adapter implements it by emitting
`interaction.opened` and parking the resolver against the interaction id, then
resolving it from the `interaction.resolve` dispatch. That keeps
`@volli/agent-runtime` free of ledger types. It blocks with no invented timeout:
cancellation comes from the vocabulary that already exists — `abandoned`,
`superseded`, `withdrawn` — and every parked resolver is cancelled on release and
on abort.

**Both causes ask; they differ in what they offer.** An overridable rule offers
`[once, reject]` — no `always`, because there is no durable policy store to write
it to and an option that silently means `once` is a lie. A rule that only reports
offers `[stop, continue]`: stop interrupts the turn, continue resets the counters
and keeps refusing. That is a real question with a real consequence, which is why
it is an interaction rather than an Attention — and it avoids widening the
Attention reason union for a state none of its members describes.

**We park where Anthropic terminates, and that is deliberate.** Their rule is
that in headless mode "there is no UI to ask the human, so we instead terminate
the process." Volli has no headless mode and no manual-approval mode to fall back
*to*, so terminating would destroy a Session to avoid asking a question the
product can hold open indefinitely. `sessionAwaitsUser()` already surfaces an
unanswered interaction in the sidebar and the chat listing, so a parked Session is
visible rather than silently stuck. Their word "fallback" should stop being
borrowed for this: ours is a check-in that re-arms auto, not a demotion to manual.

**The thresholds are inherited, not earned.** 3-consecutive and 20-per-Session
were tuned against a decider measured at 0.4% false positives over 10,000 real
sessions. A deterministic rule table is not that decider and its false-positive
rate here is unmeasured — the Part I record above documents one narrowly avoided
case where `2>/dev/null` alone would have tripped three-in-a-row. Slice 3 makes
the rate measurable for the first time. Ship 3/20 as provisional and read the
ledger before defending them.

**An unreadable call counts toward the streak.** A command the lexer cannot parse
is refused like any other and pushes the Session toward being asked. That is
right — the agent genuinely cannot proceed and the user genuinely should know —
but it means a parser limitation, not a policy judgement, is what interrupts
someone. Recorded here so it is a decision rather than a side effect.

**No new event kind for an override.** The `authority.denied` emit moves to
*after* the ask resolves and fires only when the call is actually refused;
otherwise history would record a denial for a call that ran. What the user
permitted is already durable as `interaction.opened` plus `interaction.resolved`
— the user's decision is an interaction fact, not a policy fact.

## Part II — Runtime shape

Six deepening candidates, strongest first. Each was checked with the deletion
test: does removing the suspect module *concentrate* complexity, or merely move
it? Only "concentrates" is a reason to act.

### How Part II interacts with Part I

Candidate 1 decides where Part I's evaluation seam lives. If the registry
collapses first, `beforeToolCall` is wired at a single runtime port; if not, it
is wired behind a translation facade that a later refactor must move.

Candidate 4 asks whether the renderer's interaction modules should exist at all,
given nothing produces what they consume. Part I answers that by giving them a
producer. **Do not delete that surface on candidate 4's evidence alone.**

### 1. Collapse the adapter registry into the Agent Runtime port

**Strength: strong.** `packages/session-engine/src/native-adapter.ts`,
`apps/desktop/src/main/session-runtime/pi-adapter.ts`,
`apps/desktop/src/main/lab/scenario-adapter.ts`,
`packages/agent-runtime/src/contracts.ts`.

Two near-isomorphic observation vocabularies exist — `RuntimeObservation` and
`HarnessObservation` — with a ~1000-line facade translating between them. The
seam has one product adapter; the lab's scenario adapter is a fake, which proves
the seam is *testable*, not that anything *varies*. Meanwhile `adapterId` and
`profileId` thread through 24 non-test source modules, the SQLite ledger, a
migration and the RPC command schema, then are stripped before the renderer sees
them.

Let `SessionRuntime` hold a single `AgentRuntime` port; the lab supplies a fake
at that same port. Keep `adapterId` only where it earns its place — as the
discriminator between a terminal companion attachment and the structured one —
and drop `profileId` and the registry.

**Deletion test: concentrates.** Translation moves into the module that already
owns Session facts, and a routing key leaves five layers that only pass it along.

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

### 3. Retire the capability probe

**Strength: strong.** `apps/desktop/src/main/session-runtime/pi-adapter.ts`,
`packages/session-engine/src/session-runtime.ts`,
`packages/shared/src/session-ledger.ts`.

`probe()` is a static literal by design, yet a whole pipeline carries it —
capability report, `capabilities.updated` ledger event, SQLite codec, RPC scrub,
renderer. The fabricated model entry was removed in the Session 7 review round,
which resolved the false-fact half of this. What remains is a pipeline whose only
payload is a declaration.

Either derive the catalog from the Session's recorded model selection and Model
Access, or delete the probe path and let refusals speak on the turn that hits
them — which is already what the adapter does for credentials.

**Deletion test: concentrates.** The only fact the pipeline carries is durable
elsewhere.

Note the dependency: **Part I gives refusals a durable representation.** This
candidate reads better after Part I than before it.

**Shipped 2026-08-10.** The probe turned out to be doing three jobs, not one. It
re-checked profile availability, which the profile lookup above it in the attach
path already does; it supplied the runtime identity; and it declared
capabilities. Only the third had no reader, so only the third and the redundant
check were deleted. The runtime identity is a product fact rather than a claim
about a model, so it survives as static data on the profile — the async call,
its 15-second timeout and its AbortController set are gone, and
`volli.native-binding.v1` is unchanged on the wire.

Two consequences were not separable from it. `projectSession` lost its `now`
parameter, capability expiry having been its only reader, so the fold is now the
pure total function over the log its own comment already claimed; and
`ProjectedHistory.staleAt` went with it, leaving `#history` to invalidate on the
ledger cursor alone.

Retiring a durable event kind also needed the read path to tolerate one it does
not know — recorded as a convention in `CLAUDE.md`, since it is a property of
the codec rather than of this kind.

### 4. The interaction modules have no producer

**Strength: resolved by Part I — do not action independently.**
`apps/desktop/src/renderer/src/chat/interaction.ts`,
`apps/desktop/src/renderer/src/components/chat/interaction-ui.tsx`.

Roughly 1400 renderer lines sit at 100% coverage verifying behaviour nothing in
production emits: the only producer of `interaction.opened` is the lab, and the
Pi adapter refuses `interaction.resolve` outright. The coverage gate certifies
unreachable code.

Read on its own, this looks like a deletion candidate. It is not. Part I step 4
flips the adapter's declaration and gives the surface its producer, at which
point the modules are exactly what is needed. Reassess only if Part I is
abandoned.

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

**Revised 2026-08-10, and candidate 3 is done.** The order is now
**3 → 1 → 2 → 6**, with 5 available at any point as an independent slice.

Two things changed the sequence this section originally proposed.

**Delete before you rewrite.** The probe was part of the adapter contract, so
collapsing the registry first meant porting the probe and then deleting it.
Candidate 3 first was strictly less work, and the reason this section gave for
deferring it — that refusals need a durable representation, which Part I
supplies — was already satisfied by slices 1–3.

Candidate 3 also moved ahead of Part I slice 4. The probe declared
`interaction.question` unavailable, which slice 4 makes false; retiring the
probe first means slice 4 never has to hand-correct a declaration on its way to
deleting it. Nothing read the declarations — the presentation projection
omitted capabilities, the renderer's own typed client omitted
`refreshCapabilities`, and only the lab scratch ever branched on a feature's
state.

**Candidate 6 is promoted, on a product direction rather than on leverage.**
This section rated it speculative and lowest priority, which was right when the
only argument for it was layer honesty. The stated intent to keep the surface
open for a cloud-native or mobile client changes that: `@volli/session-rpc` is
already transport-agnostic and can travel, while 129 raw Electron channels and
their 2047-line contract sit inside `@volli/shared` — the one package such a
client would import for domain types. The boundary is drawn in the wrong place,
and candidate 6 is what moves it. Still last, because nothing depends on it,
but no longer optional.

Candidate 1 keeps its place as the next one to do, and its own reasoning is
unchanged: it removes `profileId` from the ledger, the RPC schema and the
scrub, shrinking candidate 2's fan-out before the codec is written. It remains
the only candidate whose answer is genuinely in doubt — the Pi migration called
this scaffolding temporary, and the code has carried it as though permanent
through seven sessions.

## Part III — In-app Model Access sign-in

### Product decision

Signing in to a provider happens inside Volli. The bundled `pi` CLI, the terminal
handoff it exists for, and the integrity machinery that guards it are all deleted
in the same effort.

### What is true today

"Auth" covers three separate things here, and only one of them is missing.

- **Credentials are not bundled and never were.** `PiFileCredentialStore` reads
  and writes `~/.pi/agent/auth.json` — the same file, in the same place, in the
  same shape the `pi` CLI uses.
- **Token refresh already happens in-process.** `piOwnedModels()` calls
  `registerBunOAuthFlows()`, and `Models.getAuth()` runs the refresh itself
  under the credential store's lock. Staying signed in is solved.
- **Initial sign-in is a terminal handoff.** There is no login IPC anywhere in
  the tree. Model Access Settings' "Sign in" calls `openExternalSignIn` →
  `createModelAccessTerminal` → a `shell` terminal running the bundled binary
  under `RESTRICTED_LOGIN_FLAGS` with `PI_OFFLINE=1`, `PI_TELEMETRY=0` and
  `PI_CODING_AGENT_DIR` pointed at Volli's auth directory.

The binary itself is bundled by mechanism only. `verifiedPiCliResource` resolves
`resources/pi-cli/<target>/pi` and gates it on a `sha256` **and** a `treeSha256`
recorded in a tracked `manifest.json` (Pi 0.84.1). The binaries are gitignored;
only the manifest is in the repo. They arrive via `pnpm prepare:pi-cli`, which is
**not** part of `postinstall`. Targets are `darwin-arm64` and `darwin-x64` only.

### Why it must change

1. **Sign-in is broken out of the box.** A fresh clone has no binary, so
   `modelAccessTerminal` stays `null` and the button fails with "Bundled Pi CLI
   is unavailable".
2. **It is macOS-only.** There is no Windows or Linux target, so there is no
   sign-in path on those platforms at all.
3. **It is large** — roughly 66MB of archives across two targets, more unpacked,
   to provide one interactive flow.
4. **The first signed build will break it, silently.** `codesign` rewrites
   Mach-O bytes, so a `treeSha256` computed before signing cannot match after.
   The gate fails closed, `modelAccessTerminal` becomes `null`, and the user is
   told the CLI is unavailable — a true statement with a misleading cause.
5. **It leaves the product surface.** Model Access is a Settings page; sign-in
   drops the user into a terminal to finish a Settings task.

### The API is public and sufficient

Verified against `@earendil-works/pi-ai` 0.84.1:

- `Models.login(providerId, type: AuthType, interaction: AuthInteraction): Promise<Credential>`
- `Models.logout(providerId, options?): Promise<void>`
- `AuthType = "api_key" | "oauth"`
- `AuthInteraction { signal?; prompt(AuthPrompt): Promise<string>; notify(AuthEvent): void }`
- `AuthPrompt` is `text`, `secret`, `select` (options of `{ id, label, description? }`)
  or `manual_code`, each with an optional per-prompt `signal`
- `AuthEvent` is `info` (message plus links), `auth_url` (url plus instructions),
  `device_code` (user code, verification URI, interval, expiry) or `progress`
- `prompt()` resolves with the entered or selected string — `select` returns the
  option id — and rejects on cancel or abort
- OAuth flows shipped in 0.84.1: anthropic, github-copilot, kimi-coding,
  openai-codex, openrouter, radius, xai
- `OAuthAuth` carries `loginLabel` and `isSubscription`, which is what a provider
  picker should render

pi-ai's own documentation states the division plainly: "Login/logout
orchestration is app-owned." Nothing here requires a CLI.

### Target architecture

**Where it runs.** Main. The credential never round-trips through the renderer
except in the one direction a human types it.

**The interaction channel.** `AuthInteraction` is a request/response protocol:
main starts a login, and the flow blocks on an answer only the renderer can
supply. That is structurally identical to a `SessionInteraction`, and it must not
be one:

- it is not Session history — it belongs to Model Access, not to any Session
- a `secret` prompt carries an API key, and the Session ledger is durable

Build a **separate ephemeral channel**, correlated by a login-attempt id,
cancellable from either end, never persisted and never logged. `CONTEXT.md`
already requires that the credential owner never exposes secrets to the renderer,
prompt, transcript, or Session ledger.

**Secret direction.** An `api_key` login means the user types a key into the
renderer and it crosses IPC to main. That is inbound and one-way: main writes it
through `credentials.modify` and never reads it back out. `CredentialInfo`
(`providerId` plus `type`) stays the only credential shape the renderer sees.

**Use `piOwnedModels()`, never `builtinModels()` directly.** `piOwnedModels`
calls `registerBunOAuthFlows()` first, which imports the OAuth flows statically.
Reaching for `builtinModels()` re-takes pi-ai's variable-specifier dynamic import
path, which does not survive the Electron bundle. This landmine is already
defused in exactly one place; keep it that way.

**Cross-process safety needs nothing new.** `PiFileCredentialStore` serializes
the whole file under an advisory lock and re-reads on each pass, so a credential
the `pi` CLI refreshed concurrently is carried forward rather than clobbered.
Login persists through the same `modify` path.

**UI.** Model Access Settings gains per-provider sign-in and sign-out. The four
prompt kinds and four event kinds are the entire surface. The repo's UI copy rule
applies — labels are nouns and the control is the explanation. `auth_url` and
`device_code` are the one justified exception: they need an openable link and a
copyable code, which cannot be expressed by a label alone.

**There is no API-key validation call.** A wrong key surfaces on first use as a
`ModelsError` with code `auth`. The UI must not imply it verified anything.

### What gets deleted

Once in-app sign-in works, in the same effort:

- `apps/desktop/resources/pi-cli/**` and its `manifest.json`
- `apps/desktop/scripts/prepare-pi-cli.mjs` and the `prepare:pi-cli` script
- `apps/desktop/src/main/pi-cli-resource.ts` — `verifiedPiCliResource`,
  `piLoginLaunch`, and the release-identity helpers
- the bundle-marker integrity module and its `.volli-pi-bundle.json`
- both `model-access` branches in `apps/desktop/src/main/pty/scope.ts`, the
  guards in `pty/ipc.ts`, and the `purpose` field in `packages/shared/src/terminal.ts`
- `createModelAccessTerminal` and `openProjectModelAccess`
- the `.gitignore` entry for the gitignored binaries

Keep the **recovery concept** — a provider still needs to distinguish "sign in"
from "retry". Rename the `external-sign-in` kind, since after this it is not
external.

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
  Slice 3 made denials countable, so there is a record to tune against; nothing
  acts on the counts until slice 4, so tuning them costs nothing yet either.
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
