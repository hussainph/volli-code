# VC-758 final local validation

All focused test invocations used `--maxWorkers="$VOLLI_CONCURRENCY_HINT"` (1). Coverage was scoped to directly covered production files; no threshold was lowered. Full workspace tests, full workspace coverage and Electron smokes were left to CI.

## Final results

| Check | Result |
|---|---|
| `pnpm exec vp check` | Passed: formatting and lint |
| `pnpm --filter <package> typecheck` for desktop, session-presentation, session-engine, session-rpc, host-core, agent-runtime, cli | All seven passed |
| `node scripts/check-host-electron-imports.mjs` | Passed; nine informational computed-import notes |
| `pnpm generate:protocol-schema` then `pnpm check:protocol-schema --base origin/main` | Fresh generated schema; 37 compatibility tests passed; additive check passed |
| `git diff --check` | Passed |
| Desktop focused renderer/store run | 404 passed; chat-plane-model.ts 100% statements/branches/functions/lines |
| Presentation client | 155 passed; client.ts 100% on all four axes |
| Delivery labels + queued-message projection | 14 passed; message-delivery.ts and session-model.ts 100% on all four axes |
| Presentation JSON codec | 47 passed; wire.ts 100% on all four axes |
| Session RPC output codec | 49 passed; output-schema.ts 100% on all four axes |
| Engine runtime/invariants/queue/history | 297 passed; session-runtime.ts 100% on all four axes |
| Engine queue hint | 94 passed; session-follow-ups.ts 100% on all four axes |
| Engine transcript-tail delivery proof | 34 passed; transcript-tail.ts 100% on all four axes |
| Pi runtime + directly covering tests | 341 passed; pi/runtime.ts 100% on all four axes |
| Host runtime/restart/VC-753 integrations | 63 passed; boot-recovery.ts 100% on all four axes |
| Final real-Pi peek + SQLite/socket/CLI host assertions | 74 passed; boot-recovery.ts 100% on all four axes |
| Final CLI render/command-path/reference checks | 198 passed; render.ts 100% on all four axes |
| Final visual-tier AFTER capture | 12/12 light/dark captures; zero browser page errors; baseline captures preserved |

The runtime audit records the exact backend commands and source hashes. Renderer and CLI audits record baseline failures and integrated checks. The client subagent also ran the small presentation package (737 tests/all protected files 100%) and CLI subagent ran its package (448 tests); these are additional measured checks, not a claimed full workspace gate.

## Final host and CLI commands

```sh
# packages/host-core — real Pi/artifact/SQLite peek and real Unix socket + runCli
vp test run src/session-runtime/silent-ends.integration.test.ts \
  src/agent-dispatch/session-verbs.test.ts src/session-runtime/boot-recovery.test.ts \
  --coverage --coverage.include=src/session-runtime/boot-recovery.ts \
  --maxWorkers="$VOLLI_CONCURRENCY_HINT" --testTimeout=20000
# 74 passed, 100% scoped coverage.

# packages/cli
vp test run src/render.test.ts src/session-peek-status.test.ts \
  src/session-peek-delivery.test.ts src/orchestration.test.ts src/run.test.ts \
  src/cli-reference.test.ts --coverage --coverage.include=src/render.ts \
  --maxWorkers="$VOLLI_CONCURRENCY_HINT"
# 198 passed, 100% scoped coverage.

# packages/session-engine
vp test run src/transcript-tail.test.ts --coverage --coverage.include=src/transcript-tail.ts \
  --maxWorkers="$VOLLI_CONCURRENCY_HINT"
# 34 passed, 100% scoped coverage.

# packages/session-presentation
vp test run src/client.test.ts --coverage --coverage.include=src/client.ts \
  --maxWorkers="$VOLLI_CONCURRENCY_HINT"
# 155 passed, 100% scoped coverage.
```

The final real-Pi integration additionally serializes the actual `session.peek` response and checks provider failures still carry Delivered proof, fatal observations expose the durable explanation/outcome, and pre-turn attachment rejection says Not delivered. It does not synthesize those replies.

## Initial failed / cancelled checks

- The first desktop integrated run hit two existing 5-second history-window timeouts and caught an optional disabled prop plus an incorrectly mocked new test fixture. Product/fixture corrections and the final 20-second focused invocation passed all 404 tests, without skips or relaxed coverage.
- A typecheck caught missing required callbacks on the new real-client fixture. Those callbacks were supplied and desktop typecheck passed again.
- Formatting/lint checks caught formatting, a local shadow and an inefficient map spread. Corrected; final repository check passed.
- One parent host coverage command was cancelled because it selected an unrelated protected file without its tests. A second selected a nonexistent projection test path: its 50 actual tests passed but that unrelated coverage target failed. The corrected command above includes the real boot-recovery tests and passes 74 tests/100%. These were command-selection mistakes, not product regressions.
- Final cold lab compilation needed a longer navigation allowance; the visual owner reran successfully. No baseline image was overwritten.

No OS-process crash, external MCP process fault, live provider/sign-in, SSH, keychain/security, Docker or local Electron run is claimed. Exact-head CI gate, CodeQL and N−1 binary results are recorded on the unmerged PR at handoff.
