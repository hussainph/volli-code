# Volli Code

Local-first planner and execution workspace. This glossary is the canonical project language. Some Session and Automation terms below describe planned architecture; code and tests remain authoritative for current behavior.

## Language

**Ticket**:
A board card whose Ticket Body can scope a Ticket Session. Opening it shows the Ticket workspace; moving it to Doing records work state but does not start a Session.

**Ticket Body**:
The ticket's canonical Markdown scope and starting instruction, authored by a human or agent. It is part of the ticket record, not a file or Artifact.
_Avoid_: Ticket Doc, ticket document, ticket artifact

**Runtime Brief**:
The agent-ready projection of a Ticket at session launch: its Ticket Body plus resolved context and operating instructions. It is generated from ticket state rather than being canonical ticket content.
_Avoid_: Ticket Body, ticket document

**Dangling Reference**:
A Ticket Body file reference that no longer resolves in that ticket's context.
_Avoid_: missing Attachment, broken Artifact

**Ticket workspace**:
The expanded working surface for one ticket. Its main tabs hold the Ticket Body, Sessions, files, and diffs; its Now, Diffs, and Files rail keeps repository state, properties, Session history, and file navigation beside them.
_Avoid_: ticket worktree, artifact view

**Home**:
The project-level tabbed workspace, and the app's landing page. Its permanent
first tab is the Board; the project's own Project Sessions and Project Files
open as tabs beside it. Opening a ticket takes Home over: the Ticket workspace
fills the surface and Home's tab strip steps aside, so only one tab strip is
ever on screen.
_Avoid_: Board (for the page), Sessions page, dashboard, Files (as a nav item)

**Project Files**:
Main-checkout files opened as tabs in Home, browsed from a Files page in Home's
own rail. Not a first-class nav item or a standalone page (retired VC-122; the
rail page and tabs are VC-121).
_Avoid_: global files, project file tab, Files page, Files nav

**Ticket Files**:
The ticket-workspace view of files in that ticket's worktree.
_Avoid_: Project Files, artifact files

**Session**:
The durable identity and locally ordered history of an agentic conversation. A
Session is created before any executor attaches and outlives terminal panes,
processes, the Agent Runtime, UI surfaces, and execution venues. It remains
openable after an attachment, turn, or Run completes; only explicit archival
changes its availability. A Session may belong to one Ticket or be
project-scoped.
Each Session has a Role and model policy, and each of its attachments is
governed by an Authority Snapshot frozen when that attachment opens. Reconnect,
restart, and recovery may replace its live executor attachment without changing
that identity. A model change is an explicit recorded action, never a silent
fallback.
_Avoid_: pane session, split session, harness process, terminal pane, UI tab

**Session Role**:
The product scope a Session acts within: `project`, `ticket`, or `subagent`.
Project Sessions orchestrate project work; Ticket Sessions execute with explicit
Ticket and worktree context; Subagent Sessions perform a bounded delegation and
remain durable children of the Session that created them. Role determines the
default context, tool bundle, and authority policy, not a separate Session type.
A Project Session runs on the Main checkout with no worktree and no board
involvement, and is recorded in Session history exactly as a Ticket Session is.
_Avoid_: harness mode, agent mode, plan mode, scratch session

**Authority Snapshot**:
The durable policy one attachment runs under: which actions are
automatic, which require a decision, which are forbidden, and the classifier
model allowed to help within deterministic boundaries. Built at every
attachment from the project's Authority Policy and recorded on the attachment,
so a refusal can name the rule pack that produced it. A Settings change does
not silently change a running Session's authority: the Snapshot is pinned for
the life of the attachment, and a policy change applies at the next one. An
attachment rebuilt after a relaunch replays its recorded Snapshot rather than
re-resolving policy, so "the life of the attachment" outlives the process.
_Avoid_: permission preset (when meaning live authority), auto-approve flag

**Authority Policy**:
The per-project document an Authority Snapshot is built from: the enforcement
posture, the judgment mode, the fallback thresholds, and what each actor kind
may do. It is app-owned state, never a file in the worktree and never
repo-committed — a policy store the agent can write would let the thing being
governed author its own permissions. Built-in defaults with per-project
departures; a project list that names `$defaults` extends rather than replaces.
_Avoid_: rule pack (that is the compiled rules the policy runs), settings

