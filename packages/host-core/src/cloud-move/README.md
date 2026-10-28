# Move to Volli Cloud: the move engine

`createMoveEngine(ports)` moves local projects into a Volli Cloud Workspace
under the person's own sign-in, one project at a time. Each project move is
the unit of safety: its own freeze, export, upload, import, verification,
commit and roll back. Nothing local is edited or deleted by a move.

The backend half is `convex/functions/projectImports.ts` (person-authorized
import, hidden until commit, purge on abort). The exporter is
[`../migration-export`](../migration-export/README.md).

## Steps

A move's `cloud_moves.state` is the last step it completed; resuming runs the
next one. Every step is idempotent, so a crash, quit or lost network anywhere
resumes by running the step again.

| State after | Step                                                                                                                                                                                                                                      |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `frozen`    | Pre-flight (the project exists; no Session of it has a live turn or shell), the queue's verified backup (once per queue), then the freeze, checked for liveness again.                                                                    |
| `exported`  | The real exporter, filtered to the project, from a fresh snapshot taken after the freeze; `verifyMigrationExport`.                                                                                                                        |
| `reserved`  | The plan (`plan.ts`): every importer stream's records, counts and digests, per-ticket and per-Session digests, the objects. Then `projectImports.begin` with the move manifest's sha256.                                                  |
| `staged`    | `v1/m/<moveId>/`: `manifest.json` and the convex streams' export chunks (zstd, named by hash). Transcripts, Pi logs and runner paths are never staged raw.                                                                                |
| `objects`   | Blob bytes (streamed from disk) and legacy archives to their final, write-once keys, four at a time.                                                                                                                                      |
| `rows`      | `projectImports.importRows`, stream by stream, ≤ 200 rows / 3 MiB a batch. Any conflict or refusal rolls the move back: a refused row is a lost row.                                                                                      |
| `history`   | Each Session's transcript packs and Pi logs (`MoveSessionHistory.upload`). A body or Pi file left behind rolls the move back.                                                                                                             |
| `verified`  | Before the commit, while only the import has written: the accumulators, a full read-back by project/ticket/Session index (counts, digests, ticket keys, intake heads, event contiguity), every object HEADed and a blob sample re-hashed. |
| `committed` | `projectImports.commit`: the project is visible. The move rests here, the local copy read-only, until the person rolls it back.                                                                                                           |

The states after it (`handed_over`, `checked`, `confirmed`, and `returning →
returned` for "Go back to local") are in the journal's vocabulary already;
their steps (the handover, the real-path check, Finish move, the escape hatch)
are composed on top of these.

Off the forward path: `rolling_back → rolled_back` (uncommit first when shown,
then abort, which purges the cloud copy; unfrozen) and `superseded` (moved
again under a new move id).

## Waiting, problems, moving again

- **Waiting** (`paused`, nothing undone): `not_idle` (the queue moves on and
  tries once more at its end), `network` (each call retried with backoff,
  then paused), `disk_full`, `signed_out` (resumes for the same person only),
  `waiting_for_purge` (the project's previous move is still being purged),
  `paused` (cancelled, quit, or an unexpected error recorded as `internal`).
- **A problem** before the commit rolls the move back with a content-free
  failure (codes, counts, ids). After the commit it is recorded and the
  person decides; Roll back stays offered.
- **Moved again**: a replaced runner (`runner_unavailable`, or this Mac
  registered as another runner), a mapper change after the export, or an
  export that no longer matches the reservation. The move rolls back to
  `superseded` and a fresh move of the project takes its place in the queue.

## The queue

`enqueue` orders the projects smallest first (tickets, Sessions and events),
a cross-project delegation's parent project before its child's, the named
`lastProjectIds` last. Moves run one after another. "Stop at the first
problem" is on for the profile's first queue unless the caller says
otherwise; `proceed` lets a stopped queue go on.

## The freeze

`freeze.ts`: a project with a move in a frozen state takes no write on this
Mac. The board's commands, the shared ticket commands, the Session engine's
create and submit (stopping work is always allowed), the Automation and MCP
settings services and the worktree reclaim ask it. Reads are never refused. The marker is the move's own journal row, so
no board row is edited. An N−1 build ignores it.

## Ports

`MoveEnginePorts` (`ports.ts`): the backend under the person's sign-in, the
object store, the exporter (normally its worker), the backup writer, the
Session-history upload, this Mac's live work and the signed-in identity.
`faults` is the kill/resume matrix's injection point.

Receiving wiring:

- **Moved Session history** (VC-990): `cloud-move/session-history.ts`
  composes `sessionEventImportRecord` and `createMoveHistoryUploader` into
  `MoveSessionHistory`.
- **The object store**: presigned through `projectImports.presignPut` (VC-982)
  and a read door for the move's own keys, with the post-commit steps.
- **The backup step**: `MoveBackupPort` over the verified backup writer,
  and `maintenance` over `withProfileMaintenance(dataDir, …)` for the whole run.
- **The UI**: composes the engine in main with the account's Convex
  client, this Mac's runner registration and the runtime's live work, calls
  `resume()` at launch, and drives `enqueue`/`run`/`proceed`/`rollBack`.
- **Profile step** (personal settings, `cloud_move_queues.profile_step`):
  a follow-up; the queue records it as `pending`.

## Tests

`convex/test/moveEngine.test.ts` runs the engine against the real
`projectImports.*` under `convex-test` (a synthetic profile, every
interruption and refusal); `convex/test/moveEngine.matrix.test.ts` is the
kill/resume matrix (every step boundary, mid-step, before and after a backend
call lands, and mid roll back), run by ci-extended's `Move to Volli Cloud`
job (`pnpm -C convex test:matrix`).
