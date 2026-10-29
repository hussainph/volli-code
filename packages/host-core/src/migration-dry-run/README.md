# Migration dry run

A non-destructive rehearsal of migrating one local profile into Volli Cloud:
snapshot → export → import into a throwaway local backend → verify → import
again → report → clean up. `dry-run.ts` holds the steps; the backend side is
`convex/functions/migration.ts`; the record → document mapping both sides
apply is `migrationDocument` in `@volli/shared/cloud` (`migration-import.ts`).

## Staging rehearsal: the real move engine

`--move --target <deployment-url>` is a separate mode. It runs the actual
`cloud-move` queue, backup, exporter, object uploads, person-authorized import,
three-way verification, history packing and window read checks. The old mode
below remains loopback-only and read-only.

### Prepare staging (owner)

Follow [`cloud-deploy.md` §1–8](../../../../docs/runbooks/cloud-deploy.md) with
`<ref>=staging`. Nothing in this command provisions a deployment. You need:

1. A dedicated non-production Convex deployment (a prod-type deployment named
   `staging` is fine), its exact `.convex.cloud` URL, and an operator key
   scoped to **that deployment only**. If the plan cannot create another
   deployment, use a dedicated dev deployment or separate staging project.
2. WorkOS staging environment/client, runner signing key + JWKS, secrets root
   key, and S3 credentials configured there. Never copy production secrets.
3. A separate staging R2 bucket/token, `volli-app://bundle` CORS, and lifecycle
   rules for `v1/m/` and `v1/x/`, as in the runbook. Push this revision's
   functions and pass `health:deploymentChecks`.
4. Invite the rehearsal account with `previewAccess:set`, accept the current
   Preview Agreement, and register a staging Mac runner owned by that account.
   Keep its Volli user UUID and runner UUID from that staging setup; the
   harness requires both and compares the explicit user id with the token's
   viewer before creating anything. Use a **disposable staging account**: Move all also imports its personal
   settings; those account-level settings are not Workspace data and remain.
5. Explicitly enable the narrow operator-only cleanup helper **on staging**:

   ```sh
   pnpm -C convex exec convex env set VOLLI_MIGRATION_REHEARSAL enabled --deployment staging
   ```

6. Supply the person's staging access token (not a runner or deploy token) as
   `VOLLI_MOVE_TOKEN`, or preferably `VOLLI_MOVE_TOKEN_FILE`, an absolute path
   to a mode-0600 file containing only that token. The operator's staging OAuth
   session/token refresh process must replace this file before expiry; it is
   re-read on each call. A frozen environment token must live long enough for
   the whole rehearsal. Set `VOLLI_MOVE_ADMIN_KEY` to the deployment-scoped
   operator key. These are explicit inputs: the harness never discovers
   credentials, unlocks the keychain, or reads the copied account/Pi auth.
   Do not put tokens in argv, reports, git, tickets, or terminal history.
7. Supply `VOLLI_MOVE_REDACTIONS_FILE`: an absolute, mode-0600 JSON file
   containing the complete list of sensitive plaintext values the runner must
   redact from transcript bodies and Pi logs (a JSON string array). Prepare it
   through your trusted secret-inventory workflow, never tickets/chat. The
   harness uses the runner's streaming redactor and refuses real targets when
   this inventory is missing or empty. It never pretends an empty inventory is
   complete or unlocks the source profile to discover values. Do not proceed
   unless the inventory is complete; staging still receives private history.

### Run on the profile copy

Quit Volli completely, including menu-bar hosts and dev instances. Keep it
quit until copying finishes; do not launch another app on the source or copy
while the engine runs. Choose **new** scratch/report paths on an APFS volume:

