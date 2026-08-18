# Volli Code

Local-first planner and execution workspace. This glossary is the canonical project language. The Session terms below define the target architecture; code and tests remain authoritative for current behavior until the migration lands.

## Language

**Ticket**:
A board card and, once it enters Doing, a terminal workspace. Its content doubles as the agent's starting prompt.

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
The expanded working surface for one ticket, where its Ticket Body, sessions, files, artifacts, and Change Set coexist.
_Avoid_: ticket worktree, artifact view

**Project Files**:
The project-level repository workspace for browsing and editing the Main checkout.
_Avoid_: global files, project file tab

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
Each Session has a Role, an Authority Snapshot, and a model policy. Reconnect,
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
_Avoid_: harness mode, agent mode, plan mode

**Authority Snapshot**:
The durable policy granted to one Session when it starts: which actions are
automatic, which require a decision, which are forbidden, and the classifier
model allowed to help within deterministic boundaries. A Settings change does
not silently change a running Session's authority; changing authority is an
explicit Session action.
_Avoid_: permission preset (when meaning live authority), auto-approve flag

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

**Agent Runtime**:
The product-aware execution package that hosts Volli's agent loop. It receives a
Session Role, work location, model policy, Authority Snapshot, prompt resources,
and scoped tools; it emits runtime observations and tool requests without owning
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
The profile-wide decision about whether Volli may reach the Internet on a
Session's behalf, and through whose search provider. Off is the default and the
resting state: a profile that has configured no provider gives its Sessions no
web tool at all, rather than a tool that refuses when called. A provider
endpoint is a person's own configuration and is judged by its own admission
policy when saved and again on every request; a URL the model supplies is not,
and faces the stricter public-web policy every time. The credential owner
encrypts a bring-your-own key through the OS keychain, refuses to hold one when
the keychain cannot encrypt, and never exposes it to the renderer, prompt,
transcript, or Session ledger — the renderer may learn only whether a key
exists. What a search returns is third-party text, references rather than
contents, and reading one of them is a new decision judged from scratch.
_Avoid_: web search setting, browsing, internet permission

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
The project folder the user added to Volli — the repo's own working tree, never touched by ticket automation. Scratch sessions and worktree-opt-out tickets run here.

**Scratch session**:
A ticket-less terminal session in a project's Sessions surface — main checkout, no worktree, no board involvement — still recorded in session history.

**Actor**:
Who a ticket event is attributed to: `user`, `session`, or `automation`. The app derives this from how the mutation arrived; callers never self-declare it.
_Avoid_: agent (as an actor value — the app cannot know an agent typed it, only which session it came from)

**Deliberate move**:
A human drag or explicit `volli` move, as opposed to a lifecycle-driven auto-move. It carries the same semantics regardless of actor and wins over trailing lifecycle events.
_Avoid_: manual move (too narrow — implies human-only)

**Automation**:
A saved, named way of starting work on a ticket, made of four parts: the Trigger
(which columns it applies to, and whether it may fire unattended), its
Instructions, its Runtime, and its Outcome. An Automation removes the repetitive
setup of composing a prompt and choosing model, reasoning, and authority
defaults — it does not remove the person. Running one always opens a Session the
user is expected to work inside, watch, and interrupt; it is never a silent
background job.
_Avoid_: recipe, preset, workflow, template, pipeline

**Armed automation**:
The single Automation a column fires on its own when a ticket arrives there by Deliberate move. A column has at most one, or none — in which case an arriving ticket is a pure status change and any Automation must be chosen by hand. Arming a column is not retroactive: it governs tickets that arrive afterward, never those already sitting there.
_Avoid_: default automation (collides with project defaults and the default base branch)

**Instructions**:
The prompt an Automation sends when it opens its Session: authored prose,
Context Chips, and Volli capabilities such as skills or slash commands. Every
Automation starts from an opinionated default that already carries the ticket's
own context, so composing it by hand is optional.
_Avoid_: prompt template, Ticket Body, Runtime Brief

**Context chip**:
A placeholder in an Automation's Instructions that resolves at launch to live ticket state — the Runtime Brief, Change Set, comment timeline, or pull request. A chip is always a reference resolved at launch, never a stored copy.
_Avoid_: variable, macro, Attachment

**Runtime**:
An Automation's execution setting: its model policy, reasoning policy, Session
Role, and Authority Snapshot defaults. Model and reasoning may be overridden at
invocation within the user's configured policy; the Agent Runtime is a product
constant rather than an Automation choice.
_Avoid_: agent, harness, model (alone)

**Run**:
One invocation of an Automation against one ticket, and the record of which Automation and Runtime produced a given Session. A Run owns exactly one Session and carries that Automation's Outcome if it has one; only that Session finishing can resolve it. A ticket has at most one Run in flight at a time. Runs outlive the app: one whose Session died is interrupted, never lost, and only a human restarts it. Sessions a user starts by hand belong to no Run and never move the board.
_Avoid_: job, task, session (a Run has a Session — it is not one)

**Outcome**:
What a Run does to its ticket once its agent hands control back: move it to a named column, announce it and stay put, or nothing at all. An Outcome has one arm per way a Run can end — completed, blocked, or ended without signalling — so a Run that stalls is never mistaken for one that succeeded. It is a contract the Run carries from the moment it launches, never a property of the ticket or of the column it lands in.
_Avoid_: result, action, auto-move
