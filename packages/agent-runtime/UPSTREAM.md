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

## Local patches

None.

## Divergence policy

Exact pin, no ranges. Version bumps are deliberate and recorded in the commit
that makes them, together with the tag and commit hash above. Forking or
vendoring Pi requires a concrete, documented need per
`docs/plans/pi-native-ticket-session.md`.

## Deliberate Session 1 boundary

Only Pi core's `read`, `edit`, and `write` tools are loaded, each with a
Volli-owned execution environment that rejects paths outside the Ticket
worktree and rejects symlinks. Process execution remains unavailable until a
later migration slice supplies an equally enforceable containment boundary.
The current name-based guard has a TOCTOU limit: an external process with write
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
