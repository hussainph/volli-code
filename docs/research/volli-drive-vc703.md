# volli-drive: an agent harness that drives a live, isolated, keychain-free build (VC-703)

Status: **spike — prototype working, features 1 and 2 driven end to end on this Mac.** VC-718 adds a separate, CI-only flag-on acceptance lane; existing flag-off smokes are unchanged. See the [VC-579 acceptance guide](vc579-acceptance-guide.md) for its eight visible assertions, deployment setup, merged VC-710 project path and canary proof requirements.

`volli-drive` is a CLI (`node apps/desktop/e2e/volli-drive/cli.mjs`) with one **supervisor process per instance**. The supervisor holds the Playwright `_electron` connection, a loopback fake model provider and the instance's evidence; CLI calls reach it over a unix socket in the instance's 0700 scratch dir and are served one at a time. The verbs mirror Volli's own Browser Tab tools (snapshot with `[ref=…]` refs and a generation, one `act`, fresh snapshot, screenshot, console), so an agent already knows the interface. The how-to is the project skill `.agents/skills/verify-volli/` (SKILL.md + a five-feature map).

## Shape

```
cli.mjs ──launch──▶ registry (/tmp/volli-drive-<uid>, lock, max 3 live)
   │                  │
   │ spawn detached   ▼
   └──────────▶ supervisor.mjs  (per instance; idle auto-stop 20 min)
                 ├─ fake-provider.mjs   loopback Azure-Responses SSE → pinned default model
                 ├─ smoke-kit launch()  built dist-electron + dev Electron, quiet LSUIElement shadow app
                 │     env: VOLLI_HARNESS=1, VOLLI_HARNESS_DIR, isolated HOME/PI/git/worktree home,
                 │          refusing gh shim, no SSH_AUTH_SOCK, no outer VOLLI_* / provider keys
                 ├─ guard proof (bundle marker → live trap check) BEFORE fixture or any command
                 ├─ fixtures.mjs        project DRV + 4 tickets + model pin (setup doors the smokes use)
                 └─ drive.sock          snapshot | find | act | wait | screenshot | doctor | metrics | stop
cli.mjs (no supervisor needed): logs, console (evidence files), state sql (sqlite3 -readonly),
                                 state cli (the real volli CLI with VOLLI_SOCKET=<instance socket>)
```

**Fake provider scope (owner decision, final round):** `fake-provider.mjs` is a dev-only server. It answers only clients pointed at it with Azure-shaped env values, which volli-drive supplies to its own instance alone; nothing ships in the product or appears in its model picker, so it is documented rather than gated on `VOLLI_HARNESS`. Never point real configs at it.

**Stop ownership (final round):** processes are claimed by recorded identity only (pid + start time); a group is claimed only while its recorded leader is still running, and the supervisor records the instance's processes as they appear so an orphaned helper is reaped by its own identity, never by a group number that could be reused.

Files: `apps/desktop/e2e/volli-drive/{cli.mjs,supervisor.mjs,lib/core.mjs,lib/protocol.mjs,lib/fixtures.mjs,lib/fake-provider.mjs,lib/sshd-fixture.mjs}` plus `node --test` suites for core (14), the fake provider (14) and the sshd fixture (1). App change: `apps/desktop/src/main/harness/` (guard + file-backed ports) and four guarded lines in `index.ts`.

## The keychain guarantee, and how it is proven without touching the keychain

**Mechanism** (`apps/desktop/src/main/harness/keychain-guard.ts`), inert unless `VOLLI_HARNESS=1`:

1. First statement after main's imports: `installHarnessGuard({ env, app, safeStorage })`.
   - unset/empty → returns `{active:false}` and touches nothing (proven with a Proxy that fails on any property access to `app` or `safeStorage`);
   - any value other than `1`, or `1` without an absolute `VOLLI_HARNESS_DIR` → refuse to boot (exit 86): a typo never falls back to the keychain.
