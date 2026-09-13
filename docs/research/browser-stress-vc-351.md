# VC-351 — browser tooling stress results

## Scope and reproduction

Tested on macOS arm64 with Electron 44.0.0 and Node 24.18.0. All live pages were loopback fixtures; Electron runs used isolated profiles and HOME directories. No real provider turn, credentials, or default browser was used. All eight named tools were called against a local fixture through the built app's actual Session tool surface.

The attachment describes **an optional transcript preview failing after navigation already succeeded**. The rejecting `capturePage()` path was reproduced deterministically in unit tests and in real Electron using fault injection. A naturally occurring `UnknownVizError` was **not** reproduced: the cold headless fixture already worked on the baseline. The fix does not assume hiding a window is the cause, reveal tabs, disable isolation, or fall back to another browser.

## Fixes and evidence

| Confirmed issue | Fix / regression evidence |
| --- | --- |
| Preview rejection erased successful navigation/action; a never-answering capture could wedge the tool | Optional previews return null on failure, have a 1-second deadline, honor withdrawal, and log diagnostics. Explicit screenshots still fail visibly. Native `capturePage` rejection/hang/abort injected in `browser-recovery-smoke.mjs`. |
| Capture completion could store stale pixels after navigation/closure, or after the person started typing | Recheck identity, original generation and interaction state before storing. The interaction check is independent of the final Presentation, so hiding a tab does not expose recently typed pixels. Only on-screen input is stamped, because CDP input on a staged Headless tab is agent input. Do not store late/empty frames. Unit tests cover each transition. |
| Timed-out `capturePage()` calls could accumulate because Electron provides no cancellation | Deduplicate by generation and cap native preview requests at two per tab. One hung capture can recover on the next generation; two hangs fail optional previews closed until the tab closes instead of creating an unbounded native queue. Unit tests prove both deduplication and the hard cap. |
| Concurrent same-tab calls constructed per-Session debugger transports and coordinated only inside one port | The Browser host owns one FIFO and one debugger transport per tab across all Session ports. Attachment-local controllers preserve each Session's ref map. Tests prove cross-Session serialization, one transport, and last-owner disposal; different tabs remain parallel. |
| Turn or attachment teardown could release a hold or detach the debugger before an active key-up or mouse-up completed | Queued withdrawal still rejects at once and never executes. Active work settles only after bounded input cleanup. Turn-end uses a queue barrier; attachment disposal waits for its internal work before releasing holds, wake leases, debugger ownership, and Headless tabs. |
| Disposal could leave pending initialization alive or permit new calls | An attachment-lifetime abort withdraws pending/queued calls; debugger initialization checks disposal between commands. Tests cover late readiness, repeat calls after disposal, and disposal during active input cleanup. |
| Load wait could miss completion during listener installation and wait its whole deadline; renderer death also waited unnecessarily | Close the installation gap and finish on destruction/renderer exit; listener/timer cleanup tests. |
| Detached or non-focusable DOM nodes surfaced raw CDP errors | Specific node/layout errors become actionable refusals; actual debugger/transport errors, timeouts and cancellations remain intact. Select also checks that its resolved element is still connected before it changes value. |
| `Control+a` and `Meta+a` did not select input text; shifted punctuation was incomplete | A fixed CDP `selectAll` editing command handles both documented shortcuts without clipboard access. Shift handling covers letters and US-keyboard punctuation such as `Shift+1` → `!`, with matching key and char events. Replacement and shifted values are verified in five native view states. |
| A failed mouse/key release could still report successful input | Report release failure when there was no earlier error; preserve the earlier fault during best-effort cleanup. Unit tests cover click and press. |
| Screenshot metadata described CSS dimensions, not PNG dimensions | Read device-pixel dimensions from PNG IHDR. Cold fixture previously reported 1265×720 for a 2560×1440 image; fixed run reports 2560×1440. |
| Replacing one pinned preview published it headless before removing its native plane | Park the displaced view immediately, just like explicit Hide; test that the other Session's preview stays on screen. |
| The Browser overlay smoke assumed no stand-in pixels after the sidebar's own exit overlay | Keep the persistent stand-in invariant and test the user-visible plane swap. Unit coverage remains the source of truth for capture timing. |
| New smokes wrote large profiles and failure debris into the repository | Both use `makeScratch()` for isolated temporary state and `evidenceDir()` for bounded failure output. Normal and signal-driven cleanup remove owned scratch state. |

