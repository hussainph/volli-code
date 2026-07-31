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
The durable identity and locally ordered history of an agentic conversation. A Session is created before any executor attaches and outlives terminal panes, processes, adapters, UI surfaces, and execution venues. It remains openable after an attachment, turn, or Run completes; only explicit archival changes its availability. A Session may belong to one Ticket or be ticketless.
_Avoid_: pane session, split session, harness process, terminal pane, UI tab

**Session Event**:
An immutable fact in a Session's locally ordered ledger: an attachment outcome,
native observation, command outcome, message/turn boundary, or recovery signal.
The control plane assigns the per-Session sequence; timestamps are metadata, not
ledger order. Session Events are not Ticket Events, although a planner event may
cite a Session as provenance.
_Avoid_: session state, hook state, terminal state

**Session Attachment**:
One historical association between an existing Session and an executor or
transport: its adapter identity, native conversation identity where available,
venue, and attach/detach outcome. A Session keeps many historical attachments
but has at most one live executor attachment. A terminal pane is a view of an
attachment, not the attachment itself.
_Avoid_: Session, terminal, harness state

**Command**:
Durable, explicit user intent directed at a Session, recorded before an adapter
is asked to act. A Command does not imply that a transport accepted or completed
the work; ambiguous delivery is reconciled before it is retried.
_Avoid_: action, keystroke, request (when referring to accepted work)

**Receipt**:
The durable adapter-boundary record of a Command's observed outcome: accepted,
rejected, completed, or unreconciled. A Receipt makes delivery observable
without claiming an unsupported native guarantee.
_Avoid_: event, acknowledgement (when no durable outcome exists)

**Control Plane**:
The UI- and adapter-agnostic interface that owns Session commands, facts,
projections, and their durable storage contract. Electron main is its only
SQLite writer in the initial local deployment; the interface is deliberately
portable to a future daemon, cloud sandbox, or mobile client.
_Avoid_: Electron main, adapter host, renderer store

**Attention**:
A reconstructible projection of committed Session facts that tells the user
whether recovery or input is needed. It is not a source of truth and never
turns silence alone into an agent lifecycle fact.
_Avoid_: waiting flag, notification state

**Split Tab**:
One returnable tab-strip item that presents multiple independently owned surfaces together.
_Avoid_: split session, pane tree

**Ticket ID**:
The opaque, permanent record identity of a ticket (a UUID). Never shown to users, never derived from mutable fields.
_Avoid_: using `"VC-12"`-style strings as identity

**Display ID**:
The workspace-unique human handle `<PREFIX>-<n>` (for example `VC-12`), used by the UI, branches, and `volli` CLI. It is derived presentation, never record identity.
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
A tracked codebase folder: name, path, ticket prefix, rail position. Removing one from Volli never touches the folder on disk.

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
A saved, named way of starting work on a ticket, made of four parts: the Trigger (which columns it applies to, and whether it may fire unattended), its Instructions, its Runtime, and its Outcome. An Automation removes the repetitive setup of composing a prompt and picking a harness, model, and effort — it does not remove the person. Running one always opens a Session the user is expected to work inside, watch, and interrupt; it is never a silent background job.
_Avoid_: recipe, preset, workflow, template, pipeline

**Armed automation**:
The single Automation a column fires on its own when a ticket arrives there by Deliberate move. A column has at most one, or none — in which case an arriving ticket is a pure status change and any Automation must be chosen by hand. Arming a column is not retroactive: it governs tickets that arrive afterward, never those already sitting there.
_Avoid_: default automation (collides with the project's default harness and default base branch)

**Instructions**:
The prompt an Automation sends when it opens its Session: authored prose, Context Chips, and commands belonging to its pinned harness. Every Automation starts from an opinionated default that already carries the ticket's own context, so composing it by hand is optional.
_Avoid_: prompt template, Ticket Body, Runtime Brief

**Context chip**:
A placeholder in an Automation's Instructions that resolves at launch to live ticket state — the Runtime Brief, Change Set, comment timeline, or pull request. A chip is always a reference resolved at launch, never a stored copy.
_Avoid_: variable, macro, Attachment

**Runtime**:
An Automation's execution setting: one pinned harness plus that harness's own model and effort expression. The harness is pinned because Instructions are written in its dialect and do not port; model and effort are defaults that may be overridden at the moment the Automation is invoked.
_Avoid_: agent, harness (alone), model (alone)

**Run**:
One invocation of an Automation against one ticket, and the record of which Automation and Runtime produced a given Session. A Run owns exactly one Session and carries that Automation's Outcome if it has one; only that Session finishing can resolve it. A ticket has at most one Run in flight at a time. Runs outlive the app: one whose Session died is interrupted, never lost, and only a human restarts it. Sessions a user starts by hand belong to no Run and never move the board.
_Avoid_: job, task, session (a Run has a Session — it is not one)

**Outcome**:
What a Run does to its ticket once its agent hands control back: move it to a named column, announce it and stay put, or nothing at all. An Outcome has one arm per way a Run can end — completed, blocked, or ended without signalling — so a Run that stalls is never mistaken for one that succeeded. It is a contract the Run carries from the moment it launches, never a property of the ticket or of the column it lands in.
_Avoid_: result, action, auto-move
