# Sealed host credentials

The host credential module lives in `packages/host-core/src/secrets/`, behind
local key-provider ports. Desktop supplies OS key wrapping; hostd supplies a
private key file. Pi owns provider authentication and refresh, and MCP owns its
protocol; storage adapters must not reimplement either.

[Session secrets](secrets.md) describes current storage and callers. In
particular, persistent Session secrets still use `session-secrets.enc`, web
search keys have a sealed mirror with SQLite canonical, and MCP and Pi retain
their own stores. The requirements below apply to credential storage changes;
they do not imply those families have already completed a cutover.

## Invariants

- Keys are generated and provisioned locally. No provider-controlled KMS,
  metadata-service sealing key, mandatory network service or recovery escrow.
- Credentials are expendable; work is not. A lost key disables credentials,
  never local boot, the board, artifacts, Session history or database recovery.
- Storage unification grants no authority. Agents cannot select host credential
  namespaces, enumerate host-only values or become a device or person.
- Credential values never enter general receipts, events, transcripts or backup
  bundles. Only `session-env` participates in subprocess environment injection.
- No plaintext fallback and no overwrite of an unreadable inventory. Reset is
  explicit person or local-admin intent, never an agent verb.
- Hostd defaults to a local file key. TPM binding is explicit opt-in, never an
  automatic cloud default. Re-entry must work without a recovery export.
- Browser profiles, user-owned SSH files and external Pi stores are separate
  boundaries. Do not discover or import them automatically, or claim that every
  host-held credential is sealed.

## Typed inventory and file contract

`host-credentials.enc` uses authenticated AES-256-GCM:

```text
VHC1 | backend | key id (16 bytes) | nonce (12 bytes) | tag (16 bytes) | ciphertext
```

The header is associated data. A key id is a labelled hash selecting a key,
not authority, freshness or an epoch. Resolve exactly the header's id; refuse
colliding ids and unknown keys. Preserve legacy `VSF1` and `VSC1` readers rather
than reinterpreting their shipped bytes. Desktop's wrapped key is a separate
`host-credentials.key` file (`VHK1 | wrapped key`). Never make a replacement key
while an unreadable sealed inventory exists.

The plaintext has a schema version, inventory UUID, commit generation and typed
records. Records have UUID ids, fixed-field selectors, values, revisions and
write timestamps. Delete then recreate yields a fresh id and later revision.
A mutation compares `{id, revision}` against the record it read, so sign-out or
new sign-in wins over a late OAuth refresh. Newer schemas are `locked`
(`newer-format`), not empty, and are never rewritten.

| Family | Selector | Reader |
|---|---|---|
| `session-env` | project/always scope, project, variable name | Session injection |
| `web-search` | provider | Web Access settings |
| `mcp` | server id and endpoint | MCP connection; entire values/OAuth/registration record |
| `pi-provider` | provider | Pi `CredentialStore`; preserve provider-specific fields |
| `host-private` | purpose | Host authentication |
| `device-verifier` | host, workspace, device | Device authentication |
| `worker-verifier` | host, workspace, worker | Worker authentication |

Keep `isSecretName` restrictive; do not encode host tokens as environment
variables. Private keys and credential values are not SQLite rows. Non-secret
public identities and authorization state remain separate.

The operator verifier stays in its root-controlled, service-readable,
non-writable file. A service-writable encrypted namespace cannot preserve the
integrity boundary that prevents a Session from minting person authority.
Local admin issuance/revocation must remain usable with credentials locked.

All inventory, keyring, lock, temporary, import and rotation siblings have exact
backup-exclusion decisions. Structured reads refuse their paths and symlink
aliases. These guards do not constrain arbitrary same-uid shell programs.

## Cross-process ownership and freshness

Every read-for-use and read/modify/write holds `host-credentials.lock`, reloads
the authenticated file and merges only the scoped mutation. Last-use writes
follow the same rule. The lock is SQLite's kernel-backed advisory lock on a
stable private sibling file; it releases on process death. Never unlink it,
lock the replaceable ciphertext inode, inherit it into Session children or steal
it by age/PID. All participants use one canonical profile path and backend.

Synchronous methods try once; busy never blocks Electron's main thread. Waiting
callers retry asynchronously with a bound (normally ten seconds). No stale
credential use on timeout, and no SQLite transaction spans an `await`.

A write uses a unique same-directory `O_EXCL` mode-0600 temporary, fsyncs it,
renames over the active file and fsyncs the directory. Check the active bytes
still match the authenticated source before replacing them. Failure after rename
is indeterminate: reread before retrying, never report that nothing committed or
restore a cached generation. Atomic rename prevents torn files, not lost updates.

OAuth/network work never holds the global lock. Serialize refresh per provider
or server separately, then reload and compare revision before committing. Lock
order is refresh/import-source lock → DB migration ownership when needed →
global credential lock → short synchronous SQL transaction. No inverse nesting.
Preserve Pi `modify`'s `undefined` meaning unchanged, not deletion.

Revocation stops future use, not a process's existing environment or an already
authorized request. Keep replaced/revoked values in launch redaction history.
Two limits remain explicit:

- A revocation between environment read and process spawn can reach that one
  spawn; the next command reloads.
- Replacing legacy `session-secrets.enc` with older valid ciphertext under the
  same key can restore revoked values: its payload has no generation/tombstone.
  Authenticated encryption alone does not prevent rollback.

