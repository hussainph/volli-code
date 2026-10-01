# MCP servers in Volli

Volli can connect a Session to Model Context Protocol servers. A server's tools
become ordinary tools in that Session's tool array, alongside `read`, `execute`
and Volli's own verbs.

This document covers how servers are configured, who may configure them, what
the warnings mean, how sign-in and credentials work, and how to recover when an
install goes wrong. The client, the transports, the tool-name safety rules and
the frozen tool surface were built in VC-8; the agent-facing management verbs in
VC-380; sign-in, credentials and the move to the `@earendil-works/pi-mcp`
client in VC-470.

## The one rule everything else follows

**A Session's tool list is frozen when the Session is created.**

It is resolved once, at birth, and written into a durable `tool-surface` record.
Reattaching a Session replays that exact record or fails; it never re-derives
one. So:

- Installing a server, enabling it, or selecting more of its tools changes what
  the **next Session created** is handed. It changes nothing about any Session
  that already exists, including the one that made the call.
- Disabling a server or deselecting a tool likewise cannot take a tool away from
  a Session that already has it.
- **Deleting** a server is the exception, and it is destructive in a way the
  others are not. A Session born holding one of its tools needs that server's
  transport in order to reattach. With the configuration gone, reattachment
  **fails**. See [Recovering](#recovering-from-a-failed-or-regretted-change).

Every verb's result repeats the relevant half of this, because a model that has
just installed a server will otherwise try to call its tools in the same turn.

## Configuring a server by hand

**Settings → Configure → MCP Servers.** A table gives each server stable columns:
**Server**, **Tools**, **Status**, **Enabled**, and actions. Narrow windows scroll
the table sideways rather than wrapping its controls. The tools count opens the
picker; the server name opens its details. A blocked server offers one fix
(*Sign in*, *Add credential*, *Retry*). Detailed errors, refresh age and provenance
live in the dialog. A switch turns the server off without forgetting it, and a
menu holds the rest: tools, connection, refresh, sign out and remove (which asks
first, because it deletes stored credentials).

Everything about one server opens as one dialog, with one *Save*:

- **Adding a server.** Choose *Remote* or *Local*, give the URL
  (or the executable and its arguments), and press *Connect* in the footer (or Enter).
  The optional name is suggested from the host or package. Headers, environment
  variables and custom OAuth client settings open only when needed. A server
  that wants sign-in or a credential says so, with its next action in the footer. Nothing is stored
  until discovery succeeds, and **discovered tools start off**: every tool is an
  explicit choice, and *Add server* saves only what you ticked.
- **Choosing tools.** Clicking the server name or its tools count opens its tools: a filter (name, title or
  description), *All · On · Off*, **Select all**, and — when the server labels
  its tools read-only — a **Read-only** group and a **Can make changes** group,
  each with its own checkbox, so every read can be turned on in one click and
  each write judged on its own. A checkbox for a group or for the whole list is
  checked, clear or mixed, and with a filter typed it acts on the listed tools
  only. A row shows the server's title for the tool beside its exact name, one
  line of description, and, opened, the whole description and the arguments it
  takes. A tool marked *Destructive* is one the server says can delete or
  overwrite. The labels are the server's own (`annotations.readOnlyHint`,
  `destructiveHint`, `title`): Volli shows them and sorts by them, and never
  trusts them for anything else. A tool whose definition Volli cannot offer is
  listed last with the reason and cannot be ticked. Saving a change to tools
  alone writes it without connecting.
- **Editing the connection.** *Edit* in the dialog opens the fields. Press
  *Connect*, review the tools, then *Save*. On the same endpoint, a tool still
  offered keeps its choice, and one that is gone is dropped. Changing endpoints
  starts every tool off again; the old catalog is hidden while editing. Tool
  choices apply to new Sessions only.

## The agent-facing verbs

Eight verbs, all **control tier**: tool-only, Role-gated, and absent from the
`volli` CLI and the agent socket entirely. There is no shell door for any of
them, by design — a same-uid process must not be able to install an MCP server.

| Verb | Wire name | What it does |
| --- | --- | --- |
| `mcp.list` | `server_list` | List configured servers, their tools, provenance, and recent management history. Connects to nothing. |
| `mcp.preview` | `server_preview` | Connect to a server you already have the configuration for, read its tools, save nothing. |
| `mcp.install` | `server_install` | Add or update a server. **Previews by default.** |
| `mcp.refresh` | `server_refresh` | Reconnect and re-read a configured server's catalog, keeping the selection. |
| `mcp.enable` | `server_enable` | Turn a configured server on for Sessions created from now on. |
| `mcp.disable` | `server_disable` | Turn it off, keeping the configuration. |
| `mcp.tools` | `server_tools` | Replace which of a server's tools are on. |
| `mcp.remove` | `server_remove` | Delete a server's configuration. **Previews by default.** |

An MCP server's own tools are **not** Volli verbs and are not in the Verb
Registry. They are dynamic, settings-backed definitions frozen into a Session by
id. These eight manage the servers; they are not the servers' tools.

