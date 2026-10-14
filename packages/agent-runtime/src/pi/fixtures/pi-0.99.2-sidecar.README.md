# Pi 0.99.2 sidecar compatibility fixtures

These JSONL files are output from the saved installed, patched
`@earendil-works/pi-agent-core@0.99.2` build in
`.bench-tmp/pi-migration-vc496/baseline/core`. They are not handwritten JSONL.
All conversation, signatures, usage, checkpoint blocks and product markers are
synthetic inputs. No real profile, credentials or provider traffic was used.
The only workspace path in the captures is `/workspace/vc496/compatibility`.

## Original storage-only fixture

`pi-0.99.2-sidecar.jsonl` is the unchanged original capture, made before the
Pi 1.0 upgrade. The capture used `JsonlSessionRepo` with repository clock
`1800000000000` and `NodeExecutionEnv` pointing at a synthetic workspace-local
profile. Through the 0.99.2 session API it created:

1. `main`, the `volli.identity.v1` value and a multibyte user message.
2. An assistant with a synthetic thinking signature, then a custom observation.
3. `side` at the main tip, followed by a sibling-only user message.
4. A transaction containing a compaction entry, main-tip update, list append and usage row.
5. A session name, followed by closing the writer and copying its file unchanged.

It has header `v: 4`, `storageVersion: 1`, sequences 1–16, and both object and
array transaction lines. The original generator and synthetic profile remain
under `.bench-tmp/pi-migration-vc496/` (`create-0992-fixture.mjs`). That script's
former `.pi-migration` output path is historical, not needed by the new generator.

**This is storage compatibility evidence, not a valid product compaction.**
Its `details.providerCompaction = { opaque: "compat-opaque" }` is unknown data
that the session facade must preserve, but is a malformed native checkpoint to
Volli's product reader. Its `{ kind: "message-settled", version: "0.99.2" }`
custom marker is also incomplete to that reader. Runtime recovery therefore
reports a failed checkpoint and unreadable-marker/partial-turn attention,
restores the original user input, and withholds the uncorroborated assistant.
The runtime test now asserts these outcomes instead of calling fallback a
successful compaction or overlooking its failed receipt.

`sidecar-load.test.ts` checks the original bytes' identity, branches, signed
content, unknown compaction details, list and usage. Read-only opening changes
neither bytes nor inode. Continuation appends sequence 17, preserves the byte
prefix, and survives closing/reopening.

## Compaction operation captures

Generate these from the repository root when the saved build is available:

```sh
node packages/agent-runtime/src/pi/fixtures/pi-0.99.2-compaction.generate.mjs
```

The committed generator verifies package version 0.99.2 and that the saved build
resides inside this workspace. It creates a temporary synthetic profile, seeds
main history and a sibling, and invokes the saved build's
`createAgentHarness` / `lane.compact` operation. Synthetic **valid** Volli
settlement markers are supplied through the old session API so checkpoint
recovery is tested independently from the original fixture's incomplete marker.

- **`pi-0.99.2-portable-compaction.jsonl`:** the old harness's normal compaction
  pipeline calls a fake summary stream, selects the retained tail, writes the
  compaction with `fromHook: false`, and records the completed operation. Its
  generated details contain read/modified-file lists and **no** native checkpoint.
- **`pi-0.99.2-native-compaction.jsonl`:** the old harness's `before_compaction`
  hook supplies a structurally valid synthetic Anthropic checkpoint for
  `claude-opus-4-6`; the old operation writes it with `fromHook: true`.
  This is **not** an actual Anthropic response or a capture of the old Volli
  runtime's native HTTP path. Pi 1.0 runtime tests verify native wire projection
  on the same model/public API route using fake auth and a fake stream.
- **`pi-0.99.2-malformed-compaction.jsonl`:** the same old operation/hook writes
  the original fixture's malformed opaque checkpoint shape, but with valid
  settlement markers. This isolates checkpoint failure from marker failure and
  proves restoration of the complete pre-compaction main history.

Each JSONL is copied unchanged after the old compaction operation completes,
**before** a verification continuation on its synthetic source. The generator
then drives that continuation through the old harness and asserts the summary
and both retained messages survived without old history or the sibling.
Repository timestamps are fixed; entry UUIDs and operation timestamps are not,
so regeneration is semantic, not byte-deterministic.

The portable/native `.context.json` companions are actual provider contexts
captured from that old-harness continuation, excluding its system head and new
verification prompt. The malformed `.history.context.json` companion is the
pre-compaction history projected by the saved old session reader/converter;
it is the reference for correct checkpoint fallback.

`pi-0.99.2-reattach.test.ts` independently pins known summary/tail/history text,
compares Pi 1.0 requests with these old-build references, and continues twice
across restart. Retained assistant usage alone is expected to reset to zero in
live compacted context under existing product policy; durable usage is unchanged.
The tests exclude old history and the sibling on valid compactions, require no
unexpected compaction failures, verify the native block's wire projection, and
require exactly one durable failed-checkpoint receipt for malformed recovery,
even after another restart. All continuations keep the same recovery locator,
inode and original byte prefix. Network requests are explicitly blocked.