**Enforcement posture**:
What a project's Authority Policy does with the rule pack. `off` builds no
Snapshot, so no gate is installed and the Session runs at the runtime's own
defaults. `observe` pins and records the Snapshot and installs no gate. `enforce`
hands the Snapshot to the runtime and the pack binds. `observe` is the default.
_Avoid_: auto mode (that is the judgment mode), permission mode

**Session Event**:
An immutable fact in a Session's locally ordered ledger: an attachment outcome,
native observation, command outcome, message/turn boundary, or recovery signal.
The Session Engine assigns the per-Session sequence; timestamps are metadata, not
ledger order. Session Events are not Ticket Events, although a planner event may
cite a Session as provenance.
_Avoid_: session state, hook state, terminal state

**Agent Thread**:
A durable conversation lane inside a Session. Every Session begins with one root
Agent Thread. Disposable runtime reasoning may use internal branches, but
delegated work whose output matters becomes a durable child Session rather than
an invisible provider-owned Thread.
_Avoid_: provider session, subagent pane, terminal split

**Conversation Branch**:
An immutable lineage of messages within an Agent Thread. Editing an earlier
message creates a new Branch instead of rewriting committed history.
_Avoid_: edited transcript, current messages array

**Generation Attempt**:
One model response attempt on a Conversation Branch. Regeneration creates a
sibling Attempt and retains the earlier result.
_Avoid_: retry count, overwritten response

**Context Compaction**:
Replacing the older part of an Agent Thread's context with a summary of it, so
the Session can continue past the model's window. It is linear and additive: the
summary is appended, the history before it stays in durable local history, and
only what the model is sent changes. It happens for one of three reasons — a
reserve threshold, an overflow the provider refused, or an explicit request —
and each one is a Session Event. Only the threshold is policy: one app-wide
switch decides whether a Session compacts before it is asked to, and every
Session runs on the executor's own reserve (per-model reserves retired,
VC-155). Switching the threshold off never withholds the recovery an overflow
triggers.
_Avoid_: truncation, trimming history, pruning the transcript

**Agent Runtime**:
The product-aware execution package that hosts Volli's agent loop. It receives a
Session Role, work location, model policy, prompt resources, scoped tools, and
an Authority Snapshot when the host supplies one; it emits runtime observations
and tool requests without owning
durable Session or Ticket state. Pi is its initial acknowledged substrate, but
Pi types and events never become renderer or Session contracts. The package may
depend on Node but never Electron or DOM APIs, so Electron main can host it
locally and a future worker can host the same package elsewhere.
_Avoid_: harness adapter, provider runtime, Electron service, renderer client

**Model Access**:
One sanitized view of the provider accounts, subscriptions, API credentials,
gateways, local inference, and models the Agent Runtime can truthfully use. The
credential owner never exposes secrets to the renderer, prompt, transcript, or
Session ledger. Availability and billing source are explicit; Volli never
silently falls back to another model or account.
_Avoid_: harness profile, provider picker (when meaning the complete access model)

**Web Access**:
The app-wide decision about whether Volli may reach the Internet on a
Session's behalf, and through whose search provider. Off is the default and the
resting state: an app with no configured provider gives its Sessions no
web tool at all, rather than a tool that refuses when called. A provider
endpoint is a person's own configuration and is judged by its own admission
policy when saved and again on every request; a URL the model supplies is not,
and faces the stricter public-web policy every time. The credential owner keeps a
bring-your-own key in the profile's own user-only store — the trade Pi's
`auth.json` already makes, rather than the OS keychain, whose per-binary prompts
cost more than they bought — and never exposes it to the renderer, prompt,
transcript, or Session ledger. The renderer may learn only whether a key
exists. What a search returns is third-party text, references rather than
contents, and reading one of them is a new decision judged from scratch.
_Avoid_: web search setting, browsing, internet permission

