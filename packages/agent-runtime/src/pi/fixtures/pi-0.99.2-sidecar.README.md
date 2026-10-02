# Pi 0.99.2 sidecar compatibility fixture

`pi-0.99.2-sidecar.jsonl` contains actual output from the saved installed,
patched `@earendil-works/pi-agent-core@0.99.2` build, captured before the Pi 1.0
upgrade for VC-496. It is not handwritten JSONL and contains no real profile,
credentials or conversation. Its only workspace path is the synthesized
`/workspace/vc496/compatibility`.

The capture used `JsonlSessionRepo` with a fixed repository clock
(`1800000000000`) and `NodeExecutionEnv` pointed at a synthetic profile inside
the ticket workspace. Through the 0.99.2 session API it created:

1. `main`, the `volli.identity.v1` value and a user message with multibyte text.
2. An assistant with a synthetic thinking signature, then a custom observation.
3. `side` at the main tip, followed by a sibling-only user message.
4. A transaction containing a compaction entry (retained tail and opaque
   provider details), a main-tip update, a list append and a usage row.
5. A session name, followed by closing the writer and copying its file unchanged.

The header is `v: 4`, `storageVersion: 1`. Committed writes occupy sequences
1–16. Both single-write object lines and multi-write array lines are present.
The capture script and original synthetic profile are temporary evidence under
`.bench-tmp/pi-migration-vc496/`, not production data.

`sidecar-load.test.ts` opens these bytes through `harness-session.ts`, checks
identity, branches, signed content, compaction context, list and usage, confirms
read-only opening changes neither bytes nor inode, appends sequence 17 without
altering the original byte prefix, and closes/reopens the continuation.
