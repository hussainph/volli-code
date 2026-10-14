# Pre-VC-722 listener recordings

The `pre-vc722-*.json` fixtures are actual loopback exchanges captured from
revision `2323b19dac96eea3a9d77e512c1fadbccdc8f34c`, not envelopes generated
by the current parser. `n-1-hello.ts` is separate grammar evidence.

## Capture

The recordings use the production
`apps/hostd/src/host-protocol.ts:startHostdProtocolListener`, including its
router and `session-rpc` WebSocket listener. No replacement parser, mock
server or current-branch host code generated the frozen exchanges.

To reproduce, prepare a checkout of that revision with its dependencies,
copy `record-pre-vc722.test.ts.txt` to
`packages/host-protocol/src/vc722-record.test.ts`, and run:

```sh
pnpm --filter @volli/host-protocol exec vp test run src/vc722-record.test.ts --maxWorkers="$VOLLI_CONCURRENCY_HINT"
```

The harness uses loopback ports 5381 and 5382 and writes JSON beside the
checkout. Nonces and traces are frozen as recorded, not normalized. Credentials
are synthetic placeholders; no provider, SSH or sign-in starts. Database and
engine ports are stubbed.

## Recorded exchanges

The host-scope recording sends a host hello in `connectionParams`, then
`protocol.welcome`. The old listener returns JSON-RPC `-32600`, tRPC
`BAD_REQUEST`, HTTP 400, `hostError.reason: hello-invalid`, and
`This connection sent no valid hello.`, then closes with 4400 / hello-invalid.
The verifier is not called: this is grammar refusal, not a credential failure.

The Workspace recording uses the old `createHostLink`. Requested features are
`sessions`, `board.read`, `sign-ins`, `host.logs`, and `future.feature`; the old
host grants exactly the first four. The welcome and both sent frames are frozen.
The verifier grants a synthetic device and the Workspace row uses epoch 0.

`record-old-client-new-host.test.ts.txt` provides the reverse exchange: the old
`createHostLink` against `startHostdProtocolListener`, using listener blob
`a6ab16b4603aa02053e38910236398f098261fda` in a checkout based on
`23892bc9aa5fbcb4596342f9fa413c5428602623`. Old requested/granted features and
the complete welcome remain unchanged apart from nonce/trace randomness.

## Persistent verification

`src/client-link/compatibility.test.ts` sends the frozen old-client frames into
the current production `startHostProtocolListener` with `createHostRouter` on
port 5384 and compares the entire reply. A fixture replay on port 5383 exercises
the old refusal and close; it does not run the old binary in CI.

Only a host-scope attempt's named `BAD_REQUEST / hello-invalid` refusal is
classified as client-local `host-scope-unsupported`. Workspace attempts,
credential/Workspace/version errors and generic bad requests retain their
meaning. These fixtures introduce no wire error reason and do not establish
compatibility for successful newer host-scope operations.
