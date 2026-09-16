# VC-387 — what one `volli:data-changed` costs, and what the board now reads

Split out of VC-383's audit (deferred item D1). VC-383 fixed what the person
LOOKS AT while waiting; this is the read that made them wait.

`data.bootstrap` ran wholesale on every `volli:data-changed`: every live ticket
of every project, `body` included, plus the label join, plus the `app_state`
rows. Every socket-originated mutation broadcasts one, so an agent posting a
comment per turn caused a full re-bootstrap per turn. The 8 ms coalescer
(`src/main/data-change-coalescer.ts`) folds a synchronous burst into one notice;
it does nothing for steady-state chatter from a dozen agents, because those
arrive seconds apart and each one is genuinely new.

## What was measured

A micro-bench of the READ and its copy — not a full-app run, and not a frame
time. The question was which of the ticket's three fix shapes is worth its
contract change, and the full-app harness (`e2e/bench/performance/run.mjs`)
takes twenty minutes to answer a question this answers in seconds. Nothing here
claims a user-perceived latency figure; none was taken.

The harness is `apps/desktop/e2e/board-refresh-bench.mjs`. It builds a real
temp database through the app's own migrations and repos, seeds a board, and
times the reads and their `structuredClone` — the closest in-process stand-in
for the copy every payload pays crossing the IPC boundary to each open window.

Measured on macOS, Apple Silicon (arm64, 8 logical cores), Node v24.18.0, on a
machine also running other Volli Sessions. Numbers are comparable only within
one run on one machine. Fixture: 392 live tickets, 2,400-byte bodies, three
labels per project, 60 repetitions after a warmup.

```sh
node apps/desktop/e2e/board-refresh-bench.mjs --json /tmp/vc387-spread.json
node apps/desktop/e2e/board-refresh-bench.mjs --projects 1 --tickets 392 \
  --json /tmp/vc387-single.json
```

### Arm A — four projects × 98 tickets

| Read | median | p95 |
| --- | --- | --- |
| `data.bootstrap` (whole board, before) | 0.867 ms | 1.305 ms |
| one project's roster (shape 1) | 0.246 ms | 0.338 ms |
| IPC copy of the whole board | 0.805 ms | 1.082 ms |
| IPC copy of one project | 0.184 ms | 0.290 ms |
| IPC copy of one project, no bodies (shape 2) | 0.145 ms | 0.206 ms |

Payload across the wire: whole board 1,056 KiB · one project 264 KiB · one
project without bodies 31 KiB.

### Arm B — one project × 392 tickets

| Read | median | p95 |
| --- | --- | --- |
| `data.bootstrap` (whole board, before) | 0.768 ms | 1.170 ms |
| one project's roster (shape 1) | 0.923 ms | 1.114 ms |
| IPC copy of the whole board | 0.702 ms | 4.495 ms |
| IPC copy of one project | 0.691 ms | 0.960 ms |
| IPC copy of one project, no bodies (shape 2) | 0.557 ms | 0.611 ms |

Payload across the wire: whole board 1,056 KiB · one project 1,055 KiB · one
project without bodies 123 KiB.

Twelve agents each posting one comment per turn, before the change: twelve
whole-board reads — about 10 ms of SQLite and ~12 MiB of structured clone per
turn — plus twelve wholesale store replacements, each of which mints a new array
for every project and so re-renders every board surface. After the change:
none of it, because a comment reads nothing.

## What the measurement decided

**Arm B is the one that settles the shape.** On a single-project install —
the common case — scoping the re-read to `change.projectId` buys nothing,
because the whole board IS that project. It is marginally *slower* there (0.923
vs 0.768 ms; two statements instead of two, over the same rows). Shape 1 alone
would not have met the ticket's "done when".

**A comment cannot move a row the board holds.** A comment writes
`ticket_comments`; the board store holds `tickets`; no board surface derives
anything from the comment feed or its count. So for a comment the read is not
made narrower — it is not made at all. That is the whole of the ticket's stated
symptom, and it is shape 3's benefit without shape 3's cost.

**Bodies are ~90% of the bytes and no board surface draws one.** 1,056 KiB
becomes 123 KiB without them (arm B). That is what makes shape 2 worth a
contract change; the SQLite time alone would not have been.

## What was implemented

1. **A comment performs no board read** (`renderer/src/lib/boot.ts`,
   `movesBoardData`). `lastPlanningChange` is still published — that signal is
   how the Activity feed, the retention badge and the Done-flow rail hear about
   it, and the feed is where a comment actually appears.
2. **A targeted change re-reads one project, without bodies.** New channel
   `volli:data-project-roster` → `ProjectRosterResult` (`main/data-ipc.ts`,
   `db/tickets-repo.ts` `listTicketRosterByProject`). The board store's
   `hydrateProjectRoster` replaces that one project's slice, carries forward the
   bodies it already holds, and leaves every other project's array identity
   untouched — so an agent working in one project no longer re-renders the
   boards of the others.
3. **The body is read per open ticket.** New channel `volli:ticket-body`, read
   by `useTicketBody` in the ticket workspace on arrival, on ticket switch, and
   on each planning change that names that ticket; adopted through
   `adoptTicketBody`, which no-ops when the body is unchanged so a freshness
   read cannot cause a render.

The BOOT payload deliberately still carries bodies. It is one read per launch,
and it is what keeps an opened Body editor instant for everything that was on
the board at launch; only the steady-state refresh is body-less. A ticket
created after boot holds `""` until it is opened, which is the one moment its
body is read.

**Shape 3 (carry the changed row on the broadcast) was not implemented, and is
deliberately deferred.** Once a comment reads nothing and every other change
reads one project without bodies, the remaining read is small. Carrying rows
would put ticket SHAPE into the invalidation payload and into the coalescer's
merge rule — which today degrades cleanly to a coarser scope precisely because
it carries no data, only scope.

## The recovery guarantee, restated

The old contract, written in `boot.ts`, was that `refreshPlanningData` is
"always wholesale", so any broadcast healed any drift. That is no longer true.
The new terms:

- An untargeted change (`{}`) re-reads everything, wholesale.
- A change naming a project this window does not hold re-reads everything,
  wholesale — a scoped read cannot introduce a project to the projects store.
- After any FAILED refresh, the next board-moving refresh is wholesale whatever
  its scope, so a window that may have missed an update heals on the next change
  rather than waiting for an untargeted one.
- Every successful refresh still publishes `lastPlanningChange`, scoped or not.

What is genuinely given up: a comment no longer incidentally repairs unrelated
drift, because it no longer reads. That repair was never its job — it was a side
effect of the read this ticket removed — but it was real, and the board now
depends on the three rules above instead of on it.