**Agent CLI**:
The bash-composable `volli` verb surface a Session's shell (or a person's
terminal) reaches through the local agent socket. It is the discovery surface
and the low-risk coordination surface: reads, plus writes that are visible,
attributable, and reversible. Any process running as the user can reach it, so
a Session proves itself with a per-attachment token rather than by naming
itself; a caller without one is the unauthenticated Actor and reads only. The
token defeats an injected string and cross-session confusion, not a hostile
same-uid process — so a verb whose misuse cannot be tolerated from an arbitrary
such process still does not belong here.
_Avoid_: agent surface (alone), planning CLI

**Agent Tool Surface**:
The named, schema'd tools a Session receives inside the Agent Runtime:
`bundle(Role) ∪ grants(session)`. A grant is durable app-owned data, scoped with
its verb, and frozen at Session birth; it is never a hot bundle edit. A tool call
is bound to the Session that made it and never crosses the agent socket, so
availability itself is enforcement: what a Role or birth grant did not hand it
cannot be called.
_Avoid_: Pi tools (as product vocabulary)

**Client Surface**:
A host API a Volli client — the desktop renderer, a future mobile or cloud
client — speaks for the humans driving the product. Clients talk to hosts,
never to databases, and no client is an agent.
_Avoid_: renderer API, app surface

**External Agent Surface**:
A future boundary (for example an MCP server) exposing Volli operations to
agents Volli does not host. A foreign agent has no Session Role and no
Volli-attached identity, so this surface carries its own admission policy and
never re-exposes a Role bundle as-is.
_Avoid_: MCP surface (as a synonym for the Agent Tool Surface)