2. Every `safeStorage` method (the 8 Electron documents, plus any other function found on the object or its prototypes) is replaced via `defineProperty` with a trap that records the call (`keychain-violations.jsonl`, stderr), throws `HarnessKeychainViolation`, and schedules `app.exit(86)` — so a caller that swallows the throw (the legacy migration's `keychainAnswers`) still fails the run. If any trap does not take (a frozen/non-configurable property), boot is refused.
3. The keychain-backed ports are replaced: Session secrets seal with host-core's `fileSecretKey`, the credential inventory with `fileCredentialKeyring` — per-instance random keys created lazily under `<VOLLI_HARNESS_DIR>/keys/` (0700/0600). The legacy safeStorage migration is skipped.
4. Chromium gets `--use-mock-keychain --password-store=basic` both from argv (volli-drive) and `appendSwitch` (main).
5. `<VOLLI_HARNESS_DIR>/harness-guard.json` announces marker, pid, trapped methods, switches and key paths.

**Proof, in order, before and during every launch:**

| Layer | What | Where |
|---|---|---|
| Unit | 19 tests: off = untouched; refusal on bad values; all methods trapped; real method never reached; swallowed throw still exits 86; one exit however many calls; switches; guard record (0600) and keys dir (0700); unknown/inherited methods trapped; sink failure still throws; non-replaceable property refuses boot; file ports seal/open with a per-instance key no other instance can open | `keychain-guard.test.ts` |
| Wiring (static) | the guard is the first statement after imports; `safeStorage` appears in index.ts only at the import, the guard, `observeKeychainUse` (a forwarding wrapper that is never called in harness mode) and the keyring fallback; every `keychainSecretCodec(` is `harnessPorts?.secretKey ?? …`; the migration is gated | `keychain-guard-wiring.test.ts` |
| Bundle (static, pre-launch) | `dist-electron/main.cjs` carries the marker, `installHarnessGuard` and `use-mock-keychain`; `volli-drive doctor` with no id reports it and that the guard source is not newer than the bundle | `core.mjs bundleCarriesGuard`, `cli.mjs preflight` |
| Live (before fixture or any command) | `app.evaluate` reads (never calls) each `safeStorage` method and checks the trap symbol; guard-record pid = Electron pid; `VOLLI_HARNESS=1`; switches present. Any miss → the instance is stopped, evidence kept | `supervisor.mjs boot`, `doctor` |
| Run | violations file empty, exit code ≠ 86, recorded in `manifest.json` | `stop` / `finalize` |

No `security` command, keychain query or deliberate trap trip was run on this machine. A **live trip test** (call a trapped method in a real instance and assert exit 86 + violation record) is the one remaining proof; it is safe by construction (the trap check precedes the call), but it belongs on a macOS CI runner, not here — see Decisions.

Other keychain-adjacent paths closed by the environment: `gh` (token in keychain) → refusing shim first on PATH; git → `GIT_CONFIG_NOSYSTEM=1` (Xcode's system config names `osxkeychain`) and a scratch global config with `gpgsign=false`; ssh → no `SSH_AUTH_SOCK`; Pi → `PI_CODING_AGENT_DIR` in scratch; cookie encryption is off (no fuses). Electron's `app.getPath("home")` ignores `$HOME` on macOS; in harness mode the app never reads it: `harness/containment.ts` refuses to boot unless every home-derived path (HOME, `VOLLI_AGENT_HOME`, worktree home, Pi dir, DB, XDG, ZDOTDIR, git global config, `--user-data-dir`) resolves inside `VOLLI_HARNESS_SCRATCH`, and index.ts then uses the contained agent home for the harness registry, skills, CLI link and `.zprofile`. `shell.openExternal`/`openPath`/`showItemInFolder`/`trashItem` become recorders (`harness/shell-recorder.ts`). Fixture repos are scratch-created with a local bare `origin`, so no git credential is ever asked for.

## Measured (this Mac, M-series, dev build, fake model)

| | |
|---|---|
| `pnpm run build` | ~15 s |
| `launch` → ready (CLI wall) | 9.9–16.0 s over 4 launches (Electron spawn → first window 7.5–12.3 s incl. quiet-bundle clone; guard verify 0.1–0.3 s; fixture seed 2.1–2.4 s, `empty` 0.3 s). Two instances ran side by side |
| `snapshot` / `find` round trip | ~0.4–0.6 s (CLI process start dominates; the snapshot itself is ~50–100 ms) |
| `act` (click/type/press) | action 14–238 ms (median ~50) + 250 ms settle + fresh snapshot ≈ 0.6–1.3 s wall |
| fake turn (send → reply visible) | < 0.3 s after Enter |
| `screenshot` | ~0.2 s |
| `stop` | ~0.6 s, graceful close, 0 stragglers |
| Memory | 240–700 MB working set across 4 processes (at ready ~600–700 MB; after a turn and settling 275–475 MB: Browser 104–166, GPU 58–99, Utility 25–34, Renderer 88–176 MB) |

## Open questions — what the spike found

- **Dev build vs packed.** The fast loop is `pnpm run build` (15 s) + the built `dist-electron/` on the dev Electron binary: production renderer bundle, real main, ~10 s to ready. Packed mode is **disabled** (final round): a packaged binary's bundle cannot be validated before it runs, so the CLI refuses `--build packed`/`--app`, one gate (`assertLaunchable`) guards every launch path, and the app refuses harness mode when packaged. Re-enabling it is VC-705. HMR (`ELECTRON_RENDERER_URL` + Vite) is deliberately off: smoke-kit strips it, and a harness that drives a different renderer than the one shipped proves less. Recommendation: dev-built by default, packed in CI release lanes.
- **macOS visibility.** smoke-kit's quiet mode is enough: an APFS-cloned shadow `.app` with `LSUIElement=true` (accessory from birth, no Dock flash) plus `VOLLI_QUIET_WINDOWS=1` (windows never become key). Playwright input is CDP-synthetic, so the person's pointer and keyboard are never used. No offscreen window or separate Space needed; screenshots come from the compositor regardless of visibility.
- **Keychain-free proof.** See above: unit + static wiring + bundle + live trap check; the trip test goes to CI.
- **Remote-host flows.** The unprivileged localhost sshd fixture works without Remote Login (`docs/research/volli-drive-sshd-fixture.md`). VC-700 now supports macOS managed installation. VC-718's `launch --remote-acceptance` explicitly carries `cloud` and matching `VOLLI_HOSTD_DEV_TARBALLS` into the guarded app, supplies a scratch SSH config through a real-SSH wrapper, and uses the actual managed installer and daemon. It refuses local runs because hostd installs in the passwd home and manages its launchd job. Only disposable macOS CI runners may run it. No foreground hostd substitute, lab fake or injected link is used. The standard fixture and launch environment remain unchanged.
- **Product angle.** The pieces that are Volli-specific are small (guard env, fixtures, `state`); the supervisor, ref model, evidence layout and registry are generic. Volli could offer the same verbs over its Browser Tab plane for a user's *own* Electron/web app.

## Not done in the spike (sketches)

- **MCP wrapper.** One stdio server exposing `drive_launch/doctor/snapshot/act/wait/screenshot/state/stop`, each a thin call to the same supervisor socket (`lib/protocol.mjs`), returning the snapshot text and image paths. Skipped: the CLI already gives agents the verbs, and an MCP server is one more process to own.
- **`state` over the WS door (VC-663)** as a second client, and **trace follow (VC-699)**: `logs --trace` already reads `logs/structured/*.jsonl` when present.
- **Fixture `chat`** (a Session with fake-agent history at launch) — trivial now that the fake provider exists: drive one turn in `seedFixture`.
- Terminal Sessions: the instance `$SHELL` is the fake login shell used for the PATH probe; terminal/harness CLIs need fake-harness wiring before they are drivable.
