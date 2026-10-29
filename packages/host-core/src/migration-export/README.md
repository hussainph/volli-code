# Migration export

`exportMigrationSnapshot` (or its worker request) reads SQLite and sibling file
stores without changing them. It writes an atomic, verified directory of NDJSON
chunks. No backend or upload runs here.

## Selection

- `projectIds?: readonly string[]`: absent means the whole local profile; present
  means only those projects, with no personal settings or unbound Automations.
  Unknown, shadow or ineligible ids refuse the export. An empty list selects none.
- `includeRemovedProjects` is false by default. An explicit selection of a removed
  project also needs this option.
- Ownership queries use a TEMP-view closure; profile settings and the legacy
  Automation ledger apply the same selection explicitly in their mappers.
  Sidecar provenance/order rows are only read through selected owners. Session
  ancestry is resolved against the whole snapshot so inherited visibility cannot
  widen when only the child's project moves. Projects/tickets marked in
  `cloud_shadow_rows` and Sessions identified as cloud-owned by `localProductRow()`
  (cursor or birth ownership) are excluded with their children.
- `manifest.projectIds` is the actual selection; `profileStep` says whether
  profile-level rows may be present. `source.tableRows` always counts the **raw
  whole snapshot**, not selected rows; stream counts describe the selection.
- `crossProjectReferences` counts delegations (child → parent), shared blob hashes
  (selected linking project → each other local linking project), and occurrences
  of existing ticket keys in ticket titles/bodies, comments and event payloads.
  Duplicate prefixes may resolve an occurrence to several projects;
  `prefixClashes` lists those ambiguous prefixes and project ids. Text and ids
  are never rewritten.

A broken database FK is a named refusal **before** ownership filtering, even if
its missing owner makes project attribution impossible. The same check applies
to project ownership columns without declared FKs (historical failed attempts,
for example). A legacy-local Session tied to a ticket outside the selected local
closure—including a shadow ticket—is also refused by name rather than dropped;
only known cloud-owned Sessions are excluded automatically. This conservatively
blocks a partial move rather than dropping an unattributable orphan. Unlinked
blob files stay local; every selected linked blob's bytes and size must verify.

## No executable work

`pendingRunnerWork: false` is checked against zero `runnerJobs` and
`automationScheduleCursors` streams. Column armings and scheduled definitions
move into pause-only records: the shared importer forces `pausedReason: moved`
and stamps `pausedAt`. Schedules have an inert far-future cursor until explicit re-arm
computes a fresh strictly-future occurrence. Original armings, pending arrivals
and old schedule cursors are also kept in the legacy archive; no queued work moves. Queued follow-ups, undelivered notices/Run messages and
unfinished cleanup commands (including accepted-but-not-completed commands) refuse export. A durable interruption fact is terminal too, so old interrupted cleanups do not permanently block a move. Historical unclosed attachments are
counted, not treated as live turns. The move engine must freeze the project and
check actual runtime liveness before invoking this exporter.

## Bulk source streams

`transcriptArtifacts` and `piLogs` have destination `object`, **not `convex`**.

- A transcript record names project, Session, event sequence and `digest`, and
  carries the verified uncompressed canonical JSON in `canonicalJson`. Plain and
  gzip source files are supported by the real artifact store. Every
  `transcript.referenced` event must have exactly one matching record, even when
  several references share a digest. Missing/corrupt files are named refusals.
- A Pi record names project, Session, attachment and the durable `piFileId`, plus
  `startOffset`, `endOffset`, total `fileBytes`, `sourceBytes`, `sourceSha256` and
  `base64`. Ranges are contiguous from zero, bounded to 1 MiB, and end on complete
  JSONL lines. Oversized/incomplete lines refuse export. Only this Mac's local Pi
  attachment layout is read, without following a file/directory symlink. Missing,
  changing or nonregular files are named refusals. `piLogFiles` pins the expected
  file set, so dropping an entire file's records also fails coverage. An empty
  file has one empty record. The checksum is of **source bytes**, never a compressed object's hash.

These are plaintext history, not redacted upload objects. The export directory
is private (0700). The receiving Session-history importer must redact before
upload, pack canonical artifacts into the shared `volli.transcript-pack/1` format,
compress Pi ranges and derive their stored size/hash, then commit through the
move-authorized transcript/Pi segment doors. It must not pass a source hash as a
segment object's hash. The dry run stages and reads back source chunks only;
it does not claim a Session is yet viewable through those segment doors.

## Import contract

The move engine converts one selected project's export into exactly
`MIGRATION_IMPORT_STREAMS`: synthesize `sessionIntake` at each Session's last
sequence, keep `eventArchives` empty for an all-hot move, classify events with the
shared codec (`kindKnown`, quarantine and oversize handling), resolve placeholders
and compute `MigrationDigest` over the resulting documents. Those target-specific
digests cannot be computed by this target-independent exporter. Do not pass this
manifest's runner/legacy/object streams directly to `projectImports.begin`.
Personal settings require the separate profile step, not the project import API.

## Resume

The mapper version and a hashed identity of source, selection, file-store roots
and home-directory redaction guard every resume, including a completed partial
manifest awaiting publication. Database sources resume from durable checkpoints.
Bulk source chunks are rebuilt from the snapshot's references on each resume;
interrupted bulk chunks are unjournaled and removed before rebuilding. Artifacts
are content-addressed; Pi files must stay stable while read. Cancellation during
either path leaves no published export. `verifyMigrationExport` rechecks chunk
hashes, sizes and counts **and** transcript digest coverage / Pi range coverage.
Bulk chunks honor the export's optional chunk byte/record limits (a single
artifact or Pi slice is indivisible), otherwise they share the database streams' default of 8 MiB / 50k rows.
