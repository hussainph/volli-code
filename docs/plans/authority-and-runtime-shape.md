# Agent authority and runtime shape

**Status:** Part I decision complete, ready for implementation. Part II is a
candidate menu awaiting selection.

**Date:** 2026-08-10

**Scope:** The policy a Session executes under, and the shape of the seam the
Agent Runtime sits behind.

## Why this plan exists

Two efforts follow the Pi migration. They are recorded here rather than in
`pi-native-ticket-session.md` because that document describes a migration that is
finished: its Sessions 1–7 shipped, OpenCode is gone, and the singular Pi-backed
`@volli/agent-runtime` is the only structured executor. What follows is new
product work, not migration residue.

The two parts interlock, which is why they share a document:

- Part I makes auto mode honest. Its last step gives the `SessionInteraction`
  surface a producer, which is a question Part II would otherwise have to answer
  by deletion.
- Part II collapses the adapter registry into a single runtime port. That port is
  where Part I's evaluation seam belongs, so the order in which they land changes
  where the code goes.

Do Part I first. It is a decision already made; Part II is a menu.

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
reads repository state before a destructive git command; screens fetched content
for prompt injection; and falls back to asking after three consecutive blocks or
twenty in a session.

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
`@volli/shared` — `evaluate(call, snapshot, location)` — so the policy is
testable without a runtime, a process, or a model.

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

A classifier earns its cost when the dangerous categories are reachable. With all
network denied, no credentials in the child environment, and the filesystem
scoped and symlink-proof, a per-call model invocation would mostly re-derive what
the kernel already guarantees. Deterministic rules plus the existing sandbox
cover the realistic risk.

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

1 → 3 → 2, with 5 available at any point as an independent slice.

Candidate 1 first: collapsing the registry removes `profileId` from the ledger,
the RPC schema and the scrub, which shrinks candidate 2's fan-out before the
codec is written, and it retires candidate 3's pipeline as a side effect. It is
also the only candidate whose answer is genuinely in doubt — the Pi migration
called this scaffolding temporary, and the code has carried it as though
permanent through seven sessions.

## Open decisions

- Whether the Main-checkout Role ships with the pre-image commit or waits.
- Whether the fallback thresholds stay at 3 / 20 or are tuned against real usage.
- Whether candidate 1 lands before Part I, changing where the evaluation seam is
  wired.
- Packaging: an App-Sandboxed build cannot nest `sandbox-exec`, so distribution
  strategy and this boundary are the same decision.

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