```sh
pnpm install
mkdir -p .scratch/rehearsal
SOURCE="$HOME/Library/Application Support/Volli Code"
REHEARSAL_ROOT=$(mktemp -d /tmp/volli-rehearsal.XXXXXX)
COPY="$REHEARSAL_ROOT/profile"
REPORT="$PWD/.scratch/rehearsal/report.json"

# Export the credential inputs securely in this shell first (see above).
pnpm --filter @volli/host-core migration:dry-run \
  --move --target 'https://<staging-deployment>.convex.cloud' \
  --source-profile "$SOURCE" --profile "$COPY" \
  --runner-id '<staging-runner-uuid>' --user-id '<staging-user-uuid>' --report "$REPORT" \
  --kill-upload --kill-import --rollback-one --go-back-one --hold
```

`--profile` here means a **new directory**, not the old mode's database file.
The harness uses `cp -cR` (APFS clone), never hard links or the source database
for writes. Pi's absolute history locators are rebased only in the copy.
Existing scratch/report paths, live-profile aliases/descendants, app markers,
open SQLite handles, symlinked stores, and unknown/unavailable liveness checks
are refused. `lsof` is required; macOS supplies it. Non-macOS operator runs
are refused rather than falling back to a different copy mechanism.

The target is explicit and never taken from ambient deployment variables.
The known production deployment is refused without `--allow-production`;
**do not use that flag for a rehearsal**. A URL cannot identify every future
production deployment: verify it against your operator inventory. Staging's
cleanup opt-in is a second required gate.

Moves are sequential, with **stop at first problem** forced on. Removed
projects are excluded unless `--include-removed-projects` is added. The kill
options SIGKILL an engine child with a PUT/import request in flight, then
restart a new child over the same durable queue. Requests may have landed;
resume must reconcile them, not assume they failed. A second completed run
must be unchanged. `--rollback-one` rolls back the first project, waits for its
purge, then moves it again. `--go-back-one` saves one project's readable cloud
changes and unlocks its local copy through the real escape hatch.

### Owner UI check at `--hold`

The command pauses **after all projects verify**, before rollback/escape-hatch
exercises and cleanup. Create the checkout-local public
`.scratch/deployments/staging.json` from the runbook's reviewed dev-target
instructions (exactly the same target URL). In another terminal:

```sh
pnpm build
node apps/desktop/e2e/volli-drive/rehearsal-ui.mjs \
  --profile '<absolute COPY path printed/chosen above>' --deployment staging
```

This is a visible, keychain-trapped dev launch with isolated HOME, Pi auth,
git config, SSH-agent exclusion and a loopback fake model, using the existing
volli-drive launch gate and environment rules. The copy's parent must be a
private temporary root outside your home; do not launch Electron directly on
the clone with the real keychain/home. The copied production account cannot be
unsealed by the harness. Click sign-in; open the staging WorkOS URL recorded
in `$REHEARSAL_ROOT/harness/external-requests.jsonl` yourself in a browser.
The launcher first replaces the copy's checkout pointers with empty scratch
folders, clears copied Working-copy/cleanup/process registrations, and turns
off copied process auto-reaping. It never runs git in the owner's repositories.
Do not enter real model/provider credentials, open terminals, select a real
folder, or start/resume a Session during this owner-history check.

Sign in to the staging account, select the disposable `migration-rehearsal-…`
Workspace, and check the moved project **read-only**: board, a Session
transcript and an attachment. This is a manual UI check, **not** something the
harness's window-read verification proves. Real-folder/Working-copy reuse and
new-Session execution must be checked separately on disposable repository and
worktree fixtures, never on the owner's original checkout from this copy.
Those execution checks are not claimed by this owner-history rehearsal.
The ordinary `volli-drive launch --deployment staging --fixture empty` path
creates a fresh profile and is not this copied-profile check. Never substitute
the live profile. Quit the dev app completely before pressing Enter in the
harness. Rollback explicitly confirms discarding changes from this rehearsal's
UI check; no normal product rollback policy is changed. After this UI check,
rollback/re-move/return use the copy's scrubbed machine paths, not the owner's
original checkout registrations.

### Results and cleanup

