# MCP servers in Volli

Volli can connect a Session to Model Context Protocol servers. A server's tools
become ordinary tools in that Session's tool array, alongside `read`, `execute`
and Volli's own verbs.

This document covers how servers are configured, who may configure them, what
the warnings mean, and how to recover when an install goes wrong. The client,
the transports, the tool-name safety rules and the frozen tool surface were
built in VC-8; the agent-facing management verbs in VC-380.

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

**Settings → Configure → MCP Servers.** Press *Add server* to open the editor,
fill in the transport, press *Test and discover* to connect and read its tool
list, tick the tools you want, and save. Nothing is stored until discovery
succeeds, and discovered tools default to off — every tool is an explicit
choice. *Cancel* closes the editor; *Edit* on a server row reopens it populated.

A configured server's tools sit behind *Show tools* on its summary card, which
is where they are enabled and disabled. A real catalog is thirty-plus tools with
a paragraph of description each, so the page shows the counts, the freshness,
the origin and anything wrong, and opens the rest on request.

## The agent-facing verbs

Eight verbs, all **control tier**: tool-only, Role-gated, and absent from the
`volli` CLI and the agent socket entirely. There is no shell door for any of
them, by design — a same-uid process must not be able to install an MCP server.

| Verb | Wire name | What it does |
| --- | --- | --- |
| `mcp.list` | `mcp_list` | List configured servers, their tools, provenance, and recent management history. Connects to nothing. |
| `mcp.preview` | `mcp_preview` | Connect to a server you already have the configuration for, read its tools, save nothing. |
| `mcp.install` | `mcp_install` | Add or update a server. **Previews by default.** |
| `mcp.refresh` | `mcp_refresh` | Reconnect and re-read a configured server's catalog, keeping the selection. |
| `mcp.enable` | `mcp_enable` | Turn a configured server on for Sessions created from now on. |
| `mcp.disable` | `mcp_disable` | Turn it off, keeping the configuration. |
| `mcp.tools` | `mcp_tools` | Replace which of a server's tools are on. |
| `mcp.remove` | `mcp_remove` | Delete a server's configuration. **Previews by default.** |

An MCP server's own tools are **not** Volli verbs and are not in the Verb
Registry. They are dynamic, settings-backed definitions frozen into a Session by
id. These eight manage the servers; they are not the servers' tools.

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

1. **The plain call previews.** `mcp_install` and `mcp_remove` declare
   `previewsByDefault`, so calling either without `confirm: "apply"` reports the
   warning and exactly what would change, and writes nothing. For an install the
   preview also connects to **nothing** — a local MCP server is a process
   started as you, so "warned before anything runs" means before the process,
   not before the row is written. Use `mcp_preview` when you want to connect and
   look.
2. **The apply call asks a person, when there is one.** A second call carrying
   `confirm: "apply"` raises a `confirm.mcp-install` / `confirm.mcp-remove`
   question through the Session's own parked-question machinery. The person sees
   the warning and answers *Allow once* or *Reject*.

A Session running unattended has no port to ask through. It is not blocked: the
deliberate preview-then-apply pair is the confirmation, and the result says in
plain words that nobody was asked, rather than implying somebody was.

### Why the other six verbs do not confirm

`mcp_list`, `mcp_enable`, `mcp_disable`, `mcp_tools` and `mcp_refresh` act only
on a server **already in this project's configuration** — a transport somebody
has already confirmed through the gate above, or typed into Settings themselves.

`mcp_refresh` is the one worth being explicit about, because it *does* start that
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
equivalents — and nothing else. No model provider key, no Volli session token,
no telemetry credential.

### A remote (streamable HTTP) server

> *It receives whatever arguments its tools are given, including file contents,
> paths and anything a model puts in a tool call, and Volli cannot see what it
> does with them.*

The operator of that endpoint sees every argument of every call. Volli sends no
credentials of its own.

### The MCP verbs refuse a query string

`mcp_preview` and `mcp_install` **refuse** a URL that carries a query string,
before anything is connected:

> *That endpoint carries a query string, and the MCP verbs refuse one. Volli has
> no secret storage for MCP servers and cannot tell a token from an ordinary
> parameter, so a query string would be stored in plain text and sent to the
> server as given.*

