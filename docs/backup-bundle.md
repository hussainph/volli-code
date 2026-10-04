# The Volli backup bundle

A backup bundle is the one file a Volli profile can be **restored** from. It is
a separate, versioned format from the JSON data export, and the two are not
interchangeable.

| | `volli-export` JSON | `volli-backup` bundle |
| --- | --- | --- |
| Purpose | reading, inspection, portability | restoring a profile |
| Attachments | no | yes, bytes included |
| Transcripts | no | yes, files included |
| Integrity | none | SHA-256 per file, in a manifest |
| Restore path | **none, ever** | staged restore into a clean profile |

A reader given the JSON export says so by name and refuses it. That refusal is
deliberate: the export is missing attachments, transcripts, and several ledgers,
so a "restore" from it would silently produce a profile that has quietly lost
things.

Source: `packages/host-core/src/backup/` (`@volli/host-core/backup/*`).

## Container

`volli-backup-<YYYY-MM-DD>.tar.gz` — a gzip-compressed POSIX **ustar** archive.
`tar -tzf` lists it, so a bundle stays inspectable without Volli.

```
manifest.json
data.json
artifacts/blobs/<sha256>
artifacts/transcripts/<sha256>.json
```

The reader enforces, before anything else:

- only regular files; a directory, symlink or device entry is refused;
- paths matching `[A-Za-z0-9._-]` segments only — no `..`, no absolute path, no
  empty or repeated separator, no backslash, no NUL, no split ustar prefix;
- no duplicate path;
- no file the manifest does not list, and no manifest entry with no file;
- a truncated stream is an error, never a partial result.

## `manifest.json`

```jsonc
{
  "format": "volli-backup",
  "bundleVersion": 1,
  "appVersion": "0.2.0",           // the app that wrote the bundle
  "schemaVersion": 41,             // the source database's PRAGMA user_version
  "createdAt": "2026-07-15T00:00:00.000Z",
  "entries": [
    { "path": "data.json", "kind": "data", "sizeBytes": 12345, "sha256": "…" },
    { "path": "artifacts/blobs/…", "kind": "blob", "sizeBytes": 23, "sha256": "…" },
    { "path": "artifacts/transcripts/….json", "kind": "transcript", "sizeBytes": 210, "sha256": "…" }
  ]
}
```

The manifest does not hash itself. A self-hash is worth exactly as much as the
copy of it sitting beside it; what makes the bundle checkable is that every
entry it names is verified against the bytes actually present.

## `data.json`

One column-faithful dump of every **included** table:

```jsonc
{
  "format": "volli-backup-data",
  "dataVersion": 1,
  "schemaVersion": 41,
  "appVersion": "0.2.0",
  "createdAt": "2026-07-15T00:00:00.000Z",
  "usageCoverage": { "meteredFrom": 1750000000000 },
  "tables": {
    "projects": { "columns": ["id", "name", "path", …], "rows": [[…], …] }
  }
}
```

Values are JSON scalars, `{ "base64": "…" }` for a BLOB, and `{ "int": "…" }`
for a 64-bit integer. Rows are ordered by primary key, so two bundles of an
unchanged profile differ only in `createdAt`.

## Backup decisions

Every persisted table, column redaction and profile directory has exactly one
decision in `backup/decisions.ts`, with a reason:

- **include** — the bundle carries the rows; a restore puts them back.
- **rebuild** — the bundle carries no rows because a restore derives them from
  something it does carry, and does. `session_usage` and
  `session_usage_coverage` are the two.
- **exclude** — must not travel: `secrets`, `legacy_safe_storage_secrets`,
  `web_access_settings`, `registered_harnesses`, `harness_channel`.

`decisions.test.ts` holds the register against a live migrated schema, so a
migration that adds a table fails the suite until someone decides what a backup
does with it.

Redacted values (rows travel, the value does not):

