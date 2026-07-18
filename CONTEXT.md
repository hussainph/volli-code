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
The human-facing ticket handle, `<PREFIX>-<n>` (e.g. `VC-12`), derived from the project's ticket prefix and the ticket number. Ticket prefixes are unique across the workspace, so a display ID unambiguously names one ticket anywhere — the UI, branch names, and the `volli` CLI all address tickets by it. Still never record identity: editing a prefix re-labels tickets, it does not re-identify them.
_Avoid_: id, ticket id (when meaning the handle)

**Label**:
A first-class, project-scoped entity attached to tickets: a name plus an optional stored color. Without a stored color, the chip color is hash-derived from the name; a stored color wins.
_Avoid_: tag (the pre-persistence term for ad-hoc strings)

**Ticket event**:
One append-only history record of something that happened to a ticket (created, status changed, …). The event log is never rewritten; session and comment events join it in later milestones.

**Project**:
A tracked codebase folder: name, path, ticket prefix, rail position. Removing one from Volli never touches the folder on disk.

**Primary session**:
The one terminal session per ticket whose lifecycle drives board automation; other panes in the ticket are free-form.

**Scratch session**:
A ticket-less terminal session in a project's Sessions surface — main checkout, no worktree, no board involvement — still recorded in session history.

**Actor**:
Who a ticket event is attributed to — resolved by the app from how the mutation arrived, never self-declared. `user`: the app UI, or a `volli` CLI call from outside any session. `session`: an explicit `volli` command from inside a Volli-spawned session — the app records the door, not the keyboard, so this covers both the agent and a human typing in that terminal. `automation`: lifecycle-driven results (hook signals, auto-moves).
_Avoid_: agent (as an actor value — the app cannot know an agent typed it, only which session it came from)

**Deliberate move**:
A board move performed by a human drag or an explicit `volli` CLI command, as opposed to a lifecycle-driven auto-move. A deliberate move carries identical semantics regardless of actor — including any automation attached to the destination column — and always wins over trailing lifecycle events.
_Avoid_: manual move (too narrow — implies human-only)

**Skill pack**:
The Volli-managed set of agent skills installed globally (with consent) into each detected harness's skill/instruction location, teaching agents how to use the `volli` CLI and the norms for acting on the board. Self-scoped by description — skills declare they apply only inside Volli-tracked work, so they lie dormant elsewhere. Installs are idempotent, merge-never-clobber, refreshed on app update, cleanly uninstallable.
_Avoid_: slash commands (skills are pull-based, triggered by relevance, not only explicit invocation)

**Agent surface**:
The subset of app capability exposed to agents through the `volli` CLI: full read of the planning layer and session history, full write of the planning layer (create/update/move/comment/label/archive tickets), session lifecycle signals, and read-only observation of other sessions' output. Excluded by design: deleting archived tickets, adding/removing projects, and driving another session's terminal.
_Avoid_: describing the CLI as "the app's API" (it is deliberately narrower than what a human can do)
