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

- `@earendil-works/pi-coding-agent` — `createAgentSession`, `AgentSession`,
  `ModelRuntime`, `SessionManager`, `SettingsManager`, `ResourceLoader`
- `@earendil-works/pi-agent-core` — `StreamFn`, `ThinkingLevel`, agent events
- `@earendil-works/pi-ai` — model catalog, credential store, message types

`@earendil-works/pi-client`, `pi-protocol`, `pi-telemetry`, and `pi-tui` arrive
transitively and are not imported here.

## Local patches

None.

## Divergence policy

Exact pin, no ranges. Version bumps are deliberate and recorded in the commit
that makes them, together with the tag and commit hash above. Forking or
vendoring Pi requires a concrete, documented need per
`docs/plans/pi-native-ticket-session.md`.

## Known follow-ups

- Pi's bash tool injects `PI_*` environment variables into spawned commands.
  `exposeSessionEnvironment: false` turns that off, but it is an option of
  `createBashToolDefinition` and `createAgentSession` exposes no way to reach it.
  Turning it off needs either an upstream option or building the tool set
  ourselves.

## License

Pi is MIT licensed.

```
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
