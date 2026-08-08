# Upstream: Pi

`@volli/agent-runtime` is the product-owned boundary; the executor behind it is
Pi, consumed from npm.

- Repository: https://github.com/earendil-works/pi
- Previously `badlogic/pi-mono`, published under the `@mariozechner/*` npm scope.
  Both are stale — the current packages are `@earendil-works/*`.
- Pinned release: tag `v0.84.1`, commit `53fa77ccd8a279eb87e92294ef3687b03ff80112`
- Node floor: `>=22.19.0`. ESM only.

## Packages consumed

Direct dependencies, all pinned to exactly `0.84.1`:

- `@earendil-works/pi-agent-core` — `Agent`, JSONL Session persistence,
  context-injected coding tools, and the Node execution environment
- `@earendil-works/pi-ai` — model catalog, provider streams, and message types

`@earendil-works/pi-telemetry` arrives transitively and is not imported here.
The coding-agent TUI, client, and protocol packages are intentionally absent.

## Process sandbox runtime

Direct dependency, pinned exactly to `0.0.70` when Session 3 enables Pi bash:

- `@anthropic-ai/sandbox-runtime` — https://github.com/anthropic-experimental/sandbox-runtime,
  Apache-2.0, maintained macOS Seatbelt process boundary used by Claude Code.
  Its access policy is inherited by bash children rather than reimplemented in
  Volli. This is the smallest maintained Node-seam dependency that supplies the
  approved Claude Code-style boundary without building a custom sandbox.

Session 3 divergence: Volli supplies the canonical Ticket worktree and a
sanitized environment, uses SRT's immutable maintained policy for
worktree-only writes, user-home denial outside that worktree, and no network,
and fails closed before advertising execution when the runtime or policy is
unavailable. Its sanitized PATH intentionally retains fixed system/global
toolchain roots (`/opt/homebrew`, `/usr/local`, and system paths) so ordinary
build/test commands work; user-home toolchains and credentials are excluded,
and explicit user-home grants remain deferred. Host process-group abort,
timeout, and close are best-effort lifecycle hygiene only; they do not promise
cleanup of daemonized or reparented descendants.

Upgrade checks: review SRT's exact version, license, macOS Seatbelt policy and
its inheritance by shell children; rerun outside-worktree/user-home write and
network-denial tests; verify the sanitized environment and fail-closed startup
path; and record any policy or API divergence here before bumping the pin.

## Local patches

None.

## Credentials

Pi owns provider credentials and refresh behavior. `@earendil-works/pi-ai`
ships only `InMemoryCredentialStore` and states that "Apps inject persistent
stores", so `builtinModels()` on its own reports every provider as
unconfigured however a person is logged in.

The persistent store upstream — `AuthStorage` in
`packages/coding-agent/src/core/auth-storage.ts` — is **not exported**: the
published `@earendil-works/pi-coding-agent` `exports` map is `.`,
`./rpc-entry` and `./client`, and the barrel re-exports only
`readStoredCredential`. Depending on that package would also drag in the
coding-agent TUI this boundary deliberately excludes. So `src/pi/models.ts`
implements the `CredentialStore` seam against Pi's own file instead, and
matches Pi's conventions rather than inventing any:

- Path: `$PI_CODING_AGENT_DIR` (leading `~` expanded), else `~/.pi/agent`,
  then `auth.json` — Pi's `getAgentDir()`/`getAuthPath()`.
- Format: `{ "<providerId>": Credential }`, `JSON.stringify(…, null, 2)`.
- Mode: `0600`.
- Lock: Pi 0.84.1's `FileAuthStorageBackend` creates the parent and an empty
  `0600` file first, then locks `auth.json` itself with `proper-lockfile`
  (`realpath: false`, `stale: 30_000`, retrying `ELOCKED` for up to 30 seconds)
  across every async read-modify-write. This store follows that protocol for
  `modify` and `delete`, while retaining its atomic temp-file rename.

Refresh is still Pi's: `Models.getAuth()` runs the OAuth exchange inside
`CredentialStore.modify()`, so a rotated token is written back through this
store by Pi. Nothing here parses, mints, or refreshes a token.

Divergence worth knowing: Pi writes in place while this store writes a `0600`
temporary file and atomically renames it over `auth.json`. Both sides use the
same advisory lock, so each mutation re-reads a settled map and preserves
providers that were updated by the other process.

## Divergence policy

Exact pin, no ranges. Version bumps are deliberate and recorded in the commit
that makes them, together with the tag and commit hash above. Forking or
vendoring Pi requires a concrete, documented need per
`docs/plans/pi-native-ticket-session.md`.

## Deliberate Session 3 boundary

Only Pi core's `read`, `edit`, and `write` tools are loaded until the pinned SRT
boundary enables bash. The filesystem tools retain Volli's worktree and symlink
guard. That name-based guard has a TOCTOU limit: an external process with write
access to the worktree could replace a validated component with a symlink before
Pi's delegated filesystem operation opens it. Descriptor-based `O_NOFOLLOW`
operations are required to close that host-level race completely.

## License

Pi is MIT licensed.

```text
MIT License

Copyright (c) 2025 Mario Zechner

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