The canonical verb keys remain `mcp.*`; the wire names above are separate. New
Board Sessions use the `server_*` wire names. Historical frozen Sessions retain
their original `mcp_*` names: their tool surface is replayed, never renamed.
Single-underscore `mcp_` names can route Anthropic subscription OAuth requests
to extra-usage billing and a misleading 400 ([controlled name-only reproduction](https://github.com/NousResearch/Hermes-Agent/issues/46675));
real dynamic tools named `mcp__server__tool` (double underscores) are unaffected.
After updating the app, start a fresh Board Session to get the new wire names.
On an old build, use a non-Anthropic model for Board work or use an Anthropic
Ticket Session instead.

### Who holds them

`ROLE_VERB_BUNDLES` in `packages/shared/src/agent-tool-surface.ts` is the one
place this is decided.

- **Board (`project`) Sessions** hold all eight. Configuring a project's MCP
  servers is a project-wide, durable act whose effect outlives the Session
  making it — which is what a Board Session is for.
- **Ticket Sessions** hold none by default. A Ticket Session is scoped to
  executing one ticket; rewriting the project's tool supply is the same
  category error as starting work on somebody else's ticket. One can receive a
  verb through an explicit durable grant recorded at birth.
- **Subagent Sessions** can never hold them. Their bundle is empty, a grant to
  one is refused outright, and they are not offered `ask_user` — so a subagent
  could not put an install warning in front of anybody even if it held the verb.

### Confirmation

Both destructive verbs confirm **twice**, and the two are independent.

1. **The plain call previews.** `server_install` and `server_remove` declare
   `previewsByDefault`, so calling either without `confirm: "apply"` reports the
   warning and exactly what would change, and writes nothing. For an install the
   preview also connects to **nothing** — a local MCP server is a process
   started as you, so "warned before anything runs" means before the process,
   not before the row is written. Use `server_preview` when you want to connect and
   look.
2. **The apply call asks a person, when there is one.** A second call carrying
   `confirm: "apply"` raises a `confirm.mcp-install` / `confirm.mcp-remove`
   question through the Session's own parked-question machinery. The person sees
   the warning and answers *Allow once* or *Reject*.

A Session running unattended has no port to ask through. It is not blocked: the
deliberate preview-then-apply pair is the confirmation, and the result says in
plain words that nobody was asked, rather than implying somebody was.

### Why the other six verbs do not confirm

`server_list`, `server_enable`, `server_disable`, `server_tools` and `server_refresh` act only
on a server **already in this project's configuration** — a transport somebody
has already confirmed through the gate above, or typed into Settings themselves.

`server_refresh` is the one worth being explicit about, because it *does* start that
server's process again. Re-running a command the project already holds lies
inside the authority the install established, and the rule is that no verb needs
a higher tier than the ambient authority its effect already lies within. A
confirmation there would train a caller to click through the two that matter.

The rule lives in one place in the code, `CONFIRMATION_RULE` in
`apps/desktop/src/main/mcp/verbs.ts`, rather than being decided verb by verb.

## What the warnings mean

They are different for the two transports because the hazards are genuinely
different. A single generic caution would tell you nothing you could act on.

### A local (stdio) server

> *Volli starts `npx -y @acme/files-mcp` and it runs on this machine as you,
> with your files, your credentials on disk and your network access, every time
> a Session calls one of its tools.*

The command runs as your user account. It is not sandboxed, not containerised,
and not restricted to the workspace. It can read anything you can read.

The one thing it does **not** get is Volli's secrets. `mcpLaunchEnvironment()`
in `apps/desktop/src/main/mcp/client.ts` hands a launched server a short fixed
allowlist — `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `TMPDIR` and the Windows
equivalents — and nothing else is inherited. No model provider key, no Volli
session token, no telemetry credential. The only additions are the environment
entries a **person** configured for that server in Settings (see
[Credentials and sign-in](#credentials-and-sign-in)).

### A remote (streamable HTTP) server

> *It receives whatever arguments its tools are given, including file contents,
> paths and anything a model puts in a tool call, and Volli cannot see what it
> does with them.*

The operator of that endpoint sees every argument of every call. Volli sends it
no credential of its own — only the headers a person configured for it, or the
OAuth token a person signed in for (see
[Credentials and sign-in](#credentials-and-sign-in)).

### The MCP verbs refuse a query string

`server_preview` and `server_install` **refuse** a URL that carries a query string,
before anything is connected:

> *That endpoint carries a query string, and the MCP verbs refuse one. Volli
> cannot tell a token from an ordinary parameter, so a query string would be
> stored in plain text and sent to the server as given.*

A query string is the last place in a URL a credential can sit once userinfo
(`user:pass@`) and fragments are already refused. Volli cannot tell `?token=…`
from `?version=2`, so it refuses the **shape** rather than guessing at the
meaning. The alternative is storing an unknown value in plain text — in the
project database and in every backup bundle — and calling that support. A
credential has a proper home now: a header, a stored secret or a sign-in, all of
them a person's to set.

This is the cost of the rule, stated plainly: **a server that needs a non-secret
query parameter cannot be installed by an agent.** The way through is
Settings → Configure → MCP Servers, where a person can see what they are typing
and chose it themselves. That path is unchanged from VC-8.

Where a stored server does carry a query string — because a person added it by
hand — Volli prints the **origin and path** and marks the rest
`(query string not shown)`, in previews, confirmations, `server_list` and durable
audit records. Those four surfaces travel further than the caller expects.

## Sources and provenance

**Volli never downloads anything.** "Install source" does not mean a package
manager. A local server is a command that must **already be on `PATH`**, usually
invoked through `npx` or `uvx`, and Volli simply starts it.

A local server always runs with its working directory set to the **project
root**. Other clients let a config choose one (VS Code has `cwd`); Volli does not
expose it, deliberately — the workspace is the boundary the rest of the product
is built on, and a server pointed elsewhere would quietly step outside it.

So a "source" here is **provenance metadata** — a note of where the
configuration came from and which version was asked for. `server_install` accepts
four optional fields, all of them recorded and none of them enforced:

| Field | Meaning |
| --- | --- |
| `source` | Where the configuration was read from: a registry entry, a URL, a document. |
| `registryType` | One of `npm`, `pypi`, `nuget`, `cargo`, `oci`, `mcpb` — the package types the MCP Registry documents **today**. The registry is preview software and may add more, so treat this as versioned vocabulary rather than a fixed part of MCP. |
| `version` | The version string this install **asked for**. Nothing pins the running command to it. |
| `digest` | A digest the source published, such as `mcpb`'s `fileSha256`. |

A pinned digest is **recorded, not enforced**. Verifying one requires downloading
the artefact, which Volli does not do; that work belongs to VC-379, which owns
package format support. `server_list` and the Configure pane both label provenance
"recorded, not verified" wherever they show it, because a version and a digest
displayed plainly read as a guarantee nobody made.

A server configured by hand has no provenance and shows none — an empty row of
em-dashes would be a control talking about nothing.

## Transports

Two, and only two: **stdio** and **streamable HTTP**. There is no SSE and no
WebSocket support.

SSE is deprecated in the MCP specification, but Claude Code and VS Code still
accept SSE endpoints and fall back to them, so **an SSE-only server that works in
those clients will not work here.** It is not refused with a clear message
either: an `https://` URL is accepted as streamable HTTP and then fails during
the handshake. If a server's documentation offers both, use its streamable HTTP
endpoint.

### The client and its protocol versions

Since VC-470 the client is `@earendil-works/pi-mcp` (MIT), which replaced the
official `@modelcontextprotocol/client` SDK. It opens with `initialize` at
protocol revision **`2025-11-25`** and accepts a server that answers
`2025-06-18`, `2025-03-26` or `2024-11-05`.

Two things the SDK negotiated are gone, and both are worth naming:

- **`2026-07-28`**, the stateless revision reached through `server/discover`.
  A server that speaks it *and* the earlier revisions (a "dual-era" server, which
  is what the official SDKs build by default) answers `initialize` and works as
  before. Modern-only discovery and calls remain **blocked on pi-mcp upstream**:
  the installed and latest published release, `0.99.2`, and upstream main still
  implement only the earlier handshake. Volli does not fork the client.
  Since VC-479, Volli names a refusal only from a structured
  `UnsupportedProtocolVersionError` (JSON-RPC code `-32022`) whose
  `data.supported` string array contains `2026-07-28` and none of the revisions
  pi-mcp accepts. Over HTTP this must be a JSON-RPC error body on **400**;
  over stdio it is the JSON-RPC error itself. A version mentioned only in an
  error's prose, an invalid body, or a compatible dual-era advertisement is not
  enough. Modern-only servers can also refuse `initialize` with other errors,
  so not every such server can be identified by this legacy client.
- **`2024-10-07`**, a pre-release revision no current server negotiates.

The eventual upstream implementation must follow the spec's transport-specific
compatibility rules: stdio probes `server/discover` and falls back to
`initialize` on non-modern errors or a probe timeout; HTTP attempts a modern
request and inspects a 400's JSON-RPC body before falling back. A recognized
modern version error selects a mutually supported revision rather than falling
back. These probes are **not implemented by pi-mcp yet**. Modern requests also
carry version and capabilities in `_meta` (and required HTTP metadata headers),
without protocol sessions; MRTR input requests and subscriptions replace the old
server-initiated requests and GET stream. See the
[revision changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog)
and [compatibility rules](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning).
The structural-detection change does not change frozen tool surfaces, tool names,
credential routing, per-request token reads, or these limits.

The bounds VC-8 set are kept: a 10-second limit on the handshake and on a
catalog read, a 30-second limit on a tool call, and at most 64 pages of
`tools/list` (a repeated cursor is refused). One message may be at most 8 MiB
plus framing on either transport — VC-469's outer bound on a tool result — on
stdio per line, and over HTTP per JSON response body (refused on its declared
length, or stopped mid-read) or per SSE event.

### Stopping a local server

A local server is started in its own process group. When a Session detaches,
the connection closes stdin, waits briefly, then sends SIGTERM and finally
SIGKILL to the **whole group** — so a server started through `npx` or `uvx`,
whose launcher keeps the real server as a child, leaves nothing behind. On app
quit every open connection is closed the same way after the Sessions have
closed, and if the process exits without closing one, the client's exit hook
SIGTERMs every group it started. Two gaps in the client are closed on Volli's
side: a server that had already exited leaves helpers in its group, and a group
member that ignores SIGTERM after the server has gone gets no SIGKILL. After
every close, whatever is still in the group gets SIGTERM, a two-second grace,
then SIGKILL. `stdio-lifecycle.test.ts` checks all of this with real processes,
`npx` included.

A message over the 8 MiB bound is refused at once with an error that says so,
rather than leaving the call to wait out its 30 seconds.

## Credentials and sign-in

Many real servers need a credential: an API key in a header, a token in an
environment variable, or an OAuth sign-in. Volli supports all three, under one
rule.

**Credentials are routed to the person.** An agent never supplies, sees or
stores a credential value. Only a person adds one, in **Settings → Configure →
MCP Servers**, and only a person signs in. When an agent's work needs one, the
agent raises a question that reaches the person; the person acts; the agent is
told the outcome — signed in, declined, or still missing — and never the value.

That promise holds **at the tool surface**: no verb, tool result, question or
record carries a value. It is not a sandbox. A Session with full access runs
its shell as you, and your user can read `mcp-credentials.json` (see below), so
such a Session's commands could read it too — exactly as they could read
`~/.pi/agent/auth.json` or any other file you can. A Scoped Session's commands
run behind Seatbelt with your home directory in `denyRead`, which covers the
file.

**Credentials only travel over https**, or over plain http to this machine. A
header, a bearer token or a sign-in sent in clear to another host is readable
by anyone on the path, so Settings refuses to save credentials for such an
endpoint (and says why), and Volli refuses to sign in to one.

### Signing in (OAuth)

A remote server without an `Authorization` header of its own can sign in with
OAuth. When such a server refuses a connection, its row in Settings shows
**Needs sign-in** with a *Sign in* control (a server that has never asked for one
shows none; *Sign in* in the server dialog appears when *Connect* is refused
for one). *Sign in* opens the server's
authorization page in your browser and waits (up to five minutes, or until you
press *Cancel sign-in*) for the browser to come back to a temporary server on
`127.0.0.1`. Volli:

- discovers the authorization server from the challenge the MCP server sent
  (protected-resource and authorization-server metadata);
- registers itself with it as *Volli Code* (dynamic client registration), or
  uses a **pre-registered client** you configured;
- uses PKCE (S256) for the authorization code, and refuses an authorization
  server whose metadata does not say it supports S256 — MCP requires the
  client to check;
- opens only an https authorization page (plain http only when the MCP server
  is itself on this machine);
- checks the `iss` the browser comes back with against the authorization
  server it started with (RFC 9207), whenever one is sent or the server says
  it always sends one — Sentry, Linear and GitHub all do;
- listens for the redirect on a port it chose itself, reusing that port for a
  client it registered, never one named by the authorization server;
- refreshes the access token by itself when the server rejects it, sharing one
  refresh between concurrent requests;
- signs in again for more scope when the server asks for it (`403
  insufficient_scope`): the row shows *Needs sign-in* again, and signing in
  requests what was granted plus what was asked for (step-up).

*Sign out* stops a sign-in still in progress, deletes the stored tokens and the
client registration, and asks the authorization server to revoke the tokens
when it advertises a revocation endpoint (best effort). Every request
Volli makes to an authorization server has a 10-second limit and a 1 MiB limit
on its answer, so one that stops answering fails a call rather than holding
every call to that server behind it.
One sign-in runs per server at a time: Settings and an agent's question join the
same one, an agent that stops waiting leaves it running for the person, and the
person's *Cancel sign-in* stops it for everyone.

**Pre-registered clients.** Under *Custom OAuth client* in the connection fields: a client ID, an
optional client secret (a stored secret or a `${NAME}` reference), and either a
callback port — the redirect is then `http://127.0.0.1:<port>/callback` — or a
whole loopback callback URL (`http://localhost:…`, `127.0.0.1` or `[::1]`) for a
client registered with a different redirect. *Scope* replaces the scopes the
server advertises.

**A running Session picks up a sign-in.** Tokens are read on every request, so
a Session already running uses a refreshed token, or the token from a sign-in
a person just completed, on its very next call, without being reattached. Its
frozen tool list does not change: signing in, like installing, affects which
tools are offered only to Sessions created afterwards. A Session signs in only
to the address it was started with: if the stored server has since been
pointed elsewhere, its sign-in question is answered "this server's address
changed since the Session started; review it in Settings" and neither address
is signed in to.

### Headers and environment values

In the connection fields, a remote server takes **Headers** and a local server takes
**Environment variables** entries. Each value is one of two kinds, and neither is stored
as plain text in configuration:

| Kind | What is stored in the project | Where the value comes from |
| --- | --- | --- |
| **Stored secret** | Only that a secret exists for this slot. | You type it once. It is kept in a file readable only by you (below), never shown back — the field reads *Stored* — and replaced by typing a new one. |
| **Environment variable** | The reference, e.g. `Bearer ${GITHUB_TOKEN}`. | Volli's own environment, read when the server connects. Literal text may surround `${NAME}` references; a value with no reference must be a secret. |

There is no third, literal kind. A plain value typed into configuration would be
stored in the project database and copied into every backup bundle, and Volli
cannot tell a key from an ordinary value any better than it can tell
`?token=…` from `?version=2`. A value that is not secret still works as a
*Secret*; it simply lives where a secret would.

Values are resolved **at connect time** — headers on every request — and go only
to the server they belong to: a header to that server's endpoint URL and nowhere
else (not to the authorization server it signs in with, and not across a
redirect to another origin), an environment value to that server's process. They are never logged, never put in an error
(an error names the slot, `header Authorization`, or the variable,
`${GITHUB_TOKEN}`, never the value), and a server's stderr is never surfaced.
Names may appear where an agent can read them; values never do.
A value stored or replaced while a Session runs reaches it too: headers on the
next request, and a local server's environment by restarting that Session's
connection to it before the next call.

A local server's environment values go to the command **as it resolves in the
project root** — and an agent working in that project can change what `npx foo`
or `node ./server.js` actually runs there (a `node_modules/.bin` entry, the
script itself). Give a local server a secret only if you trust what the project
can make that command run.

A reference reads **Volli's** environment. A Volli started from Finder or the
Dock has launchd's environment, not your shell's exports, so a variable your
`.zshrc` exports is usually not there; store it as a secret instead, or launch
Volli from a terminal.

**Why `!command` is refused.** Pi also accepts `!command` — a command whose
output is the value (`!op read …`, `!gh auth token`). Volli refuses it and
keeps the `!` prefix reserved. A remote server is otherwise something Volli
never starts a process for, and `!command` would turn an HTTP header into a
command run as you, travelling with the configuration into backup bundles and,
once VC-379 imports repository `mcp.json` files, arriving from a repository. The
use it serves — keeping the secret out of the configuration — is already served
by a stored secret, which runs nothing.

### Where credentials are kept

In `mcp-credentials.json` beside the profile database (`<userData>/` in the
app), mode `0600`: written whole to a fresh temporary file (created exclusively,
never through a symlink), flushed to disk, then renamed into place, so a power
cut leaves the old file or the new one. A symlink found at the path is never
read through. Not the macOS
keychain, for the reasons in
`docs/research/env-credential-ux-architecture-review.md`: keychain access raised
a prompt whenever the build's signature changed, and every peer (Pi's own
`mcp-auth.json`, opencode, Codex) uses a user-only file. It holds stored
secrets, OAuth tokens and client registrations — never a PKCE verifier, which
lives only in the memory of the sign-in that made it.

Credentials never reach the project database, a backup bundle (the file is
excluded by name), `mcp_operations`, a ticket comment, an audit record, a
question put to a person, or a transcript. Removing a server in Settings deletes
its stored credentials; re-adding it means storing them or signing in again.

### What an agent can and cannot do

- **No verb carries a credential.** `server_install`, `server_preview` and the rest
  have no header, environment or token field, and never will: a `${NAME}`
  reference written by an agent could send any variable in Volli's environment
  to an endpoint the agent chose.
- **An agent sees that credentials exist, not what they are.** `server_list` shows
  each slot's name and kind (`header Authorization (stored secret)`), whether one
  is missing, and the sign-in state — never a value, and not a reference's text.
- **A sign-in is asked for, not performed.** When `server_install` or
  `server_refresh` connects to a server that needs a sign-in, or a tool call in a
  Session is refused for one, Volli puts a `confirm.mcp-sign-in` question to the
  person driving through the Session's parked-question machinery — the same path
  as `confirm.mcp-install`. *Allow* opens the browser; the call is retried once
  the person has signed in, and the agent receives the call's result, or *The
  person driving declined to sign in*, or why the sign-in did not complete.
- **A missing or rejected key is asked for the same way.** `confirm.mcp-credential`
  names the slot (`header Authorization`); the person adds or replaces the value
  in Settings and allows the retry. If it is still missing, or still rejected,
    the agent is told that. Calls blocked on the same server at the same time share
  one question.
- **A "no" is remembered.** Once the person declines, every later call in that
  Session blocked on the same server for the same reason is answered "declined"
  at once, with no new question, until the person stores a value or signs in.
- **Each question names the endpoint** beside the server's name, because the
  name is the agent's choice and allowing a sign-in opens whatever page that
  endpoint's metadata names.
- **Nobody watching is not nobody to ask.** In a structured Session the question
  parks like any other, the Session reads as waiting on you, and an unattended
  Run's notification fires for it as for any parked question. Only a call with
  no question port at all — a verb reached without an attachment — gets the
  plain result that a person must sign in or add the value in Settings, and the
  server stays in *Needs sign-in*.
- **An agent cannot redirect a person's credential.** Re-installing an existing
  server with the same command or endpoint keeps the person's credential
  settings. Re-installing a server that holds any — configured headers,
  environment or OAuth settings, a stored secret, a sign-in — at a *different*
  endpoint or command is **refused**, before anything is asked or connected:
  carrying the credential along would send it where the agent chose, and
  dropping it would destroy a person's sign-in on an agent's say-so. Install it
  under a new id, or the person changes it in Settings. The configuration is
  read again after the person confirms the install, so a credential they add in
  Settings while the question is open is kept, not written over.
- **An agent cannot remove a person's credentials.** `server_remove` refuses a
  server that holds any (configured headers, environment or OAuth settings, a
  stored secret, a sign-in): removing it deletes them. A person removes it in
  Settings; an agent that only wants its tools out of new Sessions calls
  `server_disable`.
- `server_preview` never asks anyone: it reports that a sign-in is needed and that
  `server_install` will ask, and previews what `server_install` would refuse as a
  refusal.

## Recovering from a failed or regretted change

### A first-time install failed

Nothing was written. The project's configuration is exactly as it was, there is
no half-created row, and **retrying the same call immediately is safe**. The
result says so.

### An update to an existing server failed

The server keeps its **last working tool list** and is marked **stale**, with
the failure recorded against it. Nothing that worked has stopped working.
Sessions born before the failure are unaffected. Fix the cause, then call
`server_refresh` or install again; a success clears the stale marker.

### The install was cancelled, or it timed out

These are reported as two different outcomes, because the next move differs:

- **Cancelled** — the turn stopped waiting. Nothing partial was written. Retry
  when ready.
- **Timed out** — the server did not answer within the 10-second connection
  limit. Retrying unchanged will probably time out again; check that the command
  exists and starts, or that the endpoint is reachable.

### A server returned tools Volli cannot offer

Discovery checks every tool against fixed limits — name length, description
length, schema size, schema depth, node count, and a 128-tool ceiling — and a
tool that fails is kept in the catalog **marked unusable with the reason**,
rather than dropped. It cannot be selected. The rest of the server works
normally.

A tool's **output schema** is checked against the same schema limits, but a
failing one does not make the tool unusable: the schema is left off and the
tool works without it, and the main-process log says why. An output schema only
describes the structured half of a result (see
[What a call returns](#what-a-call-returns)); the model never sees it.

### You removed a server and older Sessions now fail to reattach

`serversForFrozenMcpTools` throws when a frozen tool's server is gone, so those
Sessions cannot reattach. **Re-add the server under the same id** — the removal's
audit record contains the transport needed to do it — and reattachment works
again.

To avoid this entirely, prefer **`server_disable`**. It keeps the configuration, so
existing Sessions still reattach, while Sessions created afterwards are not
offered the tools. That is what most callers actually mean.

## Where installs are recorded

Every install and removal — successful or failed — appends a row to
`mcp_operations`, a project-scoped, append-only table added in migration 050. It
records the request, the transport that was tried, the provenance, the outcome,
what to do if it failed, and which Session asked. It holds `server_id` as plain
text with **no foreign key**, deliberately: the record a person most needs is a
removal, and a row that cascaded away with the server it named would delete
exactly the evidence they came looking for.

**A person finds it in Settings → Configure → MCP Servers**, under *Recent
activity*, which lists the newest operations with what was asked, when, and
whether a Session or a person did it; an operation that recorded a detail — a
removal's transport line, a failure's recovery line — carries it behind
*Detail*. A failed first install writes no server row at all, so that list is
the only place its configuration and recovery line survive. `server_list` shows the same history to an agent.

The row's id is derived from the calling Session and the tool call that asked
(`${sessionId}:${toolCallId}`), not minted fresh per execution. A retried tool
call — an ordinary outcome when a response is lost — therefore lands as the one
act it was, rather than as two records of one install.

`server_list` prints the recent history beside the servers.

When the calling Session has a Ticket, the same facts are **also** written as a
ticket comment, because that is where someone doing the work will look. The
project row remains canonical: the Board Role holds these verbs, and a Board
Session has no Ticket to comment on.

## How calls reach a server

### One connection per Session, shared by its calls

Each Session attachment opens one connection per server, lazily, and every call
that Session makes to the server shares it. A call that is stopped, or that the
server answers with an error — including an HTTP 429 or 5xx — leaves that
connection in place for the others. The connection is replaced only when it has
failed: a closed pipe, a dropped socket, an HTTP 400 or 404 that ends the
protocol session, or a call that got no answer within its 30-second deadline.
Even then the old connection is closed only after the last call still running
on it finishes. Every connection is closed when the attachment closes.

### Every Session shares one bound per server

All Sessions share a single bound per configured server: at most **8 calls in
flight** and **32 call starts per second**. A call over the bound waits its turn
instead of failing, and stopping the turn withdraws it. A start counts against
the second until one second after its call *finishes*, not after it began: the
server has certainly seen the call by then, so no matter how the network
delays a request, the server never sees more than 32 in any second. Nothing a
server says about itself raises or lowers the bound, and no call is ever
retried.

Ordinary Sessions run one tool call at a time, so the bound only comes into
play when several Sessions call the same server at once. A call that waited a
second or more for it is logged in the main-process log, so a queued call is
not mistaken for a slow server. The bound belongs to one configured server: the
same endpoint configured in two projects is two servers with a bound each.

### Parallel reads (developer-only)

A model sometimes asks for several independent tool calls in one reply. Volli
runs them **one at a time**. An unpackaged development build can opt specific,
audited read tools into running at the same time, with no setting and no UI:

```sh
VOLLI_DEV_MCP_PARALLEL='{
  "reads": ["<serverId>:<toolName>"],
  "limits": { "<serverId>": { "maxConcurrent": 2, "maxStarts": 6, "windowMs": 100 } }
}' pnpm dev
```

- `reads` lists exact server id and tool name pairs that someone has checked are
  idempotent reads. A server's description of its own tool, its annotations and
  any `readOnlyHint` are never consulted.
- Sessions **created** while the variable is set are marked with that list, and
  the marks are frozen into the Session like the rest of its tools. A subagent
  Session inherits its parent's marks along with its tools. Every new root
  Session in that launch is marked the same way; there is no per-Session
  choice.
- When a Session attaches, each frozen mark is kept only if that exact tool is
  still in `reads`. Taking a tool off the list stops it running in parallel
  everywhere at the next launch. Adding a tool never marks a Session that was
  born without it.
- A reply runs in parallel only if **every** call in it is a marked read. Any
  other call in the same reply — a file edit, a shell command, a verb, a browser
  action, an unmarked MCP tool — makes the whole reply run one call at a time,
  in order.
- Approval happens for the whole reply before any call in it starts.
- `limits` replaces the shared bound for the named servers; set it to what the
  server can actually handle. `maxStarts` left out means no start-rate limit;
  `windowMs` defaults to one second.
- Relaunching without the variable turns parallel dispatch off for every
  Session, including ones created with marks. A packaged build ignores the
  variable entirely. A value that does not parse is logged at launch and
  ignored.

## How a server's tools reach the model (Code Mode, VC-471)

Without Code Mode, every selected MCP tool is declared to the model, and its
name, description and input schema are resent with every request. With Code
Mode on (**Settings → Models → Code Mode**, on by default), each tool of a new
Session is frozen with a **route** at birth (`packages/shared/src/code-mode.ts`):

| Route | Declared to the model | Callable from a `codemode` program | In the `codemode` description |
| --- | --- | --- | --- |
| `direct` | yes | no | no |
| `both` | yes | yes | named |
| `code` | no | yes | declared in TypeScript, under a token budget |
| `deferred` | no | yes | counted; found with `searchTools()` |

A server is **large** when it has more than 20 tools
(`LARGE_MCP_SERVER_TOOLS`) or its declarations are estimated past 3,000 tokens
(`LARGE_MCP_SERVER_TOKENS`, at four characters a token). A large server's tools
are routed `deferred` **whatever the model's mode**: a Session whose mode is
`off` still gets `codemode`, for its large servers alone, with every other tool
declared as before. Smaller servers follow the mode — `both` declares and lists
them, `only` routes each server's tools `code` as one group. Measured at 120
tools (o200k, `bench/codemode/prompt-cost.bench.test.ts`): 17,297 declaration
tokens declared directly against 2,217 deferred.

A nested call from a program reaches the server through the same
`RuntimeMcpPort`, the same per-server bound and the same trust notice as a
direct call; a program's output after any MCP call comes back inside
untrusted-content markers. Routes are frozen with the Session like the tool
definitions, so changing the setting, or a server growing past the threshold,
changes only Sessions created afterwards. With the Code Mode switch off, no new
Session gets routes at all and every tool is declared, as before.

The user guide is `apps/docs/src/content/docs/guides/code-mode.mdx`; the design
and the measurements are `docs/research/code-mode-vc-471.md`.

## What a call returns

A call returns what the server sent, in the shape Pi 0.99 gives every tool
result. Code that calls MCP tools for a model, such as Code Mode (VC-471),
reads the same shape.

| Part | What it holds |
| --- | --- |
| `content` | What the model reads: Volli's trust notice, then the server's text and images in order, then the structured content as compact JSON (see the next row). A block Volli does not support (a resource link, an embedded resource) becomes a one-line text placeholder. When long text is cut, all of the text comes first as one block, followed by the images. |
| `structuredContent` | The server's `structuredContent`, unchanged. The model also reads it, as a `Structured content: {…}` line, unless one of the server's text blocks already holds the same JSON. Codex follows the same rule. It can be missing even when the tool declares an output schema: the server sent none, or it was over the limit below. |
| `isError` | `true` when the server marked the result as an error. The model gets it as an error result, and `structuredContent` and `details` are still kept. |
| `details` | Notes from Volli about the result: how the text was cut and where it was saved (`output`), or the size of structured content that was dropped (`structuredContentOmittedBytes`). Usually empty. |

A tool whose server publishes an output schema declares it as the tool's
`outputSchema`. The schema is frozen with the rest of the tool's definition, so a
Session keeps the schema it was born with. Sessions created before VC-469 (the
move to Pi 0.99) have no output schemas and keep running without them.

Images are bounded because a result stays in the Session's history and is
resent with every later request. An image larger than `read` allows (4.5 MiB of
base64) is re-encoded to fit, the same way `read` handles an image file, or
replaced by a one-line placeholder if it cannot be. One result shows the model
at most **8 images** (`MCP_RESULT_MAX_IMAGES`) and **16 MiB** of image data
(`MCP_RESULT_IMAGE_MAX_BYTES`); a note names how many more were left out.

A call that never got an answer from the server (the connection failed, or the
call was stopped) is a failed call, not an error result, and carries nothing
the server said.

**What survives a restart.** Pi records what the model read (`content`, cut
text and the structured-content line included), `details` and `isError` in the
Session's sidecar, and that is what the model sees again after a relaunch. Pi's
record of a tool result does not keep `structuredContent` itself. The Session's
durable activity row keeps the whole result, `structuredContent` included, cut
to 64 K characters.

### Long results

A result is not refused for being long, up to the host's outer bound below. If
its text is over **20 KiB** (`MCP_RESULT_INLINE_MAX_BYTES`), the model gets the
start and the end of the text, with a `…N chars truncated…` marker between
them. Pi and Codex use the same format. The full text is saved to a file, and
the result gives the file's path so the model can `read` the middle in parts
with `offset` and `limit`. The output starts at line 3 of the file, after
Volli's notice. Lines longer than **16 KiB** are split across several lines in
the file (the header says so), because `read` refuses a line over 50 KB, and
the model should never have to fall back on the shell, whose output carries no
trust notice.

- **Where the files are.** Next to the Pi sidecar that holds the Session's
  conversation:
  `<userData>/pi-sessions/<workspace folder>/<sidecar name without .jsonl>.tool-output/`.
  Never in `/tmp`. Each file starts with a line saying what it is and that its
  content is untrusted data. Files are readable by your user account only, and
  Volli refuses to write through a symlink standing where the directory goes.
- **How long they are kept.** Saved output is a copy of something the model
  already read the ends of, so it is a bounded cache, not a record:
  - All saved output together is kept under **1 GiB**
    (`TOOL_OUTPUT_TOTAL_MAX_BYTES`). When a new file needs the room, the oldest
    files go first, whichever Session saved them.
  - Archiving or deleting a ticket removes the saved output of its Sessions.
    The Sessions, their transcripts and their sidecars stay.
  - Cleaning up an orphaned sidecar (Settings → Storage → *Pi session logs*)
    deletes its saved output too. The same section shows how much saved output
    there is, against the 1 GiB bound, after a scan.

  A file removed by any of these is reported as missing if the model asks for
  it later. Calling the tool again gets the data back.
- **Backups.** The files are left out of Volli's own backup bundle, like the
  sidecars, because a tool result can contain anything the server could see.
  Volli does not mark them for other backup tools such as Time Machine.
- **Reading them back.** When `read` opens a saved file, its result starts with
  a notice that the file is untrusted data, so the warning is not lost when the
  model reads the rest of a result later. A Session whose authority is set to
  `enforce` may read, but never write, the saved output its own history names:
  its own, and that of every earlier attachment whose conversation it carries,
  after a relaunch as well as on the first attach. It may not read another
  Session's saved output, and a symlink inside the directory grants nothing.
- **Limits.**
  - One file holds at most **8 MiB** of text (`MCP_RESULT_MAX_BYTES`). If the
    text is longer, the file holds the first 8 MiB and the result says how much
    of the total that is.
  - One Session attachment saves at most **256 MiB**
    (`TOOL_OUTPUT_DIRECTORY_MAX_BYTES`). After that, long results are still cut,
    but not saved, and the result says why.
  - Structured content over 8 MiB as JSON is dropped from the result, and a
    note in the content gives its size.
  - The host reads at most **32 MiB** of one result
    (`MCP_RESULT_HOST_MAX_BYTES`), counted over its text, image data and
    structured content before anything copies it. A larger result comes back to
    the model as an error naming the limit. One message from a server, local or
    remote, can be up to 8 MiB plus 64 KiB (`MCP_STDIO_BUFFER_MAX_BYTES`),
    enough for an 8 MiB result and its framing.

These rules apply to MCP results only. `web_fetch` already returns at most
25,000 characters of an extracted article, and saving the rest of a web page
would put untrusted page text in a file that `read` would later return without
the per-read markers `web_fetch` wraps it in. `execute` keeps Pi's own handling:
the last 2,000 lines or 50 KB, with the full output in a Pi temp file.

## What is out of scope

- Downloading, unpacking or verifying packages from npm, PyPI, OCI or anywhere
  else — VC-379.
- SSE and WebSocket transports (see [Transports](#transports)).
- The `2026-07-28` protocol revision for servers that speak only it — VC-479 (see
  [The client and its protocol versions](#the-client-and-its-protocol-versions)).
- A per-server working directory; the project root is always used.
- `!command` credential values (see
  [Headers and environment values](#headers-and-environment-values)).
- Searching a remote registry for a server to install. `server_preview` connects to
  a server you already name; it does not go looking for one.
- MCP resources, prompts, sampling and roots.

## Where the code is

| Area | File |
| --- | --- |
| Verb declarations | `packages/shared/src/verb-registry.ts` |
| Role bundles | `packages/shared/src/agent-tool-surface.ts` |
| Config checks, tool checks, safe names, warnings, provenance | `packages/shared/src/mcp.ts` |
| Verb handlers | `apps/desktop/src/main/mcp/verbs.ts` |
| Settings owner | `apps/desktop/src/main/mcp/settings.ts` |
| Discovery | `apps/desktop/src/main/mcp/discovery.ts` |
| Client, transports, launch environment | `apps/desktop/src/main/mcp/client.ts` |
| Credential references, value checks, OAuth client settings | `packages/shared/src/mcp-credentials.ts` |
| Resolving references and secrets at connect time | `apps/desktop/src/main/mcp/credentials.ts` |
| The user-only credential file | `apps/desktop/src/main/mcp/credential-store.ts` |
| OAuth: connection tokens, refresh, sign-in, sign-out | `apps/desktop/src/main/mcp/oauth.ts` |
| Per-attachment connection owner | `apps/desktop/src/main/mcp/session-host.ts` |
| Result shape, cutting long results | `createMcpTool` in `packages/agent-runtime/src/pi/tools.ts` |
| Saved tool output, its limits and lifetime | `packages/agent-runtime/src/pi/tool-output.ts`, `apps/desktop/src/main/pi-tool-output.ts`, `apps/desktop/src/main/pi-session-orphans.ts` |
| Shared per-server bound | `packages/agent-runtime/src/mcp/server-budget.ts` |
| Parallel-read marks | `withParallelReadEligibility` in `packages/shared/src/mcp.ts` |
| Parallel dispatch rule | `packages/agent-runtime/src/pi/tool-dispatch.ts` |
| Developer opt-in, stamping, attach narrowing, budget binding | `apps/desktop/src/main/mcp/parallel-dev-config.ts`, `dispatch-policy.ts` |
| Parallel-dispatch benchmark | `apps/desktop/e2e/bench/mcp-parallel/` (`pnpm -C apps/desktop bench:mcp-parallel`) |
| Storage | `apps/desktop/src/main/db/mcp-servers-repo.ts`, `mcp-operations-repo.ts` |
| Configure pane | `apps/desktop/src/renderer/src/components/settings/configure/mcp-pane.tsx` |
| Server dialog, tool picker | `mcp-server-dialog.tsx`, `mcp-tool-picker.tsx`, `mcp-tools-model.ts` (same folder) |
| Tool hints (display-only labels) | `sanitizeMcpToolHints` in `packages/shared/src/mcp.ts` |
| Credential editor | `apps/desktop/src/renderer/src/components/settings/configure/mcp-credentials-editor.tsx` |