Advisory locks do not constrain old or hostile non-cooperating writers. Stop
older processes before upgrading. Desktop/headless legacy envelopes are not
interchangeable; backend mismatch degrades credentials, never falls back.
Credential locking is separate from database lifetime ownership and workspace
fencing. Mutations need verified local rename/fsync/lock semantics.

## Credential migration compatibility

A credential read/write switch is breaking even when its old SQL table remains.
Use independently verified expand, switch and contract boundaries (`E < S < C`),
not reserved migration numbers. Freeze shipped SQL/apply sources and their
`raisesMinReader` declarations. The baseline reader floor is 58; guarded older
builds refuse above their supported head without writing DB/WAL or credentials.

### Expand

Keep legacy storage authoritative and `raisesMinReader` off. Non-secret lineage
and monotonic source revisions must count every insert, update and clear,
including writes from older builds. Never store secret values or low-entropy
secret hashes in progress metadata. Progress is excluded from bundles and
rebuildable on open.

Under the credential lock, capture a coherent source snapshot in a short SQL
read, seal a mirror, fsync, reopen/decrypt and compare before publishing a
receipt binding source revision, inventory id and generation. Saves/clears
commit to the source first. A mirror failure means save committed, sealing
pending. Reconcile deletes too; a stale mirror never resurrects a cleared key.
Locked/corrupt keys leave expansion pending and local boot available. A bundle
restore supplies a new credential-free lineage, not old mirror values.

### Switch

Quiesce writers, take the database-file fence then credential lock, reconcile
the final source and durably verify the sealed inventory **before** the SQL
transaction. Recheck the source revision inside that transaction. Set canonical
mode, `user_version` and the reader floor together with `raisesMinReader: true`.
The read switch never precedes the floor, and a feature flag cannot undo it.

Every permitted build must understand every credential format it may mutate.
Do not reuse a floor for a later family whose reader an allowed older build
lacks. Never export plaintext compatibility files to permit downgrade.

If the prerequisite is unavailable, retain supported expand-mode boot with the
transition pending; do not delete sources or run dependent migrations. A
first-run or credential-free restore has an explicit empty-source path. Abandoning
an unreadable source requires explicit confirmation, not inference of emptiness.

### Contract

A separately gated breaking migration removes legacy tables/readers/importers.
Never edit the old migration that introduced them. DELETE/DROP does not erase
freelist, WAL or copied bytes. With writers stopped, use the database-file module
to build, verify and durably swap a compact credential-free database, preserving
its floor. Do not force a busy WAL or replicate raw plaintext during expansion.

Retire only exact, approved stale database families after verified cutover and
a tested credential-free replacement recovery point. Include complete sidecars,
preserved/pending/quarantined families; never delete the sole verified rollback
point or unresolved recovery source. Cleanup is retryable, records non-secret
completion and reports partial failures. Keep pending families private.
Deletion is not secure erasure of SSD blocks, snapshots or external copies;
revoke/reissue exposed provider credentials separately.

An upgrade skipping releases must still honor the external durability boundary;
do not batch E/S/C blindly in one migration transaction. Restoring an old raw DB
repeats reconciliation; it never trusts a stale receipt or invents the floor.

## Keys, rotation and recovery

Rotation must observe keys by id on each locked read, not only at startup:

1. Authenticate current file with K1. Durably provision random K2; retain K1.
2. Seal a new generation with a fresh nonce, fsync, reopen and verify ids/records.
3. Preserve old ciphertext at a unique rollback name without removing the active
   path, fsync, atomically replace the active name and fsync again.
4. The committed header selects the key. A crash leaves K1 or K2 active; keep
   both keys/files through indeterminate durability. Never choose newest filename.
5. Retire K1 and rollback siblings only after verified commit/restart and explicit
   retention policy. Rotation does not revoke leaked provider tokens.

Missing/wrong/malformed keys, unavailable OS key wrapping, unknown backend,
newer format and corrupt ciphertext preserve bytes and refuse persistent saves.
Local history, status and admin recovery keep working. Remote authentication
may remain unavailable, but never becomes unauthenticated access. Reset moves
unreadable ciphertext aside under the lock, confirms affected credential kinds
and requires re-entry. Archives are excluded from bundles, not auto-destroyed.

Optional systemd/TPM backends require real fail-soft activation tests: decryption
can fail before hostd executes. A required failed unit cannot be described as
application-level degraded boot. Do not relax the file adapter's uid/mode checks
for manager-owned ACL files. No automatic TPM selection or provider custody.
Credential recovery exports are not a shipped prerequisite or ordinary bundle
feature; re-entering credentials is sufficient.

## Verification requirements

Exercise real older builds for save/clear/use/backup/restore in expand mode;
hash DB/WAL around switch/contract refusals. Cover direct pre-expand upgrades,
source changes after staged receipt, deleted-key resurrection, disk-full/fsync
failure, multiple processes and crashes at every file/SQL/rotation boundary.

Lost-key tests use a real temporary database with board/Session history and
sentinel credentials. Verify local boot and history survive, no value is used or
leaked, sealed files are unchanged without reset, and re-entry restores service.
MCP imports preserve endpoint binding and compare-before-refresh semantics;
Pi imports require explicit intent and source locking, leave user-owned
`auth.json` untouched and do not continuously mirror rotating grants.
