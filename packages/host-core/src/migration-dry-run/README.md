# Migration dry run

A non-destructive rehearsal of migrating one local profile into Volli Cloud:
snapshot → export → import into a throwaway local backend → verify → import
again → report → clean up. `dry-run.ts` holds the steps; the backend side is
`convex/functions/migration.ts`; the record → document mapping both sides
apply is `migrationDocument` in `@volli/shared/cloud` (`migration-import.ts`).

## Running it

```sh
pnpm -C convex backend:fetch      # once per backend pin
pnpm -C convex with-backend --deploy -- \
  node --experimental-transform-types ../packages/host-core/scripts/migration-dry-run.mjs \
  --profile "$HOME/Library/Application Support/Volli Code/volli.db" \
  --report /tmp/migration-dry-run.json
```

`with-backend --deploy` starts a fresh pinned local backend on loopback
ports, pushes `convex/functions`, runs the command with
`CONVEX_SELF_HOSTED_URL` / `CONVEX_SELF_HOSTED_ADMIN_KEY` set, and deletes
the backend's data directory when the command exits. Pass absolute paths.

| Flag                         | Meaning                                                                    |
| ---------------------------- | -------------------------------------------------------------------------- |
| `--profile <volli.db>`       | The database to rehearse. Opened read-only.                                |
| `--project <uuid>`           | Select a local project (repeatable); no personal/profile rows.             |
| `--blobs <dir>`              | Attachment bytes. Default: `blobs/` beside the database.                   |
| `--hot-days <n>`             | Sessions active within `n` days import live; older ones archive (30).      |
| `--include-removed-projects` | Also import projects removed from the rail (off, as the migration offers). |
| `--no-rerun`                 | Skip the second import (which must change nothing).                        |
| `--report <file>`            | Also write the JSON report to a file.                                      |
| `--app-version <v>`          | The build recorded in the export manifest (default `dry-run`).             |
| `--home-dir <dir>`           | The home directory treated as a machine path (default: yours).             |

Progress goes to stderr; the report goes to stdout. The exit code is 0 only
when every check passed.

A synthetic profile for trying it (every id a UUID, one of each case the dry
run handles): `node --experimental-transform-types packages/host-core/scripts/migration-dry-run-fixture.mjs <empty dir>`.
`convex/test/migration.backend.test.ts` runs both against the real backend.
Add `--move` to the fixture command for three local projects, a duplicate prefix,
cross-project delegation/shared blob, unicode, archived/merged/removed rows,
shadow/drained/cloud-born exclusions, paused Automations, 2,048 mixed plain/gzip
transcripts (>50 MiB), and a multi-slice Pi log. Host-core's `move.test.ts` also
injects missing files, orphan references and a non-UUID row and requires a named
refusal (or explicit legacy archive), never a silent drop.

## Safety rules

- **The live profile is only read.** The database is opened with
  `readonly: true` and copied with SQLite's online backup API, which reads
  one consistent committed state while the app keeps writing. It is never
  copied as raw files (that would race the WAL) and never opened for
  writing. Blob files are read, never moved.
- **Only a local backend.** The harness refuses any URL that is not
  loopback, so it cannot write a person's history into a shared or cloud
  deployment.
- **Nothing stays behind.** The snapshot, its sidecars, the export, the
  object-storage stand-in and the runner stand-in all live in one temporary
  directory, removed on success, on failure and on SIGINT/SIGTERM/SIGHUP.
  The backend's data directory is removed by the fixture. Never set
  `VOLLI_CONVEX_KEEP_DATA=1` for a real profile: it keeps the imported
  content and the backend log on disk.
- **The report holds no content.** Counts, digests, timings and rejection
  codes naming fields, never values. Keep profile databases and reports of a
  real profile out of git and CI artifacts anyway.
- **No credentials.** Nothing reads the keychain, `secrets`, MCP credentials
  or Pi auth; credentials are never part of a migration by default.

## What it checks

- Per importer stream: rows exported, skipped (removed projects), sent,
  inserted, unchanged, conflicts, rejections by code; the count and
  order-independent digest of what the shared mapping says the backend must
  hold, against the same digest over every row paged back. A mismatch, a
  conflict or ANY refused row fails the run: a refusal is a row the
  migration would lose. A row the mapping refuses, or one Convex's wire
  format cannot carry, is refused before it is sent.
- The second import inserts nothing and conflicts on nothing.
- Ticket numbers unique per project and below the project's counter;
  column positions unique and in the exported order.
- Every Session's intake cursor at its last sequence; hot Sessions hold
  events `1..last` in the backend, archived ones are tiled by `ev/` archives
  whose bytes, sha256 and event counts match their index rows.
- Spilled event payloads and blob bytes present in the stand-in with their
  hashes.
- No placeholder and no machine path (the home directory, project and
  worktree paths) in a backend row, outside the fields that are a person's
  content (ticket bodies, comments, Session event payloads), which are
  counted separately.
- The snapshot's `quick_check` and `foreign_key_check`, and the exporter's
  own preflight facts.

## Where things go

| Export stream                                             | Dry run                                                                                                                                                                |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Convex-bound streams (`MIGRATION_IMPORT_STREAMS`)         | `migration:importRows`, batched (≤ 200 rows, ≤ 3 MiB), idempotent by each table's key                                                                                  |
| `sessionEvents` of a Session active within `--hot-days`   | `sessionEvents`, classified (`kindKnown`, `quarantine`); payloads over 256 KB or the backend cannot store go to `…/e/{seq}.json.zst` and are stored as `{kind, spill}` |
| `sessionEvents` of an older Session                       | `…/ev/{first}-{last}.ndjson.zst` (`volli.session-events/1`) + `eventArchives` rows                                                                                     |
| every Session                                             | `sessionIntake`, claimed by the migrating Mac, `acceptedThrough` = its last sequence                                                                                   |
| `blobs`                                                   | the row, plus the bytes at its key                                                                                                                                     |
| `legacyRows`                                              | `…/legacy/{name}.ndjson.zst` per project; host-wide rows under `v1/m/{migrationId}/`                                                                                   |
| runner streams (`projectCheckoutPaths`, …)                | a local runner directory; never uploaded                                                                                                                               |
| pending Automation arrivals, armings and schedule cursors | paused in `legacyRows` with a re-arm reason; executable streams are empty                                                                                              |
| `transcriptArtifacts`, `piLogs`                           | verified source chunks staged and read back through the object stand-in; counts/bytes in `history`                                                                     |

The object-storage stand-in is a directory laid out by the `@volli/shared/cloud`
key functions; real uploads (presigned PUTs) replace it when R2 exists.
Transcript bodies and Pi logs are read from the original profile's sibling
stores, not from the temporary SQLite copy. Missing/corrupt linked bytes refuse
export. See [`../migration-export/README.md`](../migration-export/README.md) for
the bulk source-stream contract. Producing/committing real `tx/` and `pi/`
segments through the move-authorized doors is the Session-history importer's job;
this rehearsal currently proves the source streams, not cloud viewer hydration.
