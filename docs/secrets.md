# Session secrets (VC-481)

A new structured root Session holds `request_secret({ name, purpose? })`. An
agent supplies a variable **name**, never a value or storage scope. Volli asks
the person in a dedicated credential card above the composer, outside the
transcript. Its title and controls are product code; the only agent prose is
labelled **The agent says**. The password is an uncontrolled DOM input, cleared
before a dedicated, main-frame-only IPC submission. Neither chat drafts nor
Session interaction answers carry it. There is no submission CLI or verb.

The result is only **signed in**, **declined**, or **still missing**. Refer to
`$STRIPE_API_KEY` (for example) in `execute` or `shell_start`. The name cannot
change PATH, shell startup, loader settings, or Volli identity. Older frozen
Sessions keep their existing tool arrays; start a new Session to request a
secret. Subagents cannot request credentials and do not inherit root secrets.
Every structured Session receives the launch's output redaction filter, including
subagents and older Sessions without `request_secret`; filtering grants neither
the tool nor environment injection.

## Storage and revocation

The person chooses:

- **Session** (default): memory only, until its executor attachment closes or app exit.
  A done signal does not close a live attachment or break a later turn's injection.
- **Project**: reused by new structured root Sessions in this project.
- **Always**: reused by new structured root Sessions across projects.

More local scopes override broader scopes with the same variable name. Stored
values are injected at the next command or background-shell start, including
commands in the requesting Session without reattachment.

**Settings → Configure → Secrets** lists names, scope, and last use, with
write-only replacement and revocation. Availability checks do not mark use; only
subprocess injection updates last use. Revocation stops *future spawns* from
receiving that scope's value, in every process sharing the profile (desktop,
hostd, `volli-hostd credentials`): each injection reads the sealed file again
under the credential lock (VC-642). Nothing waits for that lock on Electron's
main thread: a command started while another Volli process holds it fails at
once with "busy, try again", and Settings waits for it asynchronously, briefly,
then shows the secrets as busy rather than missing. The window between that
read and the process starting is accepted (see the typed module below). A
running process already has its environment;
stop its background shell to retire that copy. Historical values remain in the
launch's redaction set after replacement/revocation so old output stays scrubbed.

