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
A random data key is wrapped by Electron `safeStorage`, and unwrapped **once
per launch, lazily when stored secrets exist**. Subsequent writes use the cached
key. No keychain access at empty-profile startup or for Session-only values.
There is no plaintext fallback, including Electron's Linux `basic_text` backend.
An unavailable keychain or corrupt store fails closed and is never overwritten.
An existing persistent inventory must unlock for injection and redaction, even
when a newly requested credential would be Session-only.
The file and its temporary siblings are excluded from Volli backups.

This selects ticket option **(b)**: encrypted storage with a launch-cached
keychain key. Signed release builds should normally avoid prompts; unsigned/dev
builds can prompt when the key is first wrapped/unwrapped. Session storage
remains the no-keychain choice. The research document named in the ticket is
not present on the base commit (`f960412c`); the VC-470 store comments document
the earlier prompt problem.

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
Store tests exercise authenticated ciphertext, scope, revocation, file modes,
symlinks, and sanitized failures. UI tests exercise uncontrolled passwords,
immediate clearing, trusted titles, labelled prose, and dedicated IPC only.
