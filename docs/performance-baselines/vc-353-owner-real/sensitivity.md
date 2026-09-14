# VC-353 regression-sensitivity proof

> Performance numbers are comparable only on the same machine, in the same power/thermal state, with the same load arm.

On 2026-09-13, the owner machine ran two back-to-back 20-sample, idle-arm stream-and-scroll probes against clean commit `c17dc86c9fa157857687062680cb5c0ae2408096`. Both used the deterministic `real` fixture (1,198 Sessions / 259,855 Session Events), the real `ChatPlane`, a 1,600-message transcript, 120 scrolling frames per sample, and a 30 token/s live assistant stream that opened and closed a growing TypeScript fence.

The control left the regression injection at its normal zero value. The second run enabled the harness-only 20 ms renderer busy wait on every streamed frame. No product behavior was changed, and the committed full baseline must record `slowdownMs: 0`.

| Metric | control (`0 ms`) | deliberate slowdown (`20 ms`) | movement |
|---|---:|---:|---:|
| interaction latency p50 | 2,154.2 ms | 3,022.7 ms | +868.5 ms (+40.3%) |
| interaction latency p95 | 2,155.2 ms | 3,137.1 ms | +981.9 ms (+45.6%) |
| frame time p95 | 17.6 ms | 34.7 ms | +17.1 ms (+97.2%) |
| dropped frames p50 | 0 | 52 | +52 |
| dropped frames p95 | 0 | 59 | +59 |
| latency variance | 0.556 ms² | 4,791.248 ms² | +4,790.692 ms² |

All 40 raw samples reported `streamedWhileWorking: true`, `codeFenceOpened: true`, and `codeFenceClosed: true`. Both renderer-error lists were empty. The expected latency, frame-time, dropped-frame, and variance signals moved substantially, proving the instrument detects the injected regression; the ordinary path remains the zero-slowdown control.

Machine: MacBookPro17,1, Apple M1, 8 logical cores, 16 GiB, macOS 26.5.1 (25F80), arm64, Node v24.18.0.

Raw reports:

- [`sensitivity/control.md`](sensitivity/control.md)
- [`sensitivity/deliberate-slowdown.md`](sensitivity/deliberate-slowdown.md)