A query string is the last place in a URL a credential can sit once userinfo
(`user:pass@`) and fragments are already refused. Volli cannot tell `?token=…`
from `?version=2`, so it refuses the **shape** rather than guessing at the
meaning. The alternative is storing an unknown value in plain text — in the
project database and in every backup bundle — and calling that support.

This is the cost of the rule, stated plainly: **a server that needs a non-secret
query parameter cannot be installed by an agent.** The way through is
Settings → Configure → MCP Servers, where a person can see what they are typing
and chose it themselves. That path is unchanged from VC-8.

Where a stored server does carry a query string — because a person added it by
hand — Volli prints the **origin and path** and marks the rest
`(query string not shown)`, in previews, confirmations, `mcp_list` and durable
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
configuration came from and which version was asked for. `mcp_install` accepts
four optional fields, all of them recorded and none of them enforced:

| Field | Meaning |
| --- | --- |
| `source` | Where the configuration was read from: a registry entry, a URL, a document. |
| `registryType` | One of `npm`, `pypi`, `nuget`, `cargo`, `oci`, `mcpb` — the package types the MCP Registry documents **today**. The registry is preview software and may add more, so treat this as versioned vocabulary rather than a fixed part of MCP. |
| `version` | The version string this install **asked for**. Nothing pins the running command to it. |
| `digest` | A digest the source published, such as `mcpb`'s `fileSha256`. |

A pinned digest is **recorded, not enforced**. Verifying one requires downloading
the artefact, which Volli does not do; that work belongs to VC-379, which owns
package format support. `mcp_list` and the Configure pane both label provenance
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

## Authentication is not supported yet

VC-8 deliberately excluded authenticated HTTP, custom headers, and secret
environment values, and VC-380 does not reopen it. There is no `headers` field,
no `env` field and no `token` field on any verb, because a field would promise
something the transport layer will not do.

**The practical consequence:** many real MCP servers need an API key, and an
agent cannot install those. Until a later ticket adds secret handling, an agent
can only install servers that need no credential. A person can still configure
such a server by hand only to the same extent — the limitation is in the
transport, not in the verbs.

Never put a credential in a verb argument. There is no field for one, a URL
carrying a query string is **refused outright**, and provenance values are
charset-bounded so they cannot carry structured secrets.

## Recovering from a failed or regretted change

### A first-time install failed

Nothing was written. The project's configuration is exactly as it was, there is
no half-created row, and **retrying the same call immediately is safe**. The
result says so.

### An update to an existing server failed

The server keeps its **last working tool list** and is marked **stale**, with
the failure recorded against it. Nothing that worked has stopped working.
Sessions born before the failure are unaffected. Fix the cause, then call
`mcp_refresh` or install again; a success clears the stale marker.

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

### You removed a server and older Sessions now fail to reattach

`serversForFrozenMcpTools` throws when a frozen tool's server is gone, so those
Sessions cannot reattach. **Re-add the server under the same id** — the removal's
audit record contains the transport needed to do it — and reattachment works
again.

To avoid this entirely, prefer **`mcp_disable`**. It keeps the configuration, so
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
the only place its configuration and recovery line survive. `mcp_list` shows the same history to an agent.

The row's id is derived from the calling Session and the tool call that asked
(`${sessionId}:${toolCallId}`), not minted fresh per execution. A retried tool
call — an ordinary outcome when a response is lost — therefore lands as the one
act it was, rather than as two records of one install.

`mcp_list` prints the recent history beside the servers.

When the calling Session has a Ticket, the same facts are **also** written as a
ticket comment, because that is where someone doing the work will look. The
project row remains canonical: the Board Role holds these verbs, and a Board
Session has no Ticket to comment on.

## What is out of scope

- Downloading, unpacking or verifying packages from npm, PyPI, OCI or anywhere
  else — VC-379.
- SSE and WebSocket transports (see [Transports](#transports)).
- A per-server working directory; the project root is always used.
- Authenticated HTTP servers, custom headers, secret environment values.
- Searching a remote registry for a server to install. `mcp_preview` connects to
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
| Per-attachment connection owner | `apps/desktop/src/main/mcp/session-host.ts` |
| Storage | `apps/desktop/src/main/db/mcp-servers-repo.ts`, `mcp-operations-repo.ts` |
| Configure pane | `apps/desktop/src/renderer/src/components/settings/configure/mcp-pane.tsx` |