The JSON file contains per-operation elapsed times and peak engine-process
RSS (including killed runs, rollback and go-back), an overall RSS peak,
counts, verification booleans, states and allowlisted refusal/failure codes. No content, paths, project/move ids, tokens or exception text.
Exit 0 requires every selected project verified, no refused rows, every
requested kill point reached, and both cleanups complete. Keep the separate
manual UI result beside it, outside git. No staging or owner-profile run is
claimed by the synthetic backend test.

Cleanup uncommits/aborts **only this fresh Workspace's imports**, waits for the
normal row/object purge, then removes its membership, policy and audit rows
and marks the empty Workspace deleted. Content-free Workspace/import/stream
tombstones remain: move ids stay single-use and accounting references are not
orphaned. It never deletes an existing Workspace or
runner. Upload expiry protection means rollback/cleanup can each take
**30–45 minutes**; keep refreshing the staging person token. The scratch
profile (including its backups and readable escape-hatch export) is deleted.
Save anything you want from it before continuing past `--hold`. Afterward
remove the temporary root's UI HOME/evidence and sensitive input files through
your usual secure workflow; the harness deletes only the copied profile.

If auth/network/purge cleanup fails, the report stays failed and a private
`$COPY.rehearsal.json` recovery file remains. After renewing the staging
credentials, run:

```sh
pnpm --filter @volli/host-core migration:dry-run --cleanup "$COPY.rehearsal.json"
```

This retries cloud cleanup only; it never removes a running app's profile.
After confirming the app is quit and cleanup succeeded, remove any remaining
scratch profile and recovery file yourself. An externally SIGKILLed parent
also leaves this recovery file and the copy for the same recovery procedure.
Do not disable the staging cleanup opt-in until recovery is complete; disable
it afterward. Never commit the copy, reports, OAuth material or deployment
profiles.

## Original loopback importer

### Running it

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

| Export stream                                           | Dry run                                                                                                                                                                                    |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Convex-bound streams (`MIGRATION_IMPORT_STREAMS`)       | `migration:importRows`, batched (≤ 200 rows, ≤ 3 MiB), idempotent by each table's key                                                                                                      |
| `sessionEvents` of a Session active within `--hot-days` | `sessionEvents` as `sessionEventImportRecord` sends them: classified (`kindKnown`, `quarantine`), payload and provenance as JSON text, so `$`-keyed and >256 KB payloads are stored inline |
| `sessionEvents` of an older Session                     | `…/ev/{first}-{last}.ndjson.zst` (`volli.session-events/1`) + `eventArchives` rows                                                                                                         |
| every Session                                           | `sessionIntake`, claimed by the migrating Mac, `acceptedThrough` = its last sequence                                                                                                       |
| `blobs`                                                 | the row, plus the bytes at its key                                                                                                                                                         |
| `legacyRows`                                            | `…/legacy/{name}.ndjson.zst` per project; host-wide rows under `v1/u/{userId}/legacy/` (kept)                                                                                              |
| runner streams (`projectCheckoutPaths`, …)              | a local runner directory; never uploaded                                                                                                                                                   |
| pending Automation arrivals and old schedule cursors    | archived in `legacyRows` with a re-arm reason; never executable                                                                                                                            |
| column armings and scheduled definitions                | paused `automationArmings` / `automationSchedules`; explicit re-arm computes a fresh cursor; original armings also remain in `legacyRows`                                                  |
| `transcriptArtifacts`, `piLogs`                         | verified source chunks staged and read back through the object stand-in; counts/bytes in `history`                                                                                         |

The object-storage stand-in is a directory laid out by the `@volli/shared/cloud`
key functions; real uploads (presigned PUTs) replace it when R2 exists.
Transcript bodies and Pi logs are read from the original profile's sibling
stores, not from the temporary SQLite copy. Missing/corrupt linked bytes refuse
export. See [`../migration-export/README.md`](../migration-export/README.md) for
the bulk source-stream contract. Producing/committing real `tx/` and `pi/`
segments through the move-authorized doors is the Session-history importer's job;
this rehearsal currently proves the source streams, not cloud viewer hydration.
