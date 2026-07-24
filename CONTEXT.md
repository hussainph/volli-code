# Volli Code

Local-first planner where a ticket is its terminal workspace. This glossary is the canonical
project language; `docs/CONCEPT.md` holds the decision log behind it.

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
One continuous terminal interaction with its own history and resume identity, whether shown alone or alongside other surfaces.
_Avoid_: pane session, split session

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
One append-only history record of something that happened to a ticket (created, status changed, …). The event log is never rewritten; session and comment events join it in later milestones.

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