## Repeatable live matrix

Run `pnpm run smoke:browser` after installing dependencies. The command builds the app, ensures Electron's lazily installed binary, and runs these six scripts. A macOS display is required; “headless” below means Volli's never-shown tab presentation, **not** a separate Playwright headless Chromium implementation.

| Script (`apps/desktop/e2e/`) | Checks run / result |
| --- | --- |
| `browser-tools-stress.mjs` | 24 passed: all eight port operations, all seven act kinds, three tabs, history/reload, failed-load recovery, ownership/hold contention, stale refs, presentation changes, minimized/hidden app, cancellation, debugger detach/reconnect, DevTools coexistence, concurrent operations, turn-end/disposal. |
| `browser-recovery-smoke.mjs` | 10 passed: input replacement/select/click/PNG checks in headless, shown, hidden-again, minimized, and window-hidden states; injected preview faults and explicit screenshot failure; concurrent snapshots. It also verifies the selected value and checks `Shift+a` and `Shift+1` key values against inserted text. |
| `browser-headless-capture-smoke.mjs` | 4 passed, baseline and fixed builds: cold 1,511-node module-load fixture; fixed screenshot 298ms, 746,011 bytes, 2560×1440, 33 sampled colors; click and screenshot finish before the delayed module. |
| `browser-page-navigation-smoke.mjs` | 3 passed: link, submit-button and Enter navigation with generation advancement. |
| `browser-tab-smoke.mjs` | 11 passed: visible browser chrome, isolation, overlays, history, managed popup, docked DevTools, cursor/holds/takeover and clean tab shutdown. |
| `browser-headless-smoke.mjs` | 5 passed: Activity Island → preview → hide → strip promotion → close, alongside another pane. |

The stress smoke accepts either working control alongside DevTools or the explicit debugger-ownership refusal, followed by recovery. This Electron build **coexisted** with DevTools; it did not require closing DevTools to work. The final app cleanup was graceful, and the Browser Tab and hold teardown assertions passed.

## Automated checks actually run

- `pnpm install` and `pnpm run ensure:electron`: passed. The first live smoke launch found the fresh checkout's missing lazy Electron binary; ensuring it resolved that setup failure.
- `pnpm run smoke:browser`: **passed all six scripts / 57 checks** on the final build (exit 0). This includes the build and lazy Electron binary check.
- `pnpm run build`: passed, including standalone preload and packed-require verification.
- `pnpm typecheck`: passed across all nine configured tasks, repeated after the final source changes.
- `pnpm -C apps/desktop exec vp test run src/main/browser src/renderer/src/components/browser src/renderer/src/stores/browser-tabs.test.ts --maxWorkers="$VOLLI_CONCURRENCY_HINT"`: **310 passed / 18 files**.
- The three changed Browser unit suites: **182 passed**. They include cross-Session queue and debugger lifetime tests, active-input cleanup barriers, non-vacuous queued cancellation, privacy after Hide, capture deduplication and saturation, Shift punctuation, and detached Select.
- `pnpm -C packages/agent-runtime exec vp test run src/pi/browser-tools.test.ts src/browser/refusal.test.ts --maxWorkers="$VOLLI_CONCURRENCY_HINT"`: **24 passed**.
- `vp check`: all 1,935 files formatted and all 1,888 lint targets passed with no warnings or errors. `git diff --check` also passed.
- `vp run -r test:coverage --maxWorkers="$VOLLI_CONCURRENCY_HINT"`: passed all eight workspace tasks. The desktop task passed **9,501 tests** with 2 integration tests skipped; protected coverage surfaces remained at 100%.

Logs from the implementation runs are in this worktree's ignored `.volli/vc351-*.log`. Current smokes put owned scratch profiles under the system temporary directory, remove them after normal completion or interruption, and write bounded failure evidence outside the repository. Test-generated profiles are isolated, not application data to merge.

## Limits

No claims about Windows/Linux, screen lock/suspend, GPU-process crashes, arbitrary external sites, long-duration memory/CPU soak, or packaged-app distribution. Renderer-death handling is unit-tested; native compositor rejection/hang is fault-injected. The full local coverage gate, focused Browser checks, and live matrix are green.
