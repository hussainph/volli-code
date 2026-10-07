# Pre-VC-729 host Model Access exchange

`pre-vc729-host-models.json` was captured from an independent source archive of
`origin/main` at `49fc56278edba86607999b7c1d366e87ac02a800`, not from the new
router. The production listener received actual WebSocket frames through `ws`.
The verifier supplies a test-only host device; there are no real credentials.

The new client's requested feature is absent from the old host's welcome.
An unsolicited `hostModels.defaults` query returns the old router's real
`NOT_FOUND` envelope. New clients decide compatibility from the missing feature
and never send that probe. Successful `hostModels.*` exchanges cannot have an
N−1 recording because N−1 implements none of those operations.

To reproduce from the repository root (fresh private `.tmp/vc729-base`):

```sh
mkdir -p .tmp/vc729-base
git archive 49fc56278edba86607999b7c1d366e87ac02a800 \
  tsconfig.base.json packages/shared packages/session-rpc \
  packages/session-engine packages/host-protocol | tar -x -C .tmp/vc729-base
for p in shared session-rpc session-engine host-protocol; do
  ln -s "$PWD/packages/$p/node_modules" ".tmp/vc729-base/packages/$p/node_modules"
done
node packages/host-protocol/fixtures/capture-pre-vc729.mjs
```

The capture aliases **every archived workspace package export** to the archived
source, while reusing installed third-party dependencies. It asserts that the
old feature table has no `host.model-defaults`. A fresh capture's nonce differs.
`src/client-link/compatibility.test.ts` replays the frozen welcome through today's
real `createHostScopeLink` and loopback listener. Its existing independent old
Workspace exchange also verifies that the new feature does not leak into an
unchanged old Workspace request.
