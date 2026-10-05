# One sealed host credential store

**Status:** owner-approved design, VC-631 / VC-539, 2026-10-04. Lost-key
degradation shipped in VC-641; the typed module, lock and key-id format in
VC-642 ([what exists](../secrets.md#the-typed-credential-module-vc-642)). The
§6 lock is SQLite's `fcntl` file lock on `host-credentials.lock`, the
mechanism `db/open-lock.ts` already ships on both hosts.
This PR changes documentation only: no migration, credential access or deletion.
The owner's decisions are recorded at the end. **Lost-key degradation comes
first:** fix hostd's current boot refusal using the existing store/key port,
then build the typed module. DB migration and cleanup follow VC-628 (fenced
DB-file operations, [PR #740](https://github.com/hussainph/volli-code/pull/740),
still under review); this note depends on none of its unmerged code. Finish
the application credential cutover before M2 pairing.

Current-code citations are relative to this repository at `bdc0e925b`.
`H:` below means `packages/host-core/src/`; `R:` means
`packages/agent-runtime/src/`; `D:` means `apps/desktop/src/main/`.
Directions here supersede neither current behavior in [secrets.md](../secrets.md)
nor the [Cloud ruling](volli-cloud.md) until their implementation lands.

## 1. Decision and invariants

Extend `SecretStore` into one host-owned, typed credential module, with one
active authenticated ciphertext file and interchangeable local key backends.
Pi still owns provider authentication and refresh logic; MCP still owns its
protocol. They receive storage adapters, not new authentication implementations.

- **No provider-controlled key custody.** No cloud KMS, vendor secrets manager,
  IMDS-sourced sealing key or required network key service. Keys are generated
  and provisioned on owner-administered machines. A rented VM is administered
  by the owner, but its hypervisor is not trusted against disclosure.
- **Credentials are expendable; work is not.** Board, artifacts, Sessions and
  authority epoch history are never encrypted under this key. An unusable key
  disables credentials, not boot, database access or local operator recovery.
- **TPM is opt-in.** M2 defaults to the host key file. An optional systemd-creds
  `host` adapter requires real fail-soft unit tests; `host+tpm2` is explicit
  bare-metal opt-in, never the cloud default or automatic TPM selection.
  TPM loss must allow re-entry even without a recovery export.
- **Recovery is optional and operator-held; age recovery is deferred.**
  Re-entering credentials is enough for the first cut. No recovery private key
  on a provider's control plane, no mandatory escrow, and no promise that a
  cloud vTPM is an independent owner-held recovery copy.
- **Storage unification is not an authority grant.** A Session cannot enumerate
  host-only values, become a device/person, or choose the credential namespace.
  Values never enter general command receipts, events, transcripts or backups.
- **Fail closed locally, degrade globally.** No plaintext fallback or silent
  overwrite of an unreadable inventory. Recovery/reset is explicit person or
  local-admin intent, never an agent verb.

## 2. Inventory: what exists, and what is only planned

| Material | Current location / protection | Reader and lifetime | Target |
|---|---|---|---|
| Session-requested values | Memory for Session scope; Project/Always in `<dataDir>/session-secrets.enc`, AES-256-GCM, 0600 | `SecretStore` → structured subprocess environment/redactor; attachment/store lifetime for memory, until replacement/revocation for persistent values | Keep ephemeral values ephemeral; migrate persistent records into the typed store |
| Sealing data key | hostd: `<dataDir>/session-secrets.key` or absolute `VOLLI_SECRET_KEY_FILE`, 0600, own uid, base64 random 32 bytes; desktop: safeStorage-wrapped random key inside `VSC1` file | Key port; currently cached per launch, no rotation | Local backend keyring; never a credential injectable into execution |
| Brave and Exa search API keys | `volli.db`, `secrets.value TEXT`, plaintext; also raw migration safety copies and potentially old DB/WAL pages | `WebCredentialStore` → `WebAccessSettings.resolve()` → provider constructor; saved until clear/replacement | `web-search` records, host-only |
| Pre-023 web key ciphertext | `legacy_safe_storage_secrets.ciphertext`, machine-bound safeStorage | Desktop one-time importer; hostd cannot decrypt; remains if keychain unavailable | Import directly into sealed storage, or explicitly discard/re-enter; no new plaintext SQLite staging |
| MCP manual values | `<dataDir>/mcp-credentials.json`, plaintext JSON, 0600; slots include environment, headers, OAuth client secret | MCP settings/connection wiring; until delete/replacement | `mcp` records, scoped to server id and endpoint |
| MCP OAuth state | Same JSON: access/refresh tokens, expiry, dynamic client registration (may include client secret), discovery and callback port | MCP OAuth and request authentication; refreshable grant until sign-out/revocation | Same complete per-server record, sealed; preserve refresh/revision semantics |
| MCP PKCE verifier and OAuth state nonce | Sign-in object's memory, not credential file | One in-progress sign-in | Memory only, cleared on completion/cancellation/expiry |
| Model provider API keys / OAuth credentials | `$PI_CODING_AGENT_DIR/auth.json`, else `~/.pi/agent/auth.json`; plaintext JSON, writes 0600, outside `dataDir` | `PiFileCredentialStore`, Pi models/sign-in, external `pi` CLI; OAuth refresh via async `modify`, persists until sign-out | Inject a sealed Pi `CredentialStore`; explicit import, no ongoing plaintext export |
| Attachment socket bearer tokens | `SessionTokenRegistry` maps in host memory, injected as `VOLLI_SESSION_TOKEN` | Socket verifier and attachment/CLI; remint/revoke per attachment, dies with host process | Memory only; do not make a dead attachment's token durable |
| Inherited env / external credential references | Operator process environment; MCP `${NAME}` references resolve outside stored manual slots; Pi can resolve provider env auth | Launch/provider/connection; operator controls source and lifetime | Do not persist ambient values automatically; deliberately saved copies use typed store |
| Personal browser cookies / site sign-ins | Chromium's persistent `persist:volli-browser:user` profile; not `SecretStore`; engine owns its protection. Agent partitions are in-memory | Browser engine and authorized tab actuation; personal sign-in survives restart, agent partition dies with launch | Explicit engine-owned boundary, not falsely claimed sealed; disposition below |
| Operator token / verifier (VC-623, in progress) | Proposed: plaintext token in operator-owned 0600 file, hash verifier in root-owned, service-readable/non-writable file | CLI sends person proof; hostd verifies. Until admin revoke; no desktop issuance | Keep verifier outside service-writable store; plaintext never belongs to hostd |
| M2 pairing / device / future worker credentials | Not implemented here; migration 058 stores public ids only | Pairing approval has short expiry; device/worker access lasts until revoke/rotation | Sealed host private keys, refresh material and bearer verifiers; public attribution stays in DB |

Evidence for the inventory:

- Session scope, writes, revocation and injection: `H:secrets/store.ts:169-275,360-362`.
  Authenticated inventory loading, modes and fsynced rename:
  `H:secrets/store.ts:368-483`. Persistent metadata is an array of Session
  records today, not a generic host credential namespace.
- File key path, creation, permissions, key-id envelope and launch cache:
  `H:secrets/file-key.ts:70-109,118-183,243-261,282-315`.
  Desktop wrapping/cache and Linux `basic_text` refusal: `D:secrets/codec.ts:10-59`.
- Plaintext SQL and four repo operations: `H:db/secrets-repo.ts:9-15,24-52`;
  migration 023: `H:db/migrations.ts:858-905`; provider names and lifetime:
  `H:web/credential.ts:39-42,94-129`; consumer: `H:web/settings.ts:175-193`.
  Old ciphertext importer: `D:web/legacy-safe-storage.ts:102-146`.
- MCP shape, slots, ephemeral OAuth distinction and revision contracts:
  `H:mcp/credential-store.ts:18-30,49-114`; plaintext file/cache/write:
  `H:mcp/credential-store.ts:213-288`. Refresh guards compare the grant before
  replacing it: `H:mcp/oauth.ts:803-875`.
- Pi paths/composition: `R:pi/models.ts:65-89,139-158`; read/modify/delete and
  shared Pi lock: `R:pi/models.ts:233-274,286-311`; plaintext writes and accepted
  credential tags: `R:pi/models.ts:452-494`. Env auth is distinguished from a
  stored sign-in at `R:pi/models.ts:124-137`.
- Socket token lifetime and same-uid limitation: `H:session-tokens.ts:20-43,70-101`.
  Browser persistence and actuated sign-ins:
  `H:browser/backend.ts:159-178`, `H:browser/agent-port.ts:21-31`.
- VC-623's root/operator separation is an owner-approved ticket contract, **not
  merged code evidence**. M2's current public-only schema/direction is in
  [host-identity.md](host-identity.md#devices-and-pairing).

“One store” covers application-managed, persistent credential records, not
arbitrary files a user's SSH client, shell or terminal companion holds.
Do not read/import those files on discovery. Browser profiles are a real
remaining credential surface: Chromium persists more than a cookie jar (site
storage can hold bearer tokens too). Moving cookies alone would not unify it.
The owner confirmed a separate plan for a personal browser vault owned by the
engine; M2 workers keep agent profiles ephemeral. Keep that plan's seam open
for the owner's broader browser direction. Do not claim **every** host-held
credential is sealed until that plan is resolved. No browser persistence
behavior changes in this docs PR.

## 3. Target module and file contract

Keep the host-core module behind a key port, with desktop/headless adapters;
no Electron imports in packages. Clients see whitelisted availability/status
metadata and send write-only credential intent through the host's dedicated,
authenticated submission door, not generic board commands or agent tools.

Proposed typed namespaces: `session-env`, `web-search`, `mcp`, `pi-provider`,
`host-private`, `device-verifier`, `worker-verifier`. Record ids are UUIDs;
selectors are typed owner/scope tuples. Do not relax `isSecretName` or encode
host tokens as environment variables. Only `session-env` participates in shell
injection; all other reads require the owning host service. Keep MCP's whole
OAuth record and Pi's tagged `Credential`, including provider-defined fields.
Public host/device ids and non-secret authorization/audit metadata remain in
SQLite; a verifier is preferred over a recoverable bearer token where possible.
Extend structured read refusals to the new file/keyring, recovery exports and
all temporary/rollback siblings, including symlink aliases; today's basename
list covers only the older stores (`R:pi/credential-env.ts:9-20,34-44`). This
remains a tool guard, not protection against arbitrary same-uid shell programs.

Use a new `host-credentials.enc` path and versioned envelope, leaving the
existing Session-only file readable during expansion. Proposed envelope:
magic/version, backend/key id, random 96-bit nonce, tag, ciphertext; authenticate
the header as AES-256-GCM associated data. Encrypted payload includes a schema
version, UUID inventory id, commit generation and typed records/tombstones.
A key id selects a key; it is neither proof of authentication nor an epoch.
Keep legacy `VSF1`/`VSC1` readers for import; do not reinterpret shipped bytes.
`VSF1` has a labelled 8-byte key hash today; `VSC1` has a wrapped key but no
explicit key id (`H:secrets/file-key.ts:77-87,130-135`, `D:secrets/codec.ts:35-37`).
Use a new longer id for the new envelope and collision-refusing key lookup.

The expanded file is only a mirror until cutover. The new build must not put
Session-only values on disk. Existing persistent Session records stay
canonical in the legacy file until its final locked import at switch; legacy
MCP/Pi writers likewise remain canonical until their own cutovers. A single
DB compatibility gate described below covers changes to these file readers,
not only SQL. Do not activate a new incompatible file format on a profile a
permitted older build will still try to mutate. S must ship readers/adapters
for every format it permits before a later MCP/Session/Pi cutover uses them;
otherwise that import needs its own floor-raising migration version. Reusing
a floor while an allowed older build lacks the new file reader is forbidden.

All ciphertext, keyring, rotation siblings, import remnants and locks have an
explicit exclude decision in the backup inventory. Target bundles and WAL
replicas carry no credential rows or files; do not enable raw DB replication
while E/S still holds plaintext or until C's residual cleanup completes.
Current bundles already exclude `secrets`,
`legacy_safe_storage_secrets`, MCP and Session files, and raw safety copies
(`H:backup/decisions.ts:378-390,549-551,580-597`). **Raw migration copies are
not bundles**: they currently copy the entire checkpointed DB
(`H:db/migrations.ts:3368-3376`). Expansion still has plaintext in that DB.

### Pi and MCP feasibility

Pi has the required seam now: `PiModelAccess.credentials: CredentialStore`
and `builtinModels({ credentials })` (`R:pi/models.ts:139-158,181-186`). Replace
file persistence with a host-supplied sealed adapter; Pi still runs its refresh
inside `modify(fn)`. Preserve the unusual `undefined` result meaning “unchanged,”
not deletion (`R:pi/models.ts:247-274`). No fork of provider OAuth logic needed. Model credentials mean Keychain unlock
on signed-in desktop launches, not just launches using persistent Session
secrets; keep it lazy and once per key id, with actionable locked status.
Extract actual Pi access/refresh/API-key strings and MCP secret/token fields
into the redaction history; matching the serialized JSON blob is insufficient.
Whitelisted metadata-only `list()` must enumerate only this host's managed
records, so signing out cannot remove an external user's credential.

Import `auth.json` only through explicit person/local-admin intent. Lock the
source with Pi's existing lock while snapshotting and recording the import;
never race a CLI refresh. Default shared `~/.pi/agent/auth.json` is user-owned:
do not delete it or pretend that import encrypted the original. Offer removal
only for a confirmed host-exclusive source, after committed verified import.
After switch, Volli never reads/writes that file for auth and `/login` in the
external Pi CLI no longer signs Volli in. Prefer independent sign-in over
copying a rotating refresh token shared with a still-running CLI; two copies
can invalidate each other. No continuous mirror, plaintext compatibility file,
or temp `auth.json` for Pi. Catalog caching is a separate, non-secret store.

MCP already has a storage interface (`H:mcp/credential-store.ts:87-114`). Adapt
it to sealed per-server records, with durable secret/access revisions shared
between processes, rather than the current process-cache counters. Preserve
endpoint binding and grant compare-before-write checks. Import final records
with all MCP writers stopped; after switch delete the plaintext file family
only after verification and the applicable compatibility gate. An unreadable
source is preserved, never interpreted as empty success. PKCE/state stays in
memory. These imports share the coordinator's idempotent receipt discipline.

### VC-623 and M2 trust material

**Do not move VC-623's verifier into the ordinary sealed inventory.** It is a
hash of random operator-held material, not a decryptable host secret. Its
critical property is root-controlled integrity: service uid/Session processes
must not add a verifier and thereby mint person authority. Encryption in a
service-writable file would not preserve that. Keep root-owned issuer/revoker
and verifier file, fail closed on missing/invalid verifier, and keep local
admin issue/revoke usable with the credential store locked. Centralize only
its status/read adapter, not its write authority. No operator plaintext import.
If the owner later wants sealed verifiers, they require a separate root-owned
signed/read-only authority artifact, not a namespace ACL in this store.

M2 pairing secrets and host authentication private keys belong here; short-lived
pairing codes/state stay in memory unless the pairing spec requires restart
continuity. Bind durable device verifiers to issuing host, device and workspace;
revocation must remain authorization state, not merely forgetting a value.
A locked store accepts no pairing/device/worker authentication. No token means
no authority. Re-entering keys cannot fabricate valid pairings or epochs.

## 4. Web-key migration: expand → switch → contract

Use **three separately reviewed schema versions**, `E < S < C`, allocated only
when implemented (not reserved numbers). Freeze each shipped SQL/apply source
and its `raisesMinReader` declaration as usual. VC-602's rules are at
`H:db/migrations.ts:2413-2470`. Missing floor means baseline 58; only declared
breaking migrations raise it, transactionally with `user_version`
(`H:db/schema-compatibility.ts:33-56,100-115`, `H:db/migrations.ts:3445-3457`).
The floor fences builds containing VC-602, **not** ancient binaries that ignore
it (`H:db/schema-compatibility.ts:26-28`). Those are unsupported downgrade tools.

### E — expand, compatible with the legacy writer

1. Ship typed store, local backends, lock, lost-key degradation and coordinator
   before enabling the move. Stop legacy processes during deployment; new and
   legacy binaries must not run concurrently against credential files.
2. Append an additive migration: non-secret migration status plus a monotonic
   web-source revision. SQL triggers on insert/update/delete of `secrets`
   advance that revision, including clears. Do not depend on `updated_at` or
   timestamps to detect a downgrade's writes. Do not put values/hashes of low
   entropy secrets in this metadata. Mark status expendable/excluded in bundles.
3. Leave `raisesMinReader` **off**. Triggers accept every old write; progress is
   rebuildable on open. `secrets` remains authoritative. Guarded N-1 reads,
   writes, clears and backups work as before; DB `user_version` never rewinds.
4. Under the credential lock, capture a coherent SQLite snapshot of all web
   key rows and its revision in a short synchronous read transaction. Seal it
   into the new file as a mirror with a receipt containing source revision and
   inventory id. Fsync, reopen/decrypt and compare in memory; never log values.
5. While E is active, new web saves/clears first commit to SQLite, then reseal
   the mirror. Report a mirror failure as “legacy save committed; sealing
   pending,” not a fully sealed success or a failed save that did not happen.
   Every boot/read-switch readiness check reconciles from SQLite, including
   deletes. A stale mirror must never resurrect a cleared key.
6. Locked/corrupt key material leaves expansion pending and boot working;
   legacy credential mode is visibly labelled, not claimed encrypted. There
   is no destructive source deletion. Older-build bundle restores omit this
   progress; rebuild from the restored DB (whose excluded keys are absent),
   never merge stale mirrored web keys back into it.

SQL cannot dual-write an encrypted filesystem document. These are ordered,
idempotent commits with a DB-canonical source, **not** an atomic dual-write.
Until S, sealed reads may be dogfooded behind the flag only after checking the
source revision under the lock and rebuilding on mismatch. If sealing cannot
be verified, report unavailable; do not quietly use a stale mirror.

### S — switch, the first breaking step (also a floor raise)

1. Quiesce credential writers across processes and hold migration ownership
   through VC-628's DB-file boundary, then the credential lock. Read/reconcile
   the final E source, including clears. The implementation must provide an
   explicit coordinator precondition for this migration, not a bare SQL boot
   backfill or a renderer boolean that says “copied.”
2. Durably publish and verify the final sealed inventory/receipt **before**
   starting the SQL transaction. Receipt binds the DB source revision and
   credential inventory, and must be verified by decrypting the actual file.
   Recheck the source revision inside the synchronous migration transaction;
   mismatch aborts/retries from the source. No SQLite transaction spans an await
   ([BOUNDARIES](../BOUNDARIES.md#sqlite-transaction-ownership)).
3. In one SQL transaction set sealed-canonical mode and apply S with
   `raisesMinReader: true`; the runner commits floor S and `user_version` S
   together. Keep legacy rows temporarily for rollback evidence, but no reader
   or writer uses them after this commit. New values go only to the sealed file.
4. The read switch must **not** precede the floor. Moving a value while an old
   writer writes where the new build no longer looks is explicitly breaking
   (`H:db/migrations.ts:2454-2460`). Keeping a table is not compatibility.
   S applies independently of the cloud flag; channel switching cannot undo it.
5. A guarded build with head `< S` refuses on read-only preflight, leaving DB
   and WAL byte-identical, creating no safety copy and not opening credentials
   (`H:db/index.ts:69-90`). It says update, or explicitly restore an older backup;
   never copy the new values back to SQLite to enable a downgrade.
6. On a credential-precondition failure, do not delete rows or commit S. Boot
   the new binary in its supported E mode with transition pending, rather than
   fail hostd. The implementation must retain E-compatible runtime SQL and cap
   the boot migration batch before S (and therefore before dependent versions)
   until verification or explicit reset. This is an acceptance requirement, not
   behavior the current unconditional migration runner already provides.

Crash before sealed publish: E/source intact. After publish but before S:
E/source wins and receipt is reconciled, even if a downgraded writer changed
it. After S: sealed file was durable first, old readers are fenced. Key loss
at any point follows §7, not a DB-recovery error. Retry never overwrites an
unreadable existing inventory. A first-run or credential-free bundle restore
uses an explicit empty-source path; no credential receipt is required to
restore work. Credential resets can also permit S with an empty inventory,
only after explicit confirmation of which sources are being abandoned.

### C — contract and remove the plaintext footprint

1. After switch verification, append C with `raisesMinReader: true`: drop
   `secrets`, its revision triggers, and `legacy_safe_storage_secrets` after
   handling or explicitly abandoning any deferred legacy ciphertext. Keep
   `app_state` and the floor forever. S-capable code must tolerate absence of
   old tables only if specifically proved; default is to fence head `< C`.
2. Remove legacy readers/writers/import-to-SQL code. The desktop legacy
   safeStorage importer currently writes plaintext (`D:web/legacy-safe-storage.ts:139`);
   update its successor to seal directly. Never edit migration 023.
3. The ordinary pre-C rollback point still contains plaintext keys. VC-628
   owns its publication, enumeration and retirement, including entire sidecar,
   preserved, pending and quarantine families; this ticket adds credential
   policy through that boundary, not a second ad-hoc file copier/deleter.
4. DELETE/DROP does not erase SQLite freelist or WAL bytes. With every writer
   stopped, use the fenced DB-file module to build and verify a compact clean
   DB, durably swap it in, and retire old DB/WAL/evidence copies according to
   the approved policy. Preserve the floor; credentials are not DB salvage data.
   Coordinate checkpoint/replication ownership rather than forcing a busy WAL.
5. Create a verified credential-free rollback point/bundle before retiring the
   last plaintext recovery family. Sweep future safety copies for absence of
   credential rows **and** sentinel raw bytes. Local cleanup is not secure
   erasure of SSD blocks, snapshots or previously shipped replicas. If keys
   reached those, revoke/reissue them at the providers; document the limit.

Keep S and C in separate releases/reviewed cutovers, even when an upgrade jumps
from pre-E directly to current. A batch may not blindly run E/S/C in one runner
transaction: the external durability prerequisite must separate the phases.
Use current head-derived versions, test the skipped-release path and keep
pending upgrades visible. Restoring an older raw DB deliberately returns to its
old credential mode; upgrading it repeats reconciliation, not stale receipt use.
A restore must never invent/write the floor: preserve VC-602/VC-628's restore
rule and heal it by the normal migration path only.

### Downgrade contract and tests

| Point reached | N-1 behavior | Returning to new build |
|---|---|---|
| E only, including partially sealed mirror | Legacy writer allowed, plaintext source authoritative | Reconcile changed/new/deleted rows; no one-shot backfill assumption |
| S receipt staged, SQL not committed | Same as E; no floor was raised | Revision mismatch forces reseal, never trust the old receipt |
| S committed | Any guarded head `< S` refuses; head `>= S` must understand typed store and sealed-only writes | Resume sealed mode; no dual-write rollback |
| C committed | Guarded head `< C` refuses by default | No legacy table access; credential-free safety copies |

Run actual N-1 binaries against E fixtures: save, clear, attach/search and make
and restore a bundle, then new-build reconciliation. For S/C refusal hash DB
and WAL before/after. Test crash at each file/SQL boundary, deleted-key
resurrection, disk-full/fsync failure, multiple-process updates, direct pre-E
upgrade and a restore missing all credentials. This note does not claim these
tests have run; they gate the implementation tickets.

## 5. Existing plaintext safety copies: approved purge policy

The ticket reports the owner's v55/v56 families at about **1.8 GB**; this Session
has not opened or measured the real profile. Migration 023 explains why a copied
DB is a copied key (`H:db/migrations.ts:871-876`). Retaining plaintext is a
residual disclosure even after the live DB is cleaned.

| Option | Benefit | Cost / risk |
|---|---|---|
| **Purge stale families after verified cutover** (owner-approved) | Removes redundant local plaintext and disk cost; simplest long-term policy | Loses those raw rollback points; deletion is not secure erase and external snapshots remain |
| Re-encrypt each whole family | Preserves historical rollback data without readable local keys | New encrypted-backup format, recovery/decryption integration and extra disk; sealing key loss can lose rollback data. Re-encrypting only current key rows does not clean freed pages/sidecars |
| Keep, restricted to owner-only storage | No recovery format change; retains pre-migration evidence | Plaintext keys indefinitely, permission boundary only; “all credentials sealed” remains false for that profile |

**The owner chose purge on 2026-10-04; this PR deletes nothing.** Purge only
stale, complete families after verified C, compacted live DB verification and
a tested credential-free replacement recovery point. The owner approves the
exact inventory at that point; policy approval is not approval of filenames.
Delete complete stale families through VC-628; include newly made pre-S/pre-C
copies, preserved duplicates and migration/DB-swap evidence, not merely v55/v56.
Never remove the only verified rollback point during migration or the source of
an unresolved recovery. A damaged/quarantined family requires an explicit
operator disposition, not a broad glob. Persist non-secret cleanup completion,
retry interrupted cleanup, and report partial failures. Until those prerequisites
and exact-inventory approval are satisfied, keep families private and label
cleanup pending; do not claim purging finished.

If retaining historical board evidence is essential, prefer a credential-free
verified bundle over encryption of a credential-bearing raw DB. Any encrypted
raw archive must use an independently operator-recoverable key, not tie the
only backup of workspace work to the expendable credential key. Neither option
can undo previous replication/copying; provider credential rotation handles
that exposure. Schema floor does not prevent reading plaintext with SQLite.

## 6. Cross-process ownership and freshness

Today `#load` caches for the launch and `#persist` renames the whole inventory
without a lock (`H:secrets/store.ts:368-369,435-472`). Atomic rename prevents torn
files, **not lost updates**. Two hostd processes, or desktop and hostd, can both
load generation A and overwrite each other's changes.

Use a stable sibling `host-credentials.lock`, 0600 in an owner-only directory,
with a **kernel advisory exclusive lock** on an open fd for Linux/macOS. Do not
lock the ciphertext inode (rename replaces it), unlink the lock file, or steal
locks by age/PID. Kernel locks release on process death; fd must be close-on-exec
and never inherited by Session children. Node has no built-in portable flock:
select/review a maintained native binding or narrowly scoped host lock adapter,
package it for both hosts, and prove its semantics before implementation ships.

- Every read-for-use and read/modify/write takes the lock, reloads the current
  authenticated generation, then applies only its scoped mutation. Last-use
  metadata updates also merge under it. Do not persist a caller's cached array.
- Publish a unique same-directory 0600/O_EXCL/no-follow temp, fsync contents,
  rename over active file, fsync directory, then publish success. Directory
  fsync is currently best effort (`H:secrets/store.ts:473-483`); new cutover and
  rotation paths require it on supported local filesystems. Failure after
  rename is an indeterminate durability outcome; reread before retrying, never
  report “nothing committed” or revert using a stale cache.
- Use bounded async acquisition and a process queue, not a synchronous wait
  that deadlocks the JS thread needed to release a lock. A read fails unavailable
  on timeout; a failed mutation reaches its caller. No silent stale-key use.
- Do not hold the global file lock across OAuth/network work. Serialize refresh
  per provider/server using a separate kernel-backed lock, then read current,
  refresh, reacquire global lock, compare record revision and commit. Sign-out
  or new sign-in wins over late refresh. Pi's async `modify` needs an adapter
  preserving its callback semantics while merging unrelated provider updates.
  Fixed lock order: refresh/import-source lock → DB migration ownership when
  needed → global credential lock → short SQL transaction. No inverse nesting.
- Read/authorize again before future credential use; revocation cannot erase
  an already running process's environment or an in-flight authorized request.
  Keep launch redaction history for replaced/revoked values and add every newly
  observed value before it can appear in tool output. If inventory is locked,
  block new secret-injecting/unredactable execution; the board still works.

Only locking-aware builds may share the store. Stop older processes before
upgrading/cutting over; advisory locks cannot constrain a binary that ignores
them or a malicious same-uid writer. All participants resolve one canonical
profile path, lock and configured key backend; aliases must not create two
locks. Desktop/headless adapters currently cannot open each other's envelopes
(`H:ports/secret-key.ts:9-17`). Sharing a data dir requires a deliberately common
backend (e.g. a file key), or a reviewed native macOS Keychain hostd adapter plus
explicit rewrap, never automatic fallback. Backend mismatch degrades credentials.

The credential lock does not authorize two independent workspace authorities.
Database lifetime ownership and Cloud epoch fencing remain separate requirements.
Support local filesystems with verified rename/fsync/lock semantics; refuse
credential mutations on unsupported network/FUSE/object mounts rather than
pretend a portable lease is safe. Boot/read-only work remains available.

## 7. Keys, rotation and the lost-key path

### Rotation by key id

Extend today's encrypt/decrypt-only port (`H:ports/secret-key.ts:26-34`) with
explicit resolve-by-id, prepare-new-key and retire-key operations. Cache keys
by id, never just “the key read at boot.” A different process's rotation must
be observed on the next locked read; unknown id means unavailable, not empty.

1. Under the global lock authenticate current file with K1; prepare random K2
   and durably provision it in the local backend/keyring. Keep K1 resolvable.
   For read-only systemd credentials, provision the K1/K2 set externally and
   restart first; a service cannot mutate its activation-time credential files.
2. Seal the same inventory at a new generation under K2 with fresh nonce.
   Fsync and reopen/decrypt the staged file, verifying records and ids.
3. Preserve the **old ciphertext file** at a unique rollback name while leaving
   the active path in place (hard link on supported local filesystems), fsync
   the directory, then atomic rename-over the active path. Fsync directory
   before success. No “rename old away, then rename new in” empty-path window.
4. Resolve active key from the committed header, not a separately updated
   current-key pointer. Crash before rename leaves K1 active; after rename
   leaves K2 active. Both keys/files survive uncertain durability and are
   recoverable under the lock. Never select the newest filename as authority.
5. After verified commit/restart and any selected recovery export, retire K1
   and rollback siblings by explicit policy. A retained old file needs K1;
   removing the key only is not rotation recovery. Ciphertext rotation does
   not revoke leaked API keys, refresh tokens or stolen bearer credentials;
   provider reissue/revocation is a separate operation.

Test failure after each key provision, stage write, fsync, preserve, rename and
cleanup step, plus a second process using cached K1, and collision/unknown key
ids. A format upgrade also needs its own compatibility gate; re-sealing is not
permission for older code to rewrite a new inventory schema.

### Backend comparison and default

| Backend | What it buys | Limit / recovery |
|---|---|---|
| **Host key file** (default hostd) | Portable offline key, simple 0600/uid boundary; put it outside copied data dir | Whole-machine copy with key decrypts; root/same uid can read. Separate operator key copy optional; without it re-enter |
| **systemd-creds `host`** (optional Linux) | Seals the data key with local root-owned `/var/lib/systemd/credential.secret`; runtime delivery through `$CREDENTIALS_DIRECTORY` | Not hardware-bound; root or a disk copy with host secret decrypts. Lose host secret → re-enter/recover; no network custody |
| **systemd-creds `host+tpm2`** (explicit opt-in) | Needs local host secret and original TPM; bare-metal disk-only theft gets a stronger boundary | Hardware reset/move or PCR policy change may lock credentials. Does not stop authorized runtime/root; keep independent operator recovery if continuity matters |
| **macOS Keychain / desktop safeStorage** | Local OS key wrapping; launch-cached data keys avoid per-command prompts | Locked/missing Keychain or code-signing changes can require unlock; never plaintext `basic_text`. Headless sharing requires compatible local adapter |
| **age, multiple recipients** (deferred optional recovery export) | Independent offline recipients can each recover; no boot dependency | Every recipient can decrypt, not threshold escrow. Extra ciphertext/key copies and revocation/retention burden; no freshness guarantee |

The [systemd-creds manual](https://www.freedesktop.org/software/systemd/man/latest/systemd-creds.html)
and [credential contract](https://systemd.io/CREDENTIALS/) describe host/TPM
modes, activation-time files and default `auto` selection. Explicitly select
`host` or opted-in `host+tpm2`; forbid `null` and `auto-initrd` confidentiality
fallbacks. A **cloud vTPM is software state controlled by the hypervisor**.
It may impede an attacker with only a guest disk copy and no vTPM state. It
does not protect against the provider reading guest memory, controlling the
vTPM, or restoring/cloning disk plus vTPM. It is not owner-controlled key custody
or protection against a malicious provider. TPM binding is an explicit opt-in
for owner-held bare metal, never the cloud default; cloud opt-in must retain
independent operator-held recovery or explicit acceptance of credential re-entry
on loss, never a sole continuity key.

Do not pass an ordinary `LoadCredential=` file to today's file-key adapter:
it enforces own uid and no group/other access (`H:secrets/file-key.ts:243-261`),
while manager-owned/ACL-backed credential files need a distinct narrowly trusted
adapter. Validate the manager-provided directory/fd and deployment provenance;
do not relax checks for arbitrary `VOLLI_SECRET_KEY_FILE` paths. Never copy the
runtime plaintext key back to disk to satisfy the existing adapter.

**Service activation must also survive key loss.** Required
`LoadCredentialEncrypted=` decryption happens before hostd executes; catching
an application exception cannot save that boot. The optional systemd backend
must use a bounded local provisioning helper that attempts unwrap and publishes
a runtime key (or non-secret unavailable status), without making hostd depend on helper
success. Deliver that result via a credential source that can return empty on
unwrap failure; the dedicated adapter treats empty as unavailable, never a key.
The helper must not print key bytes, leave stale keys after failure or require
cloud services. Prove real-unit startup on a TPM reset and missing host secret
before shipping; if this fail-soft delivery cannot be made reliable, keep the
host-file default and do not ship the systemd backend. No unit failure hidden
behind a claim that “hostd boots degraded.”

### Lost-key state machine (required, changes today's behavior)

Today hostd converts any bad key/store into `HostdBootError`
(`apps/hostd/src/secrets.ts:39-61`). Replace that with credential status:
`ready`, `locked/unavailable`, `corrupt`, or `empty`. All three non-ready cases
boot the host's work surfaces; corruption is not silently recast as empty.

- Missing/wrong key, TPM reset, VM rebuild/move, unavailable Keychain, unknown
  backend and malformed/inaccessible key leave ciphertext byte-identical.
  Report “Sign in again” / “Re-enter key,” with optional unlock/recovery action.
  Metadata unavailable inside locked ciphertext must not be guessed; services
  know their configured provider/server ids and can show unavailable generically.
- No network/model/MCP credential consumer receives bytes from locked storage.
  Model execution needing auth waits/fails with auth status, search is omitted,
  MCP needs sign-in, remote device authentication/pairing fails closed. Existing
  authenticated connections must be drained/revalidated when key loss is detected.
- Local status, board/Session history and local-admin recovery still work. Do
  not make a missing device/host private key a prerequisite for the local work
  service. Remote authenticated service may remain unavailable. Never disable
  authentication or trust a raw `hostId` to make remote access appear healthy.
- New persistent saves are refused until explicit unlock or reset. Reset moves
  unreadable ciphertext aside under the lock, confirms loss of all affected
  credential kinds, creates a new key/inventory, and requires sign-in/re-entry.
  Archive is excluded from backups and subject to owner cleanup, not destroyed
  automatically. Session-only execution must retain the redaction fail-closed
  boundary; no new process may emit unknown held credentials.

Test with a real temp DB populated with board/Session history and sentinel
credentials: remove key, substitute key, reset TPM simulation, rebuild VM
backend, restore disk on a different backend, lock Keychain, corrupt ciphertext.
Assert hostd reaches ready-for-local-work, history/rows unchanged (apart from
ordinary boot migrations), no credential use/leak, status actionable, no sealed
file overwrite/new key without reset, and re-entry restores service. Add actual
Linux systemd-unit fault tests before the optional backend ships, not just mocked port
exceptions. Lost-key boot is a required CI path before the migration ships.

### Optional operator recovery with age (deferred)

**Owner decision: deferred; re-enter credentials for now.** The following keeps
the future recovery boundary explicit, not a first-cut implementation dependency.
If revisited, use a **separate opt-in credential recovery export**, never embed
a recoverable key in ordinary Volli bundles. Export a versioned typed snapshot
(or key plus matching ciphertext) to operator-supplied age recipients; multiple
recipients each independently decrypt ([age documentation](https://github.com/FiloSottile/age#multiple-recipients)).
Store only public recipients on the host; private identities remain offline/on
operator machines. No plaintext temp or stdout/log spill. Export is an explicit
credential-bearing artifact, labelled with generation/time and excluded from
ordinary backup/replication; stale export means stale/revoked credentials.

On restore, decrypt through an operator-only bounded local path, validate, and
re-seal to the new host's local key. Per [host identity](host-identity.md), a
restored host is **new**: recover reusable provider/MCP/Session credentials only,
not old host identity/private authority keys, device/worker registrations,
operator verifiers, pairing approvals or active attachment tokens. Pair and
register again under the workspace's normal authority fence. Recovery must
not promote a workspace or resurrect revocation. Recipient removal requires a
new export; old exports stay decryptable and must be retired separately.
Without recovery, sign in again; work and boot are unaffected.

## 8. Alternatives and threat boundary

Sealed boxes address anonymous senders encrypting to a recipient's public key,
not a service that must both encrypt and decrypt its own inventory
([libsodium](https://doc.libsodium.org/public-key_cryptography/sealed_boxes)).
The host would still hold the private key and need the same custody, lock,
rotation and recovery discipline. Anyone with the public key can create a box;
it supplies no sender authorization. It buys nothing over authenticated
symmetric storage here. Age is the deferred alternative for multi-recipient
recovery; systemd/Keychain wrap keys, not competing per-credential inventories.

| Threat / failure | Protection promised | Not promised |
|---|---|---|
| Copied DB / migration copy after cleanup | No application credential records or residual sentinel bytes in newly verified copies | Erasure of old external copies, SSD blocks, snapshots or user-owned Pi/browser stores |
| Copied sealed file without key | AEAD confidentiality and tamper detection | Anti-rollback: older valid ciphertext is still valid; authority revocations/fences must be checked separately |
| Copy includes default key or systemd host secret | Permission boundary only | Cryptographic separation from a whole-machine copy |
| Other unprivileged uid | Private dirs/files, narrowly trusted key backend | Root, same service uid or commands already authorized to receive values |
| Cloud provider / hypervisor | No provider API key-custody dependency | Protection of running guest memory or independent physical TPM trust |
| Concurrent cooperating processes / crash | Kernel lock, reload/merge, durable rename, key-id recovery | Protection from non-cooperating old/malicious writers or unsupported filesystem semantics |
| Lost key / backend | Local boot and work intact, re-entry or optional recovery | Recovery of credentials without any usable key/export; remote auth continuity |
| Agent exfiltration / output | Existing dedicated submission, scoped use and redaction extended to observed values | Same-uid sandboxing, erasing spawned environments, or encoded-value exfiltration |

## 9. Proposed implementation tickets

Sizes are engineering scope, not delivery dates. Each is one reviewable PR;
allocate display ids in follow-up implementation tickets. This docs PR opens
no implementation tickets and applies no code or migration.

**First fix:** hostd currently turns a bad key/store into `HostdBootError`
(`apps/hostd/src/secrets.ts:39-61`), violating “losing the key never bricks a
host.” Lost-key degradation uses the existing store/key port and must not wait
for the typed module, a migration or optional backend. The typed module follows
and preserves that tested boot path; both lead the credential cutovers.

| Ticket | Size | Depends on / done gate |
|---|---|---|
| Lost-key degradation and dedicated status/re-entry — first | M | Approved design + existing store/key port; fix hostd boot refusal first; real boot/history tests and desktop locked-Keychain path; no remote fail-open |
| Typed sealed module, lock and key-id format | L | Lost-key degradation; Linux/macOS multi-process merge, revocation, durable file/crash tests; legacy readers and fail-soft boot retained |
| Web expansion E and reconciliation | M | Above + **VC-628 merged**; real-profile copy proof, N-1 writes/deletes/backup restore; floor unchanged |
| Web switch S and import coordinator | L | E deployed; explicit runner preconditions/batch boundaries; receipt/crash tests, floor S, N-1 byte-identical refusal |
| MCP + persistent Session imports | M | Coordinator + floor gate; final locked import, no post-switch legacy writes, endpoint/revision tests |
| Sealed Pi CredentialStore / explicit import | M | Typed module + coordinator + floor gate; Pi refresh concurrency, no auth.json writes, independent CLI sign-in documented |
| Contract C / DB residual cleanup | L | S verified, imports handled + VC-628; real-profile fenced compaction, sentinel scan, new credential-free recovery point |
| Safety-family purge | M | Approved purge policy, C success + VC-628; tested credential-free recovery point, owner-approved exact inventory, partial/crash retry; no sole recovery point deleted |
| Key rotation across local backends | M | Typed module; two-process cached-key and every-boundary crash tests; K1 retained through K2 commit |
| systemd-creds adapter / fail-soft delivery (optional) | M | Lost-key path + rotation; only with real Linux fail-soft unit/TPM fault tests; file backend is M2 default, TPM explicit bare-metal opt-in |
| age credential recovery export/import (deferred) | M, later | Not part of the first cut/M2; if revisited, typed module + rotation; no plaintext spill, new-host allowlist, stale-export warning |
| M2 pairing/device/host trust integration | M | Typed module + lost-key + S/C; VC-575 pairing contract, restore = new host, revoke/rotate tests; VC-623 authority boundary preserved |
| Personal browser credential boundary plan | S design first | Confirmed separate engine-owned vault plan; seam stays open for broader browser direction; ephemeral M2 agent profiles, no blanket “every credential sealed” claim |

Keep credential migration independent of VC-588's future DB split, but classify
its metadata as host-local, rebuildable and excluded now. Keep backups/replicas
credential-free at every later file boundary. Before enabling M2, test one
composition of model, web, MCP and pairing consumers with the key missing.

## Decided (owner, 2026-10-04)

**Hard requirements:** centralize application credentials and migrate web keys;
no provider key custody; lost key never bricks the host; TPM opt-in/off by
default in cloud; recovery optional. These are not reopened for convenience.

1. **Existing safety families: purge.** Delete only stale, complete families
   after verified C and a tested credential-free recovery point, including
   pre-S, pre-C and evidence copies. The owner approves the exact inventory
   at that point; no deletion is performed or implicitly approved by this PR.
2. **systemd-creds: file backend is the M2 default.** An optional `host` adapter
   comes only with real fail-soft unit tests. `host+tpm2` stays explicit opt-in
   for bare metal, never the cloud default.
3. **Operator-held age recovery: deferred.** Re-entering credentials is enough
   for now; age is not a first-cut dependency or ordinary backup feature.
4. **Authority exceptions confirmed.** VC-623's root-controlled verifier stays
   separate. External user-owned Pi `auth.json` stays untouched and independent
   after an explicit import; neither becomes host-service authority inventory.
5. **Browser boundary confirmed.** A separate plan owns the engine's personal
   browser vault; M2 agent profiles stay ephemeral. Keep the plan's seam open
   for the owner's broader browser direction. No blanket “every credential
   sealed” claim until the plan is resolved.
6. **S's downgrade fence and rollout gate approved.** Raise the floor at the
   read/write switch, not table drop; retain supported E boot while a credential
   precondition is pending. This does not permit reintroducing plaintext.

**Sequencing (orchestrator):** lost-key degradation is the first implementation
fix, using today's store/key port to remove hostd's boot refusal. The typed
module follows; DB migration/cleanup follows VC-628. Optional backends and
deferred age recovery never delay the “never brick” fix.
