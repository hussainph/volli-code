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

| State after   | Step                                                                                                                                                                                                                                      |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `frozen`      | Pre-flight (the project exists; no Session of it has a live turn or shell), the queue's verified backup (once per queue), then the freeze, checked for liveness again.                                                                    |
| `exported`    | The real exporter, filtered to the project, from a fresh snapshot taken after the freeze; `verifyMigrationExport`.                                                                                                                        |
| `reserved`    | The plan (`plan.ts`): every importer stream's records, counts and digests, per-ticket and per-Session digests, the objects. Then `projectImports.begin` with the move manifest's sha256.                                                  |
| `staged`      | `v1/m/<moveId>/`: `manifest.json` and the convex streams' export chunks (zstd, named by hash). Transcripts, Pi logs and runner paths are never staged raw.                                                                                |
| `objects`     | Blob bytes (streamed from disk) and legacy archives to their final, write-once keys, four at a time.                                                                                                                                      |
| `rows`        | `projectImports.importRows`, stream by stream, ≤ 200 rows / 3 MiB a batch. Any conflict or refusal rolls the move back: a refused row is a lost row.                                                                                      |
| `history`     | Each Session's transcript packs and Pi logs (`MoveSessionHistory.upload`). A body or Pi file left behind rolls the move back.                                                                                                             |
| `verified`    | Before the commit, while only the import has written: the accumulators, a full read-back by project/ticket/Session index (counts, digests, ticket keys, intake heads, event contiguity), every object HEADed and a blob sample re-hashed. |
| `committed`   | `projectImports.commit`: the project is visible.                                                                                                                                                                                          |
| `handed_over` | Runner-local writes only: checkout and Working-copy paths registered by id, drain cursors seeded at the imported heads.                                                                                                                   |
| `checked`     | The real-path check (`real-paths.ts`): the window's own reads, compared with the export. The move waits for the person.                                                                                                                   |
| `confirmed`   | Finish move (`confirm`): the local copy stays, archived read-only; the export is deleted.                                                                                                                                                 |

Off the forward path: `rolling_back → rolled_back` (uncommit first when shown,
then abort, which purges the cloud copy; the handover taken back; unfrozen),
`returning → returned` ("Go back to local", below) and `superseded` (moved
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

## The profile step

Once per queue, before its first project: the person's own settings
(personal `configEntries`: model defaults, the decision model, compaction,
the Code Mode policy, unbound Automations) exported alone and imported through
`profileImports.importPersonalSettings`. Idempotent by id; a setting the
person already holds with other content keeps the stored one and is counted.
A refused one is a problem (the queue stops if it stops at the first problem).
The content-free report is `profile-<queueId>/report.json`.

## The freeze

`freeze.ts`: a project with a move in a frozen state takes no write on this
Mac. The board's commands, the shared ticket commands, the Session engine's
create and submit (stopping work is always allowed), the Automation and MCP
settings services and the worktree reclaim ask it. Reads are never refused. The marker is the move's own journal row, so
no board row is edited. An N−1 build ignores it.

## Go back to local

`goBackToLocal`, any time after the commit: the changes made in Volli Cloud
since the move (tickets with activity or born there, with bodies, comments and
activity; Sessions active since, with the events past their moved head) are
saved as `cloud-changes.json` and `cloud-changes.md` beside the move, every
moved Session's drain cursor and the path registrations are taken back, and
the local copy is writable again. Volli Cloud keeps its copy, unchanged;
moving the project again needs that copy removed first.

## Ports

`MoveEnginePorts` (`ports.ts`): the backend under the person's sign-in, the
object store (`presignedMoveObjects`), the exporter (normally its worker), the backup writer, the
Session-history upload and cursor seeding, this Mac's live work, the
signed-in identity, and the real-path check (`windowReadCheck`).
`faults` is the kill/resume matrix's injection point.

Receiving wiring:

- **Moved Session history** (VC-990): `cloud-move/session-history.ts`
  composes `sessionEventImportRecord`, `createMoveHistoryUploader` and
  `seedMovedSessionCursors`/`releaseMovedSessionCursors` into
  `MoveSessionHistory`; the real-path check then also waits on its fold.
- **The object store**: `presignedMoveObjects` over the account's Convex client:
  write-once PUTs through `projectImports.presignPut`, HEADs (with the stored
  checksum) and GETs through `projectImports.presignRead`, bodies streamed.
- **The backup step**: `createMoveBackupPort` over the existing automatic-backup
  worker entry (desktop's `automatic-backup-worker` bundle). Pass the profile and
  store paths, the engine's `workRoot`, and a conservative `estimatedExportBytes`
  for the **whole queue** from pre-flight, not only its first project. The optional
  `directory` selects another backup folder. Wire its result to `backup` and
  `maintenance` to `withProfileMaintenance(dataDir, …)` for the whole run.
  The writer re-reads/verifies the v1 archive before publication and returns
  `{path, bytes, sha256}`; the queue journals it once and the result screen reads
  `queue.backup`. Only this worker request bypasses the maintenance pause, so it
  cannot deadlock on its own move lease. Daily backups still pause.
  Disk pre-flight reserves the writer's staging allowance plus twice the export
  estimate and 256 MiB headroom; separate backup/export volumes are checked
  separately. Publication checks again using the actual bundle size. Disk shortage
  pauses the engine as `disk_full`; verification failure never freezes a project.
  `pre-cloud-move-<date>-<pid>-<uuid>.tar.gz.kept` has no expiry: the safety copy stays
  until the person removes it, including throughout the preview escape hatch.
  A verified bundle is not proof of large-profile restore readiness: VC-988
  owns the file-based restore and scale round trip.
- **The UI**: composes the engine in main with the account's Convex
  client, this Mac's runner registration and the runtime's live work, calls
  `resume()` at launch, and drives `enqueue`/`run`/`proceed`/`rollBack`/
  `confirm`/`recheck`/`goBackToLocal`.
- **Host-wide legacy rows** (`v1/u/<userId>/legacy/`) need an upload door
  of their own; the profile step carries personal settings only.

## Tests

`convex/test/moveEngine.test.ts` runs the engine against the real
`projectImports.*` under `convex-test` (a synthetic profile, every
interruption and refusal); `convex/test/moveEngine.matrix.test.ts` is the
kill/resume matrix (every step boundary, mid-step, before and after a backend
call lands, and mid roll back), run by ci-extended's `Move to Volli Cloud`
job (`pnpm -C convex test:matrix`).