Persistent scopes use `session-secrets.enc` beside the profile database: an
atomic, fsynced, mode-0600 file containing authenticated AES-256-GCM ciphertext.
The store (`SecretStore`, `@volli/host-core/secrets`) seals it through a
**secret-key port** (`SecretKeyPort`) the host supplies. On desktop, a random
data key is wrapped by Electron `safeStorage`, and unwrapped **once
per launch, lazily when stored secrets exist**. Subsequent writes use the cached
key. No keychain access at empty-profile startup or for Session-only values.
There is no plaintext fallback, including Electron's Linux `basic_text` backend.
An unavailable keychain or corrupt store fails closed and is never overwritten.
The file and its temporary siblings are excluded from Volli backups. A headless
host seals the same file with a key file instead; see
[Headless hosts](#headless-hosts).

### Locked credentials (VC-641)

A lost or damaged key never stops a host. The store settles one **credential
status** the first time it is asked (`secrets/credential-state.ts`):

| Status | When | Stored secrets | Saves |
|---|---|---|---|
| `ready` | the sealed file opened | used | allowed |
| `empty` | no sealed file yet, or after a reset | none | allowed |
| `locked` | key missing, wrong, malformed, or unreadable by its owner (e.g. mode 0000); keychain locked, denied or unavailable; store sealed by the other adapter (`VSC1` on a headless host, `VSF1` on desktop); sealed file unreadable; written by a newer Volli (`newer-format`); the credential lock file unusable (`lock-unusable`: a symlink, not a file, another user's); another Volli process holding the lock at that instant (`busy`, for that read only) | not used | refused |
| `refused` | key file unsafe: group/other access (including 0044, which denies its owner), another owner (told from its metadata when the open itself is denied), not a regular file; relative `VOLLI_SECRET_KEY_FILE` | not used; the key is never read for use | refused |
| `corrupt` | the key opened and the file does not authenticate or parse | not used | refused |

The key is checked before the store is looked for, so a malformed or unsafe
key reports `locked` or `refused` even with nothing sealed yet: saves would be
refused either way. Only `ready` and `empty` are usable; the other three leave
the sealed file byte-identical and make no key. Reads fail soft: listing, availability,
injection and redaction carry on with the Session-scoped values in memory, so
Sessions, the board and everything else keep working, and a request for a
missing secret can still be answered with **Session** storage. What a locked
store holds was never decrypted this launch, so no process can have it, and the
redaction boundary stays whole. The status is remembered: a locked keychain is
asked once per unlock, not by every read.

A key lost while the host runs is noticed by the next read, not the next
launch (VC-642): every read of the sealed file happens under the credential
lock, and the headless key file is read again first. A removed key locks
stored secrets (`missing`), a replaced one too (`wrong-key`); the file stays
byte-identical, values already seen stay in the redaction set, and putting the
key back and unlocking opens them again. A keychain is not asked again while
the launch runs, since asking may prompt. A sealed file whose `version` is
newer than this build's is `locked` (`newer-format`) and left alone.

Only material sealed under this key is gated: today, persistent Session
secrets. Model sign-ins (Pi `auth.json`) and MCP credentials are not under
this key yet and keep working. Web search keys have only a sealed *mirror*
([step E](#web-search-keys-step-e-vc-643)): a locked or corrupt inventory
leaves the mirror pending, and the keys keep working from the database. The
typed store (VC-631) adds the other kinds as each one moves in.

Two ways out, both a person's or local admin's intent, never an agent verb:

- **Unlock**: put the key back, unlock the keychain or fix the mode, then try
  again (desktop: **Try again** in Settings → Configure → Secrets; hostd:
  restart).
- **Reset** (`locked` or `corrupt` only, and never for `busy` or
  `lock-unusable`, where the store itself may be fine: wait and try again, or
  move the lock file aside): the sealed file is moved aside to
  `session-secrets.enc.locked-<time>-<random>` beside it, and the store starts
  empty for the secrets to be entered again (desktop: **Reset…**, confirmed;
  hostd: `volli-hostd credentials reset --yes`, with hostd stopped). The move
  is not atomic. What it guarantees: it never overwrites (the new name is a
  hard link that fails rather than replace), never deletes, and syncs the
  directory before it removes the old name, so a crash leaves the bytes under
  one name or both. A directory that cannot be synced is reported, not hidden.
  The archive is excluded from backups by the same `session-secrets.enc*` rule
  and stays until a person deletes it; moving it back undoes the reset. A
  `refused` key configuration is not reset: fix it, since the store it refuses
  may be perfectly good.

This selects ticket option **(b)**: encrypted storage with a launch-cached
keychain key. Signed release builds should normally avoid prompts; unsigned/dev
builds can prompt when the key is first wrapped/unwrapped. Session storage
remains the no-keychain choice. The research document named in the ticket is
not present on the base commit (`f960412c`); the VC-470 store comments document
the earlier prompt problem.

## The typed credential module (VC-642)

`@volli/host-core/secrets` holds the one module every application credential
family moves onto ([design](plans/sealed-credential-store.md) §3, §6, §7).
No family is canonical in its typed inventory yet: each moves in with its own
ticket and compatibility gate (web keys VC-643/644, MCP and persistent Session
imports VC-645, Pi VC-646, rotation VC-649). The web search keys are mirrored
there now ([step E](#web-search-keys-step-e-vc-643)), with the database still
their source. Persistent Session secrets already
run on its lock and durable file engine, in their own file and format: the same
`session-secrets.enc`, envelope (`VSF1`/`VSC1`) and `{ version: 1, secrets }`
payload, so the release before this one opens, uses and writes everything this
one writes (`n1-compatibility.test.ts`, against main's exact code).

- **The lock** (`credential-lock.ts`). `host-credentials.lock` beside the
  database: an empty 0600 file that desktop, hostd and `volli-hostd
  credentials` lock before every read-for-use and every change. It is SQLite's
  own file lock (`BEGIN EXCLUSIVE` on a connection that never writes, released
  by `ROLLBACK`), the mechanism the database open lock and hostd's instance
  lock already use, so it needs no new native module. On Linux and macOS that
  is a POSIX `fcntl` lock: the kernel drops it when its process dies (a crash
  never leaves a stale lock, and none is stolen by age or PID), it locks the
  inode (two spellings of one data directory meet at one lock), and a child
  process never inherits it. **Nothing ever waits for it synchronously**: a
  synchronous critical section (Electron's main thread runs them) tries once
  and refuses at once while another process holds it. A caller that can wait
  retries asynchronously between attempts (`retryWhileBusy`), never holding
  the lock across an await; an asynchronous holder queues in order and polls,
  up to 10 s. A busy read is `locked` with reason `busy` for that answer alone,
  never remembered, never "empty" and never a stale `ready`, and listing and
  status come from one read so they cannot disagree. Every acquisition checks
  that the pathname inode recorded before SQLite opened the file still matches
  the path after acquisition, and reconnects if it changed. This handles ordinary
  unlink/recreate, but does not identify the inode SQLite actually locked: an
  open-time pathname swap can evade it. The descriptor-derived check and its
  replacement-race test are tracked in VC-667. A lock file that is a symlink,
  not a regular file or another user's is `locked` (`lock-unusable`), with a sentence naming
  it and the fix (move it aside); it is never a reason to reset the
  credentials it guards. One of ours that holds junk is emptied in place. The
  lock is advisory: an older build that does not take it, or a hostile
  program running as the same user, is not stopped, so stop older processes
  before upgrading.

- **The durable file contract** (`durable-file.ts`, `sealed-document.ts`).
  Under the lock, every read reloads the file and opens it with the key its
  header names, so another process's revocation, and a key removed or
  replaced mid-run, are seen by the next read rather than the next launch.
  A change applies to what was just reloaded, never to a cached copy, so two
  processes' changes both survive. A write checks that the active file is
  still the bytes it opened (never sealing over a file it did not
  authenticate), writes a unique `O_EXCL` 0600 temporary, fsyncs it, renames
  it over the active name and fsyncs the directory. A crash leaves the old
  file or the new one, never a mixture; a crashed writer's temporary is swept
  by the next write. A directory that cannot be synced is reported; for the
  typed inventory it is an "indeterminate" error, read again before retrying.
- **Key ids and the envelope** (`credential-key-id.ts`, `sealed-envelope.ts`,
  port `ports/credential-keyring.ts`). `host-credentials.enc` is
  `VHC1 | backend | key id (16) | nonce (12) | tag (16) | ciphertext`,
  AES-256-GCM with the header as associated data. The key id is 128 bits of a
  labelled SHA-256 of the key, labelled differently from `VSF1`'s 64-bit id.
  A keyring resolves exactly the id a header names and refuses an id two
  keys claim; an unknown id is `locked`, never empty. A save never seals over
  a file under another key: changing keys is rotation, an explicit operation.
  The headless keyring (`fileCredentialKeyring`) reads the same key file as
  `fileSecretKey`. Desktop's keyring (`keychainCredentialKeyring`, VC-643)
  keeps a random data key wrapped by the keychain (`safeStorage`) in
  `host-credentials.key` (`VHK1 | wrapped key`), because the `VHC1` envelope
  has no room for one. It asks the keychain only to open a sealed file or to
  seal the first one, once per launch, and fails closed (`locked`) on an
  unavailable keychain, a refused unwrap or a missing wrapped file, and on
  Linux on a store that protects nothing (`basic_text`, a `safeStorage`
  without `getSelectedStorageBackend`, or a wrapping under Chromium's `v10`
  fallback key, a compiled-in constant); it never makes a new key while a
  sealed file exists.
- **The typed store's keychain API is the asynchronous one** (VC-643
  decision). Electron's synchronous `safeStorage` calls can block the thread
  that makes them to collect a keychain prompt, and on Electron's main thread
  no deadline or quit can interrupt that. So `host-credentials.key` is
  wrapped and unwrapped only with `isAsyncEncryptionAvailable`,
  `encryptStringAsync` and `decryptStringAsync`, from its first release: one
  API for that file, never the synchronous one. The keyring's `unlock()`
  fetches the key asynchronously, outside the credential lock, and can be
  abandoned (`AbortSignal`: no keychain call starts after the abort, and
  nothing fetched afterwards is kept); `resolve()` and `active()`, which run
  under the lock, answer from what it fetched and otherwise throw
  `CredentialKeyPendingError` (status `locked`/`key-pending`, transient,
  never remembered). VC-644 and every later desktop family keep this API.
  The shipped `VSC1` Session-secrets codec (`apps/desktop/src/main/secrets/codec.ts`)
  keeps the synchronous API and its envelope, unchanged.
- **The typed inventory** (`inventory.ts`, `credential-families.ts`). The
  plaintext is a schema version, a UUID, a commit generation and typed
  records, each with a UUID, a family, a fixed-field selector, a value, a
  revision (the generation of the commit that last wrote it) and a timestamp.
  A record removed and saved again gets a new UUID and a later revision, so
  neither ever repeats, and a caller commits against the record it read
  (`expect: { id, revision }`): a sign-out, or a sign-out then a new sign-in,
  beats a refresh that finishes late. It keeps
  VC-641's states; a newer schema is `locked` (`newer-format`) and never
  rewritten.

| Family | Selector | Value | Read by |
|---|---|---|---|
| `session-env` | scope (`project` or `always`), name, project | string | Session injection only |
| `web-search` | provider | string | `WebAccessSettings` |
| `mcp` | server id, endpoint | the whole MCP record (values, OAuth grant, registration) | MCP connection |
| `pi-provider` | provider | Pi's tagged `Credential`, provider fields kept | Pi's `CredentialStore` adapter |
| `host-private` | purpose | string | M2 pairing |
| `device-verifier` | host, workspace, device | string | device authentication |
| `worker-verifier` | host, workspace, worker | string | worker authentication |

Not families, by owner decision: VC-623's operator verifier (its integrity
is a root-owned file a service-writable store cannot give) and a user's own
Pi `auth.json`. No provider custody: every key is generated and kept on the
host. The new files are excluded from backups (`host-credentials.enc*`,
`host-credentials.key*`, `host-credentials.lock`), and structured file reads refuse
`host-credentials.*` and `session-secrets.key*` beside the older stores.

### Contention policy (VC-653)

Storage's synchronous methods are try-once primitives, not waiting doors. Do not
use a raw `status()` after a successful save as evidence that the save failed:
it is a *new read* that can meet the next writer. Use `statusAsync()` for an
explicit open/read that can wait.

| Operation | Lock wait | Bound / outcome |
| --- | --- | --- |
| `CredentialLock.withSync`, synchronous store/inventory reads and changes | None | Busy at once; never block Electron's main thread |
| Raw status/list/snapshot/availability polls, initial redaction | None | Momentary `locked`/`busy`; no stale records; not remembered |
| Store/inventory `statusAsync` | Async retries | 10 s by default (caller may specify a bound); then busy status |
| Session `execute` and background-shell injection (including last-use commit) | Async retries | 10 s; then busy error **before spawning**, never silently omit secrets for contention |
| `request_secret` availability | Try once, then async retries on busy | 10 s; then busy error, not a needless person prompt; cancellation stops retries |
| Person list/unlock/submit/replace/revoke/reset | Async retries | 10 s; listing/unlock return busy status, changes reject busy |
| Web-key mirror | Boot tries once, reconciliation retries asynchronously | 10 s; sealing stays pending, SQLite remains canonical |
| Hostd boot status / local-admin reset | None | Status/warning or refusal; not a Session-use read |

Session attachment registers injection ownership; it does not eagerly read
Session secrets. Both hosts read them fresh at each command start. The previous
injection path threw busy immediately, so the command failed before spawning;
it did **not** run without its stored secrets on contention. Genuine unavailable
keys retain the existing behavior (Session-scoped values remain usable).
Command and availability retries stop on cancellation, before any further
last-use commit or spawn. No retry holds the credential lock across a timer.
Low-level UI polls remain nonblocking so rendering and status observation never
stall on another process.
This does not make Electron's legacy synchronous `safeStorage` calls asynchronous.

## Web search keys: step E (VC-643)

The Brave and Exa keys are the first family in the typed inventory, as a
**mirror** ([plan](plans/sealed-credential-store.md) §4, "E"). The `secrets`
table in `volli.db` stays their one source of truth, in the clear: every read
(Settings, Session attach) still comes from it, and nothing ever reads the
mirror back. The read switch is VC-644.

- **Migration 059**, additive, floor unchanged (`raisesMinReader` off).
  `web_credential_source` holds a random lineage id and a revision that three
  triggers on `secrets` advance on every insert, update and delete, clears
  included, whichever build wrote. `web_credential_mirror` holds the receipt of
  the last verified mirror (lineage, revision, inventory id, generation). No
  timestamps decide anything, and no value, length or hash of a key is kept.
  Both tables are status, excluded from bundles and rebuilt on open.
- **Reconcile, never merge** (`web/credential-mirror.ts`). Under the credential
  lock, one short SQLite read takes every web key row and the revision; the
  inventory's `web-search` records become exactly those rows (a cleared key is
  dropped), with a receipt naming the source state; the file is fsynced, read
  back, opened and compared before the receipt row is written. Contents are
  compared, not only the revision, so a raw database copy that reaches the
  same revision with other keys still reseals. With no keys and no sealed file
  nothing is written and no key is made.
- **When it runs.** After first paint on every desktop launch (deletes
  included), and after every save or clear, which commit to SQLite first. One
  synchronous attempt at the lock; a busy lock, a key not fetched yet, or a
  source that changed while sealing is finished asynchronously, so Electron's
  main thread never waits on another process or the keychain. A copy sealed
  while the source moved on is reported `pending` (`moved`, naming the
  revision it sealed), never `sealed`.
- **No new unattended keychain access** (VC-643 decision). The launch
  reconcile runs with nobody at the keyboard, so it may fetch the keychain's
  key only if this launch has already used the keychain successfully (the
  Session-secrets store opened, or pre-023 web keys were carried out of it).
  Otherwise the mirror stays `pending` (`key-pending`) and the next save or
  clear a person makes fetches the key and seals it. Safe in step E: reads
  come only from SQLite, and VC-644's switch reconciles explicitly.
- **Stopped at quit.** When the accepted-quit coordinator accepts a quit
  (`quit-gate.ts`, `stopBackgroundWork`), the launch timer is cancelled, a
  busy retry stops, a key fetch in flight is abandoned rather than awaited,
  and no reconcile or keychain call starts afterwards. The SQLite snapshot
  and the commit stay synchronous under the credential lock.
- **Honest outcomes.** The Settings view carries `sealing`: `sealed` (a copy of
  exactly the saved keys was written and read back), `pending` ("saved;
  sealing pending": the keychain is locked, the lock was busy, a write or sync
  failed, or this host has no keyring) or `none`. A pending save is a save. The
  log says `held in the profile database (legacy mode, not encrypted)` with a
  reason code; nothing claims the keys are encrypted, and no value is logged.
- **Asked once per launch.** A keychain that refuses, or key material that is
  locked or corrupt, keeps sealing pending for the rest of that launch (the
  inventory remembers the failure, so the keychain is not asked again on
  every save); the next launch tries again. No key, no sealed file: `none`,
  without asking the keychain at all. A wrapped key this keychain will not
  open, with no sealed inventory beside it (a profile copied from another
  Mac), seals nothing, so it is moved aside (`host-credentials.key.unused-*`,
  never deleted) and a new key made. With a sealed inventory present it is
  never replaced. Settings shows none of this yet (owner decision: the label
  comes with VC-644); the view and the log carry it.
- **Older builds.** The release before this one opens a 059 database (floor
  58), and saves, clears, attaches, bundles and restores exactly as before;
  the triggers count its writes, and the next launch of this build reconciles
  them. A restored bundle never carries keys or step-E state: the restored
  database is a new lineage with no keys, so reconciliation empties the
  mirror and nothing stale is merged back. `web/n1-compatibility.test.ts` runs
  main's exact code (pinned by git blob id) for all of this.

Two windows stay open by decision ([plan](plans/sealed-credential-store.md) §6):
a revocation committed between reading a command's environment and starting
the command still reaches that one command (the next one is clean), and
restoring an older `session-secrets.enc` sealed under the same key brings
revoked Session secrets back, because the legacy payload has no generation or
tombstone. A later family (VC-644 or after) adds a generation check.

## Headless hosts

A host with no OS keychain (`apps/hostd`, VC-562) passes the **file-key
adapter**, `fileSecretKey({ path: secretKeyFilePath(dataDir) })`, from
`@volli/host-core/secrets`. Desktop keeps the keychain adapter
(`apps/desktop/src/main/secrets/codec.ts`), unchanged: same keychain item, same
`VSC1` envelope, and existing stores open as before.

- **Where the key is.** `<dataDir>/session-secrets.key`, or the absolute path
  in `VOLLI_SECRET_KEY_FILE` (a systemd credential, a mounted secret). A
  relative `VOLLI_SECRET_KEY_FILE` is refused.
- **What it is.** One line: 32 random bytes in base64. Volli creates it the
  first time a Project or Always secret is saved: written whole to a 0600
  temporary file, fsynced, then hard-linked into place. You may write one
  yourself (`(umask 077 && openssl rand -base64 32 > key)`: under the usual
  umask 022, `openssl ... > key` creates it readable by everyone before any
  `chmod` runs). Nothing needs
  the file until stored secrets exist; after that it is read again, under the
  credential lock, before each use of the store, so a key removed or replaced
  mid-run locks stored secrets at once.
- **Refusals, each naming its fix.** Like ssh with a private key, Volli refuses
  a key file that grants group or other users any access (`chmod 600 <path>`)
  or belongs to another user (`chown`). It also refuses a path that is not a
  regular file, a file that is not one base64 key line, and a key file it
  cannot read or create. On a filesystem that cannot make hard links (`link(2)`
  answering `EPERM` or `ENOSYS`, as some FUSE, s3fs and container volumes do)
  it says so (`no-hard-links`) and names the manual fallback: create the key
  yourself with `(umask 077 && openssl rand -base64 32 > key)`. Creation
  only runs when the file is absent. None of these messages quotes the key.
- **Checked at boot.** `volli-hostd` settles all of this before it serves
  anything: it inspects an existing key file and opens an existing sealed
  store, rather than waiting for the first Session to need a secret. A problem
  is never a boot refusal (VC-641): hostd serves with credentials `locked`,
  `refused` or `corrupt` in its status file and logs the fix
  ([Locked credentials](#locked-credentials-vc-641)).
- **Provisioning it for a service.** Install an admin-made key with
  `install -o <service-user> -m 600`, so it belongs to the user hostd runs as.
  A systemd `LoadCredential=` file is refused, and rightly: systemd owns it as
  root and grants the service user access through an ACL, and the key must
  belong to that user alone. Give the data directory `StateDirectoryMode=0700`:
  the adapter checks only the key file, so a directory other users could write
  would let them rename the key or the store away. hostd refuses a data
  directory another user owns or every user can write, and warns about a
  group-writable one.
  `apps/hostd/README.md` ("Running under systemd") has the unit.
- **Never re-keyed.** A key is only created to seal, and the store always opens
  what exists before it seals. So if `session-secrets.enc` exists and its key
  file is missing, or is a different key, stored secrets are locked: saving
  is refused with a message that says to put the key back or reset
  (`volli-hostd credentials reset`), and injection and redaction carry on
  without them. Nothing is written over the sealed file, and no new key is
  made.
- **The envelope.** `VSF1 | key id | iv | tag | ciphertext`, AES-256-GCM with
  the header as associated data. The key id is a truncated, labelled SHA-256
  of the key. It tells a wrong key apart from a corrupt file and reveals
  nothing usable about the key. Each adapter refuses the other's envelope as
  sealed by another adapter: credentials `locked` (`other-adapter`), the file
  untouched.

The operator token (VC-623) is not a Session secret and is not kept here: the
host stores only its verifier, in a root-owned file outside the data
directory, and the plaintext lives in the operator's own home
(`apps/hostd/README.md`, "Operators").

**Threat model.** The key file protects stored secrets from other users on the
machine: both files are 0600, and a key file that others can read is refused.
It also protects them from anyone holding a copy of the data directory without
the key. That includes a Volli backup bundle, which never carries either file,
and a disk snapshot or rsync of the data directory when `VOLLI_SECRET_KEY_FILE`
keeps the key elsewhere. It does not protect against root, or against the user
Volli runs as and anything running as that user, which includes every
Session's commands. Nor does it protect against anyone who can read both the
data directory and the key file. With the default path, a copy of the whole
data directory carries the key beside the ciphertext. That is the same bar as
Pi's `auth.json`, which already keeps model credentials in plain text under
the same user. If the data directory is copied anywhere less trusted than the
machine, keep the key outside it.

### Across machines and adapters

Credentials never travel in a backup, under any adapter. The bundle excludes
`session-secrets.enc*`, `session-secrets.key*`, `mcp-credentials.json*`, the
typed inventory and its key (`host-credentials.enc*`, `host-credentials.key*`)
and the `secrets`, `legacy_safe_storage_secrets`, `web_credential_source` and
`web_credential_mirror` tables (`backup/decisions.ts`),
and Pi's `auth.json` lives outside the profile. A bundle made on a Mac therefore
restores onto a headless host, or the other way around, exactly as it restores
onto the machine that made it. Nothing undecryptable is written, and the
restore never fails over credentials. A restore also leaves the target
profile's own credential files where they are, because they are not entries
the profile swap moves. Its report carries `credentials`: `carried: false`, the
kinds to enter again (Session secrets, MCP server values and sign-ins, web
search keys, model provider sign-ins), and one sentence a restore surface can
show.

Migration safety copies are different from bundles. Each `volli.db.backup-v<N>`
is a whole copy of the database, so it carries the `secrets` table and the web
search keys in it as plain text. Step E (VC-643) adds a sealed copy but keeps
the source in the database, so every copy made before the contract step still
holds them; moving them out of `volli.db` is VC-644 and its contract step.

Copying a data directory by hand is different. A keychain-sealed
`session-secrets.enc` carried onto a headless host is refused as sealed by the
macOS keychain, and the message says to delete it and enter the secrets again.
A web search key still waiting in `legacy_safe_storage_secrets` stays where it
is: only desktop's one-time keychain migration reads that table.

### Model provider sign-in on a headless host

Model credentials are not in the secret store. They are Pi's, in Pi's
`auth.json`, which `PiFileCredentialStore` reads and writes
(`packages/agent-runtime/src/pi/models.ts`, `piAuthFilePath`). A headless host
resolves it by the same rule as desktop and the `pi` CLI:
`$PI_CODING_AGENT_DIR/auth.json` when that variable is set, else
`~/.pi/agent/auth.json` in the home directory of the user the host runs as.
For a systemd service, that is the service user's `HOME`, or the
`PI_CODING_AGENT_DIR` its unit sets. The file is plain JSON, mode 0600, and
outside `dataDir`. A backup never carries it.

To sign in on the box today, use one of the manual paths:

1. **The `pi` CLI on the box.** Over SSH, as the host's user, with the same
   `PI_CODING_AGENT_DIR` if the unit sets one, install Pi
   (`npm install -g --ignore-scripts @earendil-works/pi-coding-agent`), run
   `pi`, and use `/login` for a subscription or an API key. The host reads the
   file the CLI writes; Pi's file lock is shared across processes.
2. **Copy the file from a machine that is signed in.** For example,
   `scp ~/.pi/agent/auth.json box:` on the Mac, then on the box
   `install -m 600 auth.json ~/.pi/agent/auth.json`. This shares one sign-in
   between two machines. A provider that rotates refresh tokens can sign one
   of them out at its next refresh, so prefer signing in on the box or using an
   API key.

A desktop-driven "Add a host" flow that forwards credentials from the Mac is
pending an owner decision and does not exist yet.

## What redaction promises

Exact occurrences become `‹secret:NAME›` in tool results and updates, errors,
read-back text, background-shell output (including the person's shell tail),
and saved MCP/Code Mode output. Matching numeric and boolean primitive
representations are scrubbed too, including structured data and details. Scrubbing precedes Pi activity, transcript and
sidecar persistence. Shell output spilling to a plaintext temp log is disabled
while the launch holds credential values. Images are withheld once values exist:
text substitution cannot scrub a credential rendered as pixels.

**Redaction is best effort, not an exfiltration sandbox.** Encoding a value,
splitting it across separate results, rendering it elsewhere, writing it to a
project file, or sending it over the network can escape exact-text matching.
Only give a project code a credential you trust it to use. Volli cannot erase
an environment already handed to a process.

Structured file reads hard-refuse credential-store paths regardless of the
Authority switch, including project `.env` and `.env.*` files, known auth files,
and symlink aliases to them. Templates under `.env.*` are refused too; keep
non-secret examples under another name. This makes a dedicated injection path
useful instead of telling the agent to read a `.env` file. **This read-tool guard
is not a kernel/shell boundary**: arbitrary programs in Full Access remain able
to open files as you. The general VC-45 containment described in the ticket is
not on this base and is not claimed here.

## Deferred

- MCP credentials/OAuth migration and a unified inventory. VC-470's existing
  person-owned store and Settings editor are unchanged. They can adopt the same
  encrypted store later through an explicit migration, not a surprise startup
  keychain prompt.
- Injection into named tool requests beyond the two shell execution doors.
- Terminal companions (Claude Code/Codex). Launch-time injection is technically
  possible, but their own model/transcript/output paths cannot be scrubbed by
  this structured-runtime boundary, so secrets are not injected there.
- Secret re-entry after a cancelled/restarted request. Waiting and settlement
  metadata now use the Engine's durable interactions and existing Attention and
  presentation paths, alongside ordinary question and permission cards. The dedicated person-only write
  channel is the only answer door; generic interaction answers are refused before
  persistence. Secret values never become ledger facts.

## Verification

`apps/desktop/src/main/secrets/integration.test.ts` runs the real Pi adapter,
Session Runtime and SQLite ledger with a scripted provider. A dedicated IPC
submission enables a command and background shell, echo/read results are
scrubbed, and a sentinel is absent from transcript, ledger/events, captured
logs, provider requests, sidecars, and IPC results. Runtime tests also cover
long saved output and shell spilling, schema/prefill refusal, and cancellation.
Store tests (`packages/host-core/src/secrets/store.test.ts`) exercise
authenticated ciphertext, scope, revocation, file modes, symlinks, and
sanitized failures. `file-key.test.ts` beside them runs the headless adapter
through the real store in CI's Linux host lane. It covers the round trip,
permission and owner refusals, a missing, different or keychain-sealed key,
and the create race. `apps/desktop/src/main/secrets/codec.test.ts` opens
keychain ciphertext captured before the port existed. VC-642 adds real
multi-process tests with child `node` processes (`store-processes.test.ts`,
`credential-lock.test.ts`, `inventory.test.ts`): concurrent saves and
last-use commits merge with none lost, a revocation in one process is not
injected by the next command in another, a writer killed at each write step
leaves the old file or the new one, the lock is released by a killed holder
and not kept by its children, and a key removed or replaced mid-run locks
stored secrets at the next read. `n1-compatibility.test.ts` and
`codec.test.ts` run main's exact store, codec and key adapter (pinned by git
blob id) against this build's files in both directions. They run on macOS
locally and in CI's Linux host lane. UI tests exercise uncontrolled passwords,
immediate clearing, trusted titles, labelled prose, and dedicated IPC only.
