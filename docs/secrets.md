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
receiving that scope's value. A running process already has its environment;
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
An existing persistent inventory must unlock for injection and redaction, even
when a newly requested credential would be Session-only.
The file and its temporary siblings are excluded from Volli backups. A headless
host seals the same file with a key file instead; see
[Headless hosts](#headless-hosts).

This selects ticket option **(b)**: encrypted storage with a launch-cached
keychain key. Signed release builds should normally avoid prompts; unsigned/dev
builds can prompt when the key is first wrapped/unwrapped. Session storage
remains the no-keychain choice. The research document named in the ticket is
not present on the base commit (`f960412c`); the VC-470 store comments document
the earlier prompt problem.

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
  `chmod` runs). Nothing reads
  the file until stored secrets exist, and it is read once per process.
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
  store, and refuses to start, naming the fix, rather than waiting for the
  first Session to need a secret.
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
  file is missing, or is a different key, opening, saving, injecting and
  redacting are all refused, with a message that says to put the key back or
  delete `session-secrets.enc` and enter the secrets again. Nothing is written
  over the sealed file, and no new key is made.
- **The envelope.** `VSF1 | key id | iv | tag | ciphertext`, AES-256-GCM with
  the header as associated data. The key id is a truncated, labelled SHA-256
  of the key. It tells a wrong key apart from a corrupt file and reveals
  nothing usable about the key. A `VSC1` (keychain) store is refused as sealed
  by another adapter. The keychain adapter answers a `VSF1` store with its
  usual "Could not decrypt secret storage."

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
`session-secrets.enc*`, `session-secrets.key*`, `mcp-credentials.json*` and
the `secrets` and `legacy_safe_storage_secrets` tables (`backup/decisions.ts`),
and Pi's `auth.json` lives outside the profile. A bundle made on a Mac therefore
restores onto a headless host, or the other way around, exactly as it restores
onto the machine that made it. Nothing undecryptable is written, and the
restore never fails over credentials. A restore also leaves the target
profile's own credential files where they are, because they are not entries
the profile swap moves. Its report carries `credentials`: `carried: false`, the
kinds to enter again (Session secrets, MCP server values and sign-ins, web
search keys, model provider sign-ins), and one sentence a restore surface can
show.

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
keychain ciphertext captured before the port existed. UI tests exercise uncontrolled passwords,
immediate clearing, trusted titles, labelled prose, and dedicated IPC only.