| Column | Becomes | Why |
| --- | --- | --- |
| `projects.path` | `""` | mapped to a local directory at restore |
| `tickets.worktree_path` | `NULL` | a directory on the source machine |
| `session_attachments.native_id` | `NULL` | a handle to a process that is gone |
| `session_attachments.native_detail` | `cwd` key stripped | terminal working directory |
| `session_provenances.provenance` / `session_events.payload` | `cwd` key stripped | the same directory, inside a fact |
| `session_commands.route` | `cwd` key stripped | delivery route, never a live directory |

The redactions cover every value the app **acts on** — a directory it would
create a worktree in, run a setup command in, or reconnect a terminal to. They
are not a scrub of every path-shaped string: an agent's tool call that named
`/Users/you/code/thing` stays in its event payload as the fact it was, and
transcript files are content-addressed, so a bundle carries them byte for byte.
A restored profile reuses none of those strings; it also does not hide them.

## Restore

`restoreBackupBundle` never merges and never overwrites.

1. Read the archive, then the manifest; check bundle-format compatibility.
2. Verify every entry's path, size and SHA-256.
3. Validate the data document's shape and every record link, plus that each
   blob record and transcript reference has exactly one artifact.
4. Require a **local directory for every project**. No saved path is reused;
   the bundle does not carry one. Two projects cannot share a directory, and a
   directory that does not exist is refused rather than created.
5. Stage a whole new profile in `<profile>/.volli-restore-<n>/`: a fresh
   database migrated to the bundle's schema, the rows written with foreign keys
   deferred, then the remaining migrations, then the rebuilt usage views, then
   the artifacts.
6. Verify the staged profile: `foreign_key_check`, per-table row counts, the
   rebuilt usage index against its source events, and every artifact re-hashed
   where it now lives.
7. Only then activate: the previous profile's files move to
   `<profile>/.volli-replaced-<n>/` and the staged ones take their place.

Any failure before step 7 removes the staging directory and leaves the original
profile byte-for-byte unchanged, with a list of named problems to show.

Activation is the fenced swap of `db/database-file.ts` (VC-628), the one module
that may put a file at the database path. It holds the open lock, writes the
`volli.db.recovery-pending` marker durably before moving anything, and takes
SQLite's exclusive ownership of the live database. A restore under a running
app is refused rather than renaming the file out from under its writer. The
live database stays at its path until the staged one replaces it with one
atomic rename, so the path is never empty. A crash mid-swap leaves the marker,
and the next launch refuses to open instead of creating an empty profile. A
failure puts the previous profile back and clears the marker. If the previous
profile cannot be put back, the marker stays and its files stay in
`.volli-replaced-<n>/`.

**Credentials (VC-559).** No bundle carries a credential, whichever
secret-key adapter sealed it: the macOS keychain or a headless host's key
file. A bundle from a Mac therefore restores onto a headless host, or the
other way around, like any other. The swap moves only `volli.db*`, `blobs` and
`session-transcripts`, so the target's `session-secrets.enc`,
`session-secrets.key` and `mcp-credentials.json` stay exactly as they were. The
report's `credentials` field says nothing was carried, lists what to enter
again, and gives one sentence to show. See
[docs/secrets.md](secrets.md#across-machines-and-adapters).

## Supported versions

**Bundle format.** This build writes bundle version `1` and reads
`SUPPORTED_BUNDLE_VERSIONS` (currently `[1]`). A newer bundle is refused with
"this backup was written by a newer version of Volli"; an older unsupported one
is refused as unsupported. New bundle versions are added to that list with a
documented reader, never guessed at.

**Database schema window.** A bundle records the source database's
`user_version`. A restore accepts any schema **at or below** this build's newest
migration and migrates it forward — the same walk a launch performs on upgrade —
then rebuilds `session_usage` and `session_usage_coverage` in the restored
profile. A bundle whose schema is newer than the build is refused; the answer is
to update Volli.

In practice: **a bundle restores into the app version that wrote it or any later
one; never into an earlier one.** `restore.test.ts` exercises the newest schema
and the two below it end to end, including the two rebuilt usage views.

## Not yet wired

Creating and restoring a bundle is a main-process capability with no menu item
or Settings surface yet. Streaming, progress, cancellation and atomic writes are
VC-317's; the reader takes bytes and the writer returns bytes precisely so that
work can land without changing this format.