**Verb Registry**:
The single enumerable declaration of every agent-facing verb: its name, what it
does, which surfaces project it, and the one handler binding that answers it —
where that handler lives, and which handler it is. Each surface exposes a
projection of the registry; no surface owns verbs of its own, and the socket's
dispatch is a table keyed by the binding rather than a chain checked against it.
_Avoid_: command list, tool list (when meaning the declaration rather than one
surface's projection)

**Verb Tier**:
The governance class a verb's access modes imply, never a stored field. Read
tier: Agent CLI, any caller. Coordination tier: Agent CLI, authenticated
session actor, judged by per-actor policy. Control tier: named tool only, held
through a Role bundle or a scoped birth grant, absent from the agent socket. A
verb on no agent surface at all holds no tier. No verb needs a higher tier than the ambient authority its
effect already lies within.
_Avoid_: dangerous tier, middle tier

**Cache Prefix**:
The byte-identical leading portion of a model request that a provider reuses
between requests. One changed byte invalidates everything after it; where the
provider orders the tool array before the system prompt, a tool change
invalidates the prompt too. Within a Session, the Agent Tool Surface and system
prompt therefore never change after start — a state change is modeled as a tool
call or a message, never as a re-composed prompt. The sanitized tool names and order are durable
Session input; reattachment rebinds that exact surface or fails without sending
a different one. Credentials are never part of the durable shape.
_Avoid_: cache hit (one outcome of a stable prefix), prompt cache (the provider feature)

**Context Assembly**:
The composition of one model request: system prompt, tool array, and message
history, ordered stable-first. Assembly is cache-stable when every byte that
varies per session or per turn — workspace path, date, ticket state — is
delivered as late as possible, in message content rather than prompt bytes.
Volli's assembly is deterministic: the system prompt is a pure function of
Role, bundle, product version, and resource set; same inputs, same string.
_Avoid_: prompt building, context window (the model's capacity, not the request)

**Turn Reminder**:
Volatile fact delivered as content in a message at the turn that needs it,
instead of bytes in the system prompt: the date, the working directory, live
ticket state. The Runtime Brief is the first and largest one.
_Avoid_: system reminder (a provider's wrapper, not Volli's), dynamic prompt section

**Cache class**:
How often one section of an assembled request is bought again at write price
rather than read from the provider's cache: `role-static`, `project-static`,
`session-static`, or `per-turn`. It is a claim derived from what the section is
composed from, never a measurement — reported per section by `prompt baseline`
beside what the section costs, and falsifiable by the cache read and write token
counts a turn actually reports. A message-side section is marked as one, because
the same class prices differently there: it is appended once and can invalidate
no Cache Prefix ahead of it.
_Avoid_: cache tier, TTL (the provider's retention window, not a section's
stability), static/dynamic (says nothing about how often)

**Metered operation**:
One model call Volli made on a Session's behalf, and what the provider said it
consumed: uncached input, output, cache-read and cache-write tokens, each
counted apart because each is priced apart. Its `cause` says which kind of work
bought it — an `assistant` reply, a Context Compaction, or `utility` work such
as auto-titling. A reply that only called tools, a reply that failed after its
prompt was billed, and every attempt in a retry storm are each one of these; a
turn is usually several. Recorded as a `usage.recorded` Session Event, never as
metadata on the message it happened to produce — most metered operations produce
no message at all. An unreported number is absent, never zero: a provider that
charged nothing and a provider that said nothing are different facts.
_Avoid_: request (says nothing about billing), token count (only one of four),
message usage (most spend has no message)

**Cost basis**:
What a cost number IS: `provider-reported` when a backend supplied its own
accounting, `catalog-estimate` when the executor multiplied token counts by a
local price table, `unavailable` when Volli cannot vouch for either. Almost all
of Volli's costs are estimates — right about consumption, only approximate about
the invoice, and sharply so for subscription-backed models where a list-price
value can be calculated for traffic nobody is marginally billed for. A report
summarising several bases says `mixed` rather than choosing one, and no local
total may be presented as provider account spend.
_Avoid_: bill, actual cost, spend (all claim an invoice Volli has not seen)

**Usage projection**:
The rebuildable index of metered operations, one row per operation, keyed by the
Session Event that proves it. It is a fact index and never a stored total:
nothing writes a running sum a later fact could contradict, and dropping the
whole table loses nothing that the ledger cannot derive again. Ticket, Session,
model and time rollups are query-time aggregation over it. Attribution is
copied when the operation is recorded rather than joined at read time, so
deleting a Ticket cannot move its old spend into unticketed Project spend.
_Avoid_: usage table (understates that it is derived), cost cache, running total

**Cached input share**:
Cache reads as a fraction of all prompt tokens — `cacheRead / (input + cacheRead

- cacheWrite)`. It is the measurement that a **Cache class** predicts, and a
  falling share is an operational incident rather than a curiosity: cache reads
  bill at roughly a tenth of an uncached input token and writes at more than one.
  _Avoid_: cache hit rate (providers report token classes, not one hit-or-miss bit
  per request)

**Session Semantic Fact**:
A product-owned fact produced at the Agent Runtime boundary and committed to the
Session: message content, an interaction, activity, Thread lineage, attachment
selection, or another identity, lifecycle, control, or historical meaning.
Presentation labels, icons, grouping, and layout are not semantic facts. Pi or
model-provider detail that Volli has not adopted remains bounded diagnostic
metadata until the product deliberately promotes it into this vocabulary.
_Avoid_: UI state, provider payload, component props

**Session Presentation Contract**:
The portable consumer boundary that projects Session Semantic Facts, Role, and
Authority Snapshot into a surface model for a Volli client. It determines which
shared affordances are meaningful and progressively discloses active product
state, but does not parse Pi or provider protocols or require Electron or React.
Presentation dispatch follows Volli semantic kind and state, never runtime tool
identity.
_Avoid_: harness-specific screen, provider renderer, component registry

**Session Surface Model**:
The framework-neutral output of the Session Presentation Contract. It describes
the meaningful transcript, attention, active ephemeral affordances, available
controls, and historical summaries that a client may render; each Volli client
maps it to its own components without reinterpreting runtime-native data.
_Avoid_: React tree, Electron view model, provider payload

**Thread Binding**:
The live or historical binding from an Agent Thread to a Session Attachment and
its native conversation locator. Each Agent Thread has at most one live Binding;
the first Agent Runtime slice has one root Thread and retains the existing
single-live-executor behavior.
_Avoid_: Session, provider session, terminal pane

**Session Attachment**:
One historical association between an existing Session and an executor or
transport: its runtime identity, native recovery reference where available,
venue, and attach/detach outcome. A Session keeps many historical attachments
but has at most one live executor attachment. A terminal companion is a workspace
view, not an alternate structured attachment.
_Avoid_: Session, terminal, harness state

**Command**:
Durable, explicit user intent directed at a Session, recorded before the Agent
Runtime is asked to act. A Command does not imply that a transport accepted or
completed the work; ambiguous delivery is reconciled before it is retried.
_Avoid_: action, keystroke, request (when referring to accepted work)

**Receipt**:
The durable runtime-boundary record of a Command's observed outcome: accepted,
rejected, completed, or unreconciled. A Receipt makes delivery observable
without claiming an unsupported native guarantee.
_Avoid_: event, acknowledgement (when no durable outcome exists)

**Session Engine**:
The UI- and runtime-implementation-agnostic interface that owns Session
commands, facts, projections, and their durable storage contract. Electron main
is its only SQLite writer in the initial local deployment; the interface is
deliberately portable to a future daemon, cloud sandbox, or mobile client.
_Avoid_: Electron main, Agent Runtime, renderer store

**Attention**:
A reconstructible projection of committed Session facts that tells the user
whether recovery or input is needed. It is not a source of truth and never
turns silence alone into an agent lifecycle fact.
_Avoid_: waiting flag, notification state

**SessionInteraction**:
A decision a Session is waiting on — a permission or a question — held in Volli
terms: a title, optional detail, declared options, and an opaque runtime
reference used to correlate its reply. It is durable ledger content, so it
survives a reload and outlives the turn that raised it; only an answer or a
cancellation ends the wait.
_Avoid_: approval, prompt (that is one question inside it), Attention

**SessionInteractionPrompt**:
One question inside a SessionInteraction, with its own options, whether several
may be chosen, and whether the runtime accepts free text beside them. A
permission is one prompt; a grouped decision declares one prompt per question.
Records written before interactions carried questions project as a single
prompt.
_Avoid_: prompt (the model's input), field, form

**SessionInteractionOption**:
One declared choice on a prompt: an id, a label, and an optional description.
Ids are runtime-correlated values, except for the permission vocabulary Volli
mints (`once`, `always`, `reject`); an unrecognized id is an ordinary answer and
never inferred to mean consent or refusal.
_Avoid_: button, action, permission mode

**SessionInteractionAnswer**:
One prompt's answer: the option ids chosen, plus free text where that prompt allows it. Answers are per prompt, so a set of ids is always read against the question that declared them.
_Avoid_: response, decision (that is the whole resolution)

**SessionInteractionResolution**:
The user's whole decision on one SessionInteraction, carried as the answers it gave. A resolution that chose nothing and said nothing is a refusal, not a missing answer. It is the durable record of what was authorized; a cancelled interaction never carries one.
_Avoid_: Receipt, outcome, answer (that is one prompt's)

**SessionInteractionCancelReason**:
Why an interaction stopped waiting without a decision: `abandoned` (the user
left it unanswered), `superseded` (a newer interaction replaced it), or
`withdrawn` (the runtime stopped asking). None of them is an answer, and none may
be read downstream as a refusal.
_Avoid_: rejection, denial, timeout

**SessionInteractionProjection**:
The reconstructed view of a Session's interactions: those still waiting, and those resolved, each with its resolution and when it was given. Derived from committed Session Events, never a source of truth.
_Avoid_: pending list, approval queue

**Split Tab**:
One returnable tab-strip item that presents multiple independently owned surfaces together.
_Avoid_: split session, pane tree

**Ticket ID**:
The opaque, permanent record identity of a ticket (a UUID). Never shown to users, never derived from mutable fields.
_Avoid_: using `"VC-12"`-style strings as identity

**Display ID**:
The project-unique human handle `<PREFIX>-<n>` (for example `VC-12`), used by the UI, branches, and `volli` CLI. It is derived presentation, never record identity.
_Avoid_: id, ticket id (when meaning the handle)

**Label**:
A first-class, project-scoped entity attached to tickets: a name plus an optional stored color. Without a stored color, the chip color is hash-derived from the name; a stored color wins.
_Avoid_: tag (the pre-persistence term for ad-hoc strings)

**Ticket event**:
One append-only planner-history record of something that happened to a Ticket
(created, status changed, comment added, …). It records Ticket facts and
planner-level consequences only; executor conversation facts live in the
Session Event ledger. A Ticket Event may cite a Session as provenance.

**Ticket Signal**:
A typed verdict on a Ticket — a fixed kind (validate, implement, review,
merge, human-gate, budget), a verdict (pass, fail, blocked), and optional
prose detail — recorded as a `signaled` Ticket Event by an authenticated
Session actor (VC-85). Signals carry state; comments carry prose. A signal
never moves the board: Deliberate moves and Run Outcomes own movement.
_Avoid_: verdict comment, `VERDICT:` first line, status (that is a column)

**Ticket Wake**:
One committed Ticket Event, fanned out in-process after its transaction
commits (`ticket-wake.ts`). The wake bus is main's canonical post-commit
stream: every mutation door feeds it, and the await tool parks on it. A wake
is never a source of truth — the durable event it reports already is.
_Avoid_: notification, broadcast (that is the window fan-out)

**Await**:
The control-tier wait: a Session's `ticket_await` tool call parks its turn
until a watched Ticket signals, is commented on, or moves — then wakes with
that one event (VC-85). Runtime-native like `ask_user`: no bash sleeps, no
polling, and never a CLI verb, because a CLI verb must never wait. What may
be awaited is per-actor policy data (`awaitable`); chaining the opaque `cursor`
returned by every wake or timeout makes the watch window continuous. A cursor
is ledger order; `occurredAt` is metadata and must never be used as one.
_Avoid_: watch verb, `volli ticket wait`, polling loop

**Project**:
A tracked codebase folder: name, path, ticket prefix, rail position. Removing one from Volli never touches the folder on disk. **The one user-facing word for a rail entry** (VC-57 ruling): every surface says "project" — "project switcher", "Project override", "Set by this project" — and it anchors the session language too (project-level vs ticket-level sessions). The design lineage is Arc's Spaces, but the word is not borrowed with it. Internal identifiers (`useWorkspaceStore`, `workspaceRailHidden`) are wire format, not copy.
_Avoid_: workspace (claimed by Ticket workspace — the ticket surface), space

**Ticket worktree**:
The isolated git checkout a ticket works in: branch `volli/<DISPLAY-ID>-<slug>`, directory `~/.volli/worktrees/<project-dirname>-<short-id>/<DISPLAY-ID>-<slug>/`. App-owned (outside both the repo and Electron's `userData`), named once at creation — neither branch nor directory is renamed when the ticket title changes.
_Avoid_: workspace (that's the whole ticket surface), checkout (ambiguous with the main checkout)

**Artifact**:
A durable, project-scoped output or reference, stored as a file or bundle and reusable across tickets. Its format determines how Volli presents it.
_Avoid_: ticket artifact, Attachment, Change Set

**Attachment**:
A ticket-scoped starting-context item, either an imported file or a URL reference, retained with the ticket and presented to its sessions.
_Avoid_: Artifact, Project Doc

**Change Set**:
The ticket-scoped body of source changes relative to its base branch, including committed and uncommitted work. It is live ticket state, not an artifact.
_Avoid_: artifact, diff (when referring to the whole body of work)

**Main checkout**:
The project folder the user added to Volli — the repo's own working tree, never touched by ticket automation. Project Sessions and worktree-opt-out tickets run here.

**Actor**:
Who a ticket event is attributed to: `user`, `session`, `automation`, or `unauthenticated`. The app derives this from how the mutation arrived; callers never self-declare it. `unauthenticated` is the honest name for a socket caller Volli could not identify — it is neither the person nor the Session it may have named, and by default it writes nothing at all.
_Avoid_: agent (as an actor value — the app cannot know an agent typed it, only which session it came from)

**Deliberate move**:
A human drag or explicit `volli` move, as opposed to a lifecycle-driven auto-move. It carries the same semantics regardless of actor and wins over trailing lifecycle events.
_Avoid_: manual move (too narrow — implies human-only)

**Automation**:
A saved, named way of starting work, made of three parts: its Trigger, its
Instructions, and its Runtime. An Automation removes the repetitive setup of
composing a prompt and choosing model, reasoning, and authority defaults — it
does not remove the person. Every Automation is runnable by hand from any
surface that lists one, so the Trigger says only what _else_ starts it. Whether
a Run is attended follows from that Trigger; it is never a property an
Automation declares about itself.
_Avoid_: recipe, preset, workflow, template, pipeline

**Trigger**:
What starts an Automation besides a person: a ticket entering one or more named
columns, or a schedule. "Nothing else" is the third answer and the default for a
new Automation — run by hand is always available, so an Automation with no
Trigger is complete rather than inert. One Automation holds exactly one Trigger.
The same work on two Triggers is two Automations naming one Skill, which is
cheap precisely because the workflow lives in the Skill rather than in either
record.
_Avoid_: event, hook, condition

**Armed automation**:
The single Automation a column fires on its own when a ticket arrives there by
Deliberate move. A column has at most one, or none — in which case an arriving
ticket is a pure status change. Arming is a property of the column, not of the
Automation, so one Automation may be armed in one column and merely offered in
another. It is local to the machine that set it and never travels with the
project. Arming a column is not retroactive: it governs tickets that arrive
afterward, never those already sitting there.
_Avoid_: default automation (collides with project defaults and the default base branch)

**Offered list**:
The Automations a column presents during a Deliberate move, in the order their
digit accelerators read, with a `Move only` target beside them. Membership is
each Automation's Trigger; the order is the column's own **rank**, arranged by
dragging the lanes on the Automations page and stored per column, like the
arming and on the same machine. A column's Armed automation is pinned to digit
`1` while it is switched on here, so `1` reproduces a plain drop. Digits run
`1`–`9` and `0` is `Move only`; a row ranked past the ninth keeps its place and
simply has no digit. Offering is not arming: a column offers many and fires at
most one on its own.
_Avoid_: column automations, automation menu

**Option-drag picker**:
What holding ⌥ during a drag does: the hovered column grows its Offered list
into large landing targets — every offered row plus `Move only` — and the picker,
not the pointer, is what a release obeys, so every release under ⌥ lands on a
named target. Landing on a named Automation opens the same delay window a plain
drop into an armed column opens, with the same single Cancel; `Move only` moves
the ticket and starts nothing. ⌥ is a state rather than an edge: the column is
expanded whenever ⌥ is held over it, however the two became true. Escape ends
the drag; ⌥-up only closes the picker.
_Avoid_: palette, radial menu, drag menu

**Instructions**:
The prompt an Automation sends when it opens its Session: authored prose plus
the composer's own grammar — `/` for prompt templates and Skills, `@` for file
references — resolved exactly as they resolve for a person typing into the chat
composer. Nothing is appended to them. The Runtime Brief already carries the
ticket's context, and per-Automation prompt text would break the cache prefix a
stable system prompt exists to hold. An Automation starts from an empty box.
_Avoid_: prompt template, Ticket Body, Runtime Brief

**Runtime**:
An Automation's execution setting: its model policy, reasoning policy, Session
Role, and Authority Snapshot defaults. Model and reasoning travel together as
one selection, and are inherited or pinned together rather than separately — the
reasoning levels a model offers are its own, so a pinned level against an
inherited model can name a pair that does not exist. An Automation that pins
nothing resolves through the project's runtime preferences and then the global
record, so changing the model in Settings changes every Automation that inherits
it. The Agent Runtime is a product constant rather than an Automation choice.
_Avoid_: agent, harness, model (alone)

**Run**:
One invocation of an Automation, and the record of which Automation and which
_resolved_ model and reasoning produced a given Session. A Run owns exactly one
Session and always starts a fresh one: it never wakes an existing Session, whose
Authority Snapshot was granted while a person was present and whose context is
stale by the time a schedule fires. A ticket has at most one Run in flight at a
time. A Project Session can start one too, through the `automation.run` tool its
Role bundle holds; the Run it starts carries the automation Actor and is
indistinguishable in its record from one a person started by hand. Runs outlive the app — one whose Session died is interrupted, never lost,
and only a human restarts it. A Session a user opens from the composer belongs
to no Run and never moves the board.
_Avoid_: job, task, session (a Run has a Session — it is not one)

**Unbound Run**:
A Run that carries its own Instructions and names no Automation — the one-time
case, authored where it is launched. It writes no file and saves no record
beyond the Run, so there is nothing left afterwards to name, disable, or delete.
_Avoid_: ad-hoc automation, draft automation, one-shot automation

**Enabled automation**:
An Automation somebody switched on for this machine, and therefore the only
kind whose Trigger has an effect here. Off is the resting state: a machine that
was never asked has not said yes, so a record fires on its own only where it
was turned on — the same rule that lets the Skills travel through git while the
record and its switch do not. Run by hand is universal, so an Automation that
is off is still runnable from every surface that lists one; the switch narrows
what _else_ starts it, exactly as the Trigger does. Like arming, it is local to
the machine that set it and never travels with the project, which is why it is
not a field on the record. Distinct from deleting, which removes the record;
there is no third state between them, because for a Skill git is already the
archive.
_Avoid_: paused, archived, active, on (alone)

**Skipped occurrence**:
A scheduled Trigger's due time that passed without a Run — usually because the
app was not open, otherwise because this machine never woke to it (asleep, or
too busy), or because the Run door refused when the moment came. It is recorded
with the reason that is actually true of it and never replayed — the next
occurrence stands — and a person may start it by hand from the Run history
afterwards, as one Run rather than as the backlog it stood for. A skip and a
silence must not look the same, and neither must two different skips.
_Avoid_: missed run, failed run

**Skill**:
A directory holding a `SKILL.md` — frontmatter naming and describing it, body
of instructions — under the `.agents/skills/` convention, in either the
project's own tier or the personal `~/.agents/skills/`. Its identity is the
directory slug, not the frontmatter `name`: the slug is what a person types
after `/`, what the picker offers, and what the delivered RESOURCE block
carries, so the reference and the injection can never disagree about what the
thing is called. A Skill's body reaches a model three ways, each visible in the
prompt or the transcript — an explicit `/slug` in the composer, an attach-time
selection, or the model's own read of a SKILL.md it found in the Skills index.
_Avoid_: plugin, tool, extension, macro

**Invocation policy**:
What one Skill is currently allowed to do, on two independent axes: **Model
discoverable** (its metadata rides the Skills index and the model may activate
it unprompted) and **User invokable** (it appears in `/` completion and an
explicit reference resolves). A Skill that is neither is **Unavailable**. The
two are separate questions — the index is a prompt-budget question, the picker
a discoverability question for a person — and every consumer resolves the same
policy, so the index, the picker, explicit submit, attach-time selection and
Settings can never disagree.
_Avoid_: enabled, visibility, permission, scope

**Skill mode**:
A Project's complete per-Skill override: `Auto` opens model discovery and user
invocation, `Manual` closes model discovery and keeps user invocation, and
`Off` closes both. The author-only fourth combination — model discoverable but
not user invokable — applies only where the Project has no override; Settings
names it `Model only (author)` rather than mislabelling it Auto. A stored mode
outranks both author axes and is removed when it exactly restores the file's
declaration.
_Avoid_: skill setting, toggle, enablement

**Author invocation default**:
What a `SKILL.md` asks for before any Project has its say. The top-level
`disable-model-invocation` spelling is the portable manual default honoured by
Claude Code, Cursor, Copilot and Pi. `user-invocable` is the independent
Claude/Copilot spelling Volli also accepts; neither extension belongs to the
Agent Skills core format. Volli's legacy
`metadata.volli-user-invoke-only` remains an alias, the portable top-level key
wins a conflict, and any declaration that cannot be read earns a surfaced
diagnostic. Unparseable YAML fails closed until the file or a Project override
fixes it.
_Avoid_: frontmatter flag (alone), skill config

**Skill activation lifecycle**:
An explicit `/slug` is attached to one user message: the transcript keeps the
person's reference and one typed delivery receipt containing the exact resource
bytes and Skill root. Repeating the same resolved name in that message delivers
it once; invoking it again in a later message creates a new receipt and delivers
it again. Context compaction restores one exact active resource per Skill name,
using the latest delivered bytes, so summarization cannot silently replace its
instructions. This preservation is user-message context, not a persistent mode;
starting a Session with a Skill is the separate attach-time route and places its
resource in the attachment's stable system prompt. Attach-time names are also
deduplicated.

Project policy writes automatically invalidate every mounted supply. Consumers
expose no previous-policy rows while the replacement disk read is in flight,
and main resolves policy again after that read before index or delivery. Skill
file adds, edits and removals are intentionally not watched: `/reload` is the
explicit disk rescan and recovery action. A past transcript receipt never
changes when either policy or disk content changes.
_Avoid_: active plugin, sticky slash command
