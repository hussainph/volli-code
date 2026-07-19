# Volli Code

Local-first planner where a ticket is its terminal workspace. This glossary is the canonical
project language; `docs/CONCEPT.md` holds the decision log behind it.

## Language

**Ticket**:
A board card and, once it enters Doing, a terminal workspace. Its content doubles as the agent's starting prompt.

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
