# Mac host placement spike: launchd hostd vs Electron-main menu-bar host (VC-691, D-A2)

Owner decision **D-A2** (2026-10-06) chose option (b): Electron main stays the Mac's host and keeps running in a menu-bar mode after quit, and `hostd` is for boxes. The decision was conditional on a spike, because the costs of option (a), a launchd Node `hostd` on the Mac, were inferred rather than tested. The source is the post-M1 architecture review, D-A2, lens A candidate C4 and lens C (`.scratch/arch-review-m1/`).

This document answers the five questions with measurements. It gives a recommendation and outlines the VC-577 brief.

**Baseline.** `main` at `4919c48e8`. macOS 26.5.1 (25F80) on arm64 (MacBookPro17,1). Electron 44.0.0. Node 24.18.0 (Homebrew) and 24.21.0 (`.nvmrc`). The installed `/Applications/Volli Code.app` 0.2.1 is signed with Developer ID, team `Y54F649NH4`, with the hardened runtime.

**Method and safety.** All probes are throwaway code under `.scratch/vc691/`, which is gitignored. They used:

- a temporary keychain (`security create-keychain` in `/tmp`), never the login keychain;
- a temporary `userData` directory, never the real Volli profile;
- one-shot LaunchAgents bootstrapped into `gui/501` from a temp plist, with unique labels (`dev.volli.spike.vc691.*`), each booted out and deleted after its run. `launchctl list` shows none left.

The only real-app process was the installed `Volli Code` binary run with `ELECTRON_RUN_AS_NODE=1`. That mode opens no profile, and it was used only for TCC reads that an existing user grant already covers. All temp directories, the keychain and the Electron copies were removed afterwards.

> **Incident, recorded as evidence (Q1).** One probe tried to *change* the ACL of an existing keychain item, in the temp keychain. It raised a keychain dialog even though the probe had turned user interaction off. The probe was then killed, and `securityd` crashed (`/Library/Logs/DiagnosticReports/securityd-2026-10-06-070458.ips`, `SIGABRT` from an uncaught C++ exception) and restarted. A `securityd` restart re-locks the **login** keychain, so other processes waiting on it now need a person to unlock it. This is noted on VC-691. Two findings come out of it, and both feed the recommendation:
>
> - `SecKeychainSetUserInteractionAllowed(false)` does **not** suppress the change-ACL confirmation.
> - Rewriting a keychain item's ACL is a user-visible event, not something a migration can do silently.

---

## Answers at a glance

| # | Question | Lens A inferred | Measured |
| --- | --- | --- | --- |
| 1 | Keychain | "A launchd Node daemon can't open keychain-sealed secrets." | **It depends on which binary.** A LaunchAgent that runs the **app's own executable** reads and writes the app's items silently. Any *other* binary is refused without the UI (with the UI it would get a prompt). A separate binary can be trusted silently only in **new** items whose ACL names it. Moving an existing item to a new ACL raises a dialog. The launch context (launchd or terminal) made no difference. |
| 2 | TCC | "Needs its own TCC identity." | **Same split.** Run by launchd, the app's own executable has TCC subject `app.volli.desktop`. It and its children (`/bin/ls`) read `~/Desktop` under the app's existing user grant, with no prompt. A bare `node` is its own subject, keyed by path, with no responsible app. Third-party reports, which match this attribution, say such an agent gets a silent `EPERM` in `~/Documents`. |
| 3 | Signing / updates | "Own signing identity and a second updater." | **No second updater** if the host ships inside `Volli Code.app`. But Squirrel.Mac waits only for an `NSRunningApplication`. A `RUN_AS_NODE` or `node` hostd is not one, so the bundle would be swapped under a live hostd. hostd must be drained and stopped around every install. A separate Node needs the same Team ID for library validation (seen failing). |
| 4 | Power | "No power events." | **Events are available, but only through a native helper.** `IORegisterForSystemPower` and the NSWorkspace observers register fine in a LaunchAgent. With no native code, polling `sysctl kern.waketime` works. `NO_POWER_EVENTS` is a choice, not a limit. |
| 5 | Menu-bar mode | "Menu-bar mode is free." | **Close to free.** In the prototype, Electron main, the GPU process and the network service idle at **≈112–133 MB** with no window. CPU stays at ≈0.25% of one core while a streaming turn and a tool call every 5 s continue. Over 4 minutes the turn kept its full rate (9.8 tokens/s of 10) and timers stayed within 6 ms at p95, with no App Nap throttling. Today's quit path needs about ten specific changes (list in Q5). |

**Recommendation: confirm (b).** Two of lens A's specific claims are wrong as stated: the keychain and TCC are not hard walls for a launchd host that runs the app's own executable. Even so, the full cost of (a) is still well above (b), and every remaining item is an engineering cost the menu-bar mode does not have. Details are under [Recommendation](#recommendation).

---

## 1. Keychain

### What Volli stores today

- **Session secrets.** `keychainSecretCodec(safeStorage)` (`apps/desktop/src/main/secrets/codec.ts`) seals `session-secrets.enc` as a `VSC1` envelope. That envelope holds a random AES-256 data key, wrapped by `safeStorage`, plus the GCM ciphertext.
- **Web keys.** The web keys use `keychainCredentialKeyring({ keychain: safeStorage })` the same way.
- **How `safeStorage` works on macOS.** It is Chromium `os_crypt`. The password is a generic-password item with service `"<App> Safe Storage"` and account `"<App> Key"`, so `"Volli Code Safe Storage"` / `"Volli Code Key"`. Sources:
  - [Chromium `keychain_password_mac.mm`](https://github.com/chromium/chromium/blob/main/components/os_crypt/common/keychain_password_mac.mm);
  - Electron's [MAS account-suffix patch](https://github.com/electron/electron/blob/v44.0.0/patches/chromium/feat_ensure_mas_builds_of_the_same_application_can_use_safestorage.patch).

  The item is created by `SecItemAdd` with no access object ([`keychain_v2.mm`](https://github.com/chromium/chromium/blob/main/crypto/apple/keychain_v2.mm)). Its ACL therefore trusts only the creating app.
- **The ciphertext is portable.** It is `"v10" ‖ AES-128-CBC(PBKDF2-HMAC-SHA1(password, "saltysalt", 1003, 16), IV = 16×0x20)`. Any process that can read the password can open a `VSC1` envelope in plain Node. Dyad reimplements this byte-for-byte to recover its own secrets ([`safe_storage_legacy.ts`](https://github.com/dyad-sh/dyad/blob/112cf512/src/main/safe_storage_legacy.ts)). So the format is not the obstacle. The obstacle is **the keychain ACL on the password item**.
- **hostd today.** `fileSecretKey` refuses `VSC1` with `other-adapter` (`packages/host-core/src/secrets/file-key.ts:162-167`).

### Probe

`.scratch/vc691/kc/kc.c` is an N-API addon over Security.framework. It always targets an explicit keychain path (`kSecUseKeychain` / `kSecMatchSearchList`), never the search list, and it calls `SecKeychainSetUserInteractionAllowed(false)` at load. Any read that would prompt therefore returns an error instead.

- **Creator.** A full Electron main process (not `RUN_AS_NODE`) loads the addon. It creates the item exactly as Chromium does (`SecItemAdd`, default ACL), plus a second item with an explicit ACL naming extra trusted apps (`SecAccessCreate`).
- **Readers.** Each reader runs both from a terminal and as a LaunchAgent in `gui/501`.

```sh
security create-keychain -p vc691-pass /tmp/vc691-kc.XXXX/vc691-spike.keychain-db   # search list unchanged on 26.5.1
security unlock-keychain -p vc691-pass "$KC"
VC691_TRUST=/opt/homebrew/bin/node kc/run-create.sh            # Electron main creates both items
security dump-keychain -a "$KC"                                # ACL only, no secret
launchd/agent.sh kc 60 out -- /bin/bash kc/run-readers.sh      # throwaway LaunchAgent, removed after
```

### Results

The `dump-keychain -a` output for the item created like `safeStorage`: `decrypt … applications (1): …/Electron.app requirement: cdhash H"3c14…"`. The `change_acl` entry has `applications (0)`. No partition-ID entry was written for an ad-hoc creator.

| Reader (identical results from terminal and LaunchAgent) | `safeStorage`-like item (default ACL) | Item whose ACL also names the reader |
| --- | --- | --- |
| The app's own executable, `ELECTRON_RUN_AS_NODE=1` | **0, read OK, no prompt** | 0 |
| Electron Helper in the same bundle, with a different designated requirement (DR) | −25293 (refused without UI; with UI, a prompt) | — |
| Homebrew `node` (ad-hoc signed) | −25293 | **0** when named in the ACL |
| A bundled `hostd/bin/node`, same signer, different identifier | −25293 | **0** when named in the ACL |

`errSecAuthFailed` (−25293) is the status this keychain returned with the UI suppressed. The only variable between the two columns is the ACL, so it means the read would have prompted.

**Updates keep access when the DR is stable.** The creator and a separately signed "hostd" were ad-hoc signed with explicit DRs, `identifier "dev.volli.spike.app"` and `identifier "dev.volli.spike.hostd"`. That stands in for Developer ID, whose DR is `identifier "app.volli.desktop" and anchor apple generic and … leaf[subject.OU] = Y54F649NH4` (from `codesign -d -r-` on the installed app).

- **Simulated update.** A resource was added and both binaries re-signed. The cdhashes changed and the DRs did not. Both readers kept silent access.
- **Control.** Re-signing the app plain ad-hoc changes its DR to a cdhash. It then lost access to its own items: −25293 for every reader (`.scratch/vc691/evidence/q1-stable-dr.txt`).

The same rule explains why unsigned dev builds and the packaged app already cannot share keychain items.

**Changing an existing item's ACL prompts.** The creator tried to add a hostd binary to the decrypt ACL of its own `safeStorage`-like item (`SecKeychainItemSetAccess`), with user interaction off. `securityd` logged:

```
securityd [com.apple.securityd:kcacl] displaying keychain prompt for …/Signed.app(40353);
  ACL: <AclValidationContext(action:65536) … KeychainPromptAclSubject … desc:Volli Spike Safe Storage …>
```

A SecurityAgent dialog appeared (see the incident note above). **Every existing install's `Volli Code Safe Storage` item can therefore be shared with a separately signed hostd only at the cost of one dialog per item.** The silent route is to *create a new item* whose ACL names both binaries at creation (shown above: creation with a custom ACL raises no prompt), then re-seal under it. The app can do that, because it can still read the old key.

### Answer

A LaunchAgent Node process can read and write keychain items without a prompt **when its process is the binary the item's ACL trusts**. The cheapest such binary is the app's own executable under `ELECTRON_RUN_AS_NODE` (call it option a′). A Node addon is still required, because Node has no keychain API. Spawning `/usr/bin/security` would prompt too: its identity is `apple-tool:`, not the app.

A separately signed Node hostd needs three things:

1. a new keychain item created with an ACL naming the app's and hostd's DRs;
2. a re-seal migration run by the app;
3. a host-core adapter that accepts `VSC1`, or its successor.

Lens A's "can't open" is wrong. Lens A's "needs new keychain work" is right.

## 2. TCC

### Probe

Only FDA-protected `~/Library/Safari` was touched by binaries without a grant. FDA (`kTCCServiceSystemPolicyAllFiles`) is never prompted for. `~/Desktop` was read **only** by the installed `Volli Code` binary, whose bundle id already holds a user-granted `kTCCServiceSystemPolicyDesktopFolder` decision. Entries were counted, never named. `tccd` attribution comes from `log show --predicate 'subsystem == "com.apple.TCC"'` (`.scratch/vc691/evidence/q2-*`).

| Process | Launched by | TCC subject (`AUTHREQ_SUBJECT`) | Responsible process |
| --- | --- | --- | --- |
| Homebrew `node` | this Session's shell (a Volli PTY) | `app.volli.desktop` | `/Applications/Volli Code.app/…/Volli Code` |
| Homebrew `node` | LaunchAgent | `/opt/homebrew/Cellar/node@24/24.18.0/bin/node` (keyed by path) | none |
| Electron copy, `RUN_AS_NODE` | LaunchAgent | `com.github.Electron` (its bundle id) | itself |
| **Installed `Volli Code`, `RUN_AS_NODE`** | LaunchAgent (ppid 1) | **`app.volli.desktop`**. `DesktopFolder` gave `authValue=2 authReason=2` (allowed, user consent), and `readdir ~/Desktop` returned 8 entries. | itself |
| `/bin/ls`, a child of that process | LaunchAgent | `app.volli.desktop`, allowed | `app.volli.desktop` |

Over the last three hours, `tccd` answered `app.volli.desktop` for these services:

- `SystemPolicyDesktopFolder` allowed (user consent). The owner's checkout lives under `~/Desktop/code/`, and other Sessions' `node` processes reached it through this grant during the spike;
- `ScreenCapture` and `ListenEvent` allowed;
- `AllFiles` denied by policy;
- `AppBundles` denied.

Today every Session command inherits these through the app's responsibility.

### What would prompt (not triggered)

- **A bare or separately bundled hostd** is its own TCC subject. A plain binary is keyed by path, plus a code requirement for a signed one. A bundled helper is keyed by its own bundle id. The first time it touches `~/Desktop`, `~/Documents`, `~/Downloads` or an external or network volume (`SystemPolicyRemovableVolumes` / `NetworkVolumes`), tccd would ask about **that** subject: "‘volli-hostd’ would like to access files in your Desktop folder". The app's grant does not carry over. Third-party reports say a launchd-spawned process with no responsible GUI app often gets a **silent `EPERM`** rather than a dialog:
  - [LaunchAgent vs Terminal on `~/Documents`, macOS 15.6.1](https://dev.to/vinhnguyenthanhdn/a-launchagent-gets-operation-not-permitted-for-documents-while-terminal-works-2df4);
  - [external `noowners` volumes from launchd](https://captainrandom.co.uk/writing/macos-launchd-tcc/);
  - Claude Code's launchd-reparented background host on macOS 26.3.1: `EPERM` on `~/Documents` despite a bundle-id grant, `"Failed to create Attribution Chain"` ([report](https://www.stepcodex.com/en/issue/bug-bg-pty-host-children-blocked)).

  The spike did not reproduce the silent `EPERM`, because doing so on `~/Desktop` could raise a prompt.
- **Signing and notarization** give a helper a *stable* TCC identity, so grants survive updates; Homebrew `node`'s identifier changes with every build. They do **not** inherit another bundle's grants. Notarization is a Gatekeeper matter and changes nothing in TCC.

### Answer

A LaunchAgent that runs the **app's own executable** gets the app's TCC grants for itself and its children, without prompts. That was measured on `~/Desktop` with this machine's real grant. Any other binary (plain, signed or notarized) is a new TCC client:

- each protected location prompts once, naming the helper, or fails silently with `EPERM` when no attribution chain exists;
- grants must be re-made in System Settings whenever its identity changes.

## 3. Signing and updates

The current posture comes from `apps/desktop/electron-builder.yml` and `build/entitlements.mac.plist`:

- Developer ID Application, hardened runtime, notarized;
- entitlements `cs.allow-jit` and `cs.allow-unsigned-executable-memory`, with no `disable-library-validation`;
- updates by `electron-updater` driving Squirrel.Mac from the `zip` artifact;
- no Electron fuses configured. The `runAsNode` fuse is on: the CLI shim already uses `ELECTRON_RUN_AS_NODE` (`packages/host-core/src/host-profile.ts:48`), and the a′ probes ran through it.

| Host form | Signing and entitlements | Updated by | Notes |
| --- | --- | --- | --- |
| **(b) Electron main** | none new | Squirrel.Mac, as today | ShipIt waits for the `NSRunningApplication` with the app's bundle id, which the menu-bar host is ([ShipIt-main.m](https://github.com/Squirrel/Squirrel.Mac/blob/master/Squirrel/ShipIt-main.m), [#266](https://github.com/Squirrel/Squirrel.Mac/issues/266)). An install still needs the host to quit, so "install when idle" is a menu-bar policy. |
| **(a′) app executable + `ELECTRON_RUN_AS_NODE` under launchd** | none new; `runAsNode` must stay enabled (Electron's hardening guidance would turn it off) | Squirrel.Mac (same bundle) | A `RUN_AS_NODE` process is **not** an `NSRunningApplication`, so ShipIt would not wait for it: the bundle is swapped under a live host, and later lazy `require`s and asar reads hit the new version. The app must drain and stop the agent before `quitAndInstall`, then restart it. Real `apps/hostd/dist/hostd.cjs` booted and served under the Electron binary in this mode (`q5-hostd-idle-electron-run-as-node.txt`). |
| **(a) separate bundled Node** | Developer ID, hardened runtime, `allow-jit`. Every dylib and `.node` must carry the **same Team ID**: library validation rejected a mismatched `libnode.137.dylib` (`"mapping process and mapped file (non-platform) have different Team IDs"`). Native modules need a second ABI build: node-pty is rebuilt for Electron today; better-sqlite3 13 is N-API. Notarization covers nested code. | Squirrel.Mac if it lives inside the bundle. A **second updater** only if it lives outside (today's hostd tarball at `/opt/volli-hostd`). | Same ShipIt problem as a′. |

**Registration.** On macOS 13 and later, the supported way to install a per-user agent from inside the bundle is `SMAppService.agent(plistName:)`, with the plist at `Contents/Library/LaunchAgents/` and `BundleProgram` relative to the bundle. Electron exposes it directly: `app.setLoginItemSettings({ type: "agentService", serviceName })` ([`platform_util_mac.mm`](https://github.com/electron/electron/blob/c16c6da2/shell/common/platform_util_mac.mm)). Costs:

- the item appears under **System Settings → General → Login Items & Extensions → Allow in the Background**;
- a "Background Items Added" notification is shown;
- the user can switch it off, so status `requires-approval` is a state the UI must handle.

The ax project's signed-helper PR hit the same constraints, plus one more: no `StandardOutPath` under SMAppService on macOS 14.4 and later ([ax#604](https://github.com/Necmttn/ax/pull/604)). The spike's own agents used `launchctl bootstrap` from a temp plist, which is not a shipping path.

**Answer.** The same Developer ID identity is enough, and no second updater is needed if the host binary ships inside `Volli Code.app`. Electron's updater cannot update a *running* launchd host safely, though. Every install becomes drain → stop the agent → swap → restart. That is lens A's C3 problem, "an upgrade kills turns", with an extra process to coordinate. A separate Node adds Team-ID-consistent native builds and its own entitlements file.

## 4. Power

- **Today.** Desktop passes `powerMonitor` (`apps/desktop/src/main/index.ts:731`), and hostd passes `NO_POWER_EVENTS` (`packages/host-core/src/ports/power.ts`). On macOS, `powerMonitor`'s suspend and resume come from Chromium's `PowerMonitorDeviceSource`, which is `IORegisterForSystemPower` on IOPMrootDomain ([source](https://github.com/chromium/chromium/blob/main/base/power_monitor/power_monitor_device_source_mac.mm)). That follows Apple [QA1340](https://developer.apple.com/library/archive/qa/qa1340/_index.html). `lock-screen` and `unlock-screen` are distributed notifications.
- **Probe.** `.scratch/vc691/power/power.swift` registers `IORegisterForSystemPower`, the NSWorkspace sleep/wake/session observers and the `com.apple.screenIsLocked`/`Unlocked` distributed notifications. Run as a LaunchAgent, it printed `IORegisterForSystemPower:ok` and `observers:registered` (`q4-power-launchd.jsonl`). The machine was not put to sleep, so delivery is from the API contract (QA1340: IOKit registration works in any process with a run loop), not observed.
- **Without native code.** libuv's `hrtime` on Darwin is `mach_continuous_time` ([darwin.c](https://github.com/libuv/libuv/blob/v1.x/src/unix/darwin.c)), so Node's clocks keep counting across sleep, as `power.ts` says. A timer gap alone cannot tell sleep from throttling. `sysctl -n kern.sleeptime kern.waketime` (both readable unprivileged; here `waketime` was `Mon Oct 5 13:06:12 2026`) gives an exact sleep/wake pair to poll whenever a gap is seen.
- **Electron APIs.** `RUN_AS_NODE` disables them, so a′ has no `powerMonitor` either.
- **Keeping the machine awake.** Neither host prevents idle sleep today: nothing calls `powerSaveBlocker` or `IOPMAssertion`. In the prototype, `powerSaveBlocker.start("prevent-app-suspension")` showed in `pmset -g assertions` as `NoIdleSleepAssertion named: "Electron"`. A launchd host would need `IOPMAssertionCreateWithName` through the same helper, or `caffeinate -i -w <pid>`.

**Answer.** A LaunchAgent can get sleep/wake notifications. It needs a native helper (a child process emitting JSON lines, like the probe, or an N-API addon with its own CFRunLoop thread), or it polls `kern.waketime` with no native code. It does not have to fly blind, but it is another native component to sign, ship and test. Electron main gets all of this from `powerMonitor` today.

## 5. Menu-bar mode, the (b) side

### Prototype

`.scratch/vc691/menubar/main.js`, run with Electron 44 and a temp `userData`.

- **Setup.** A Tray titled `V691` and a BrowserWindow (hidden, but with its renderer live). A "Session turn" runs in main: a token appended to a durable file every 100 ms, and a `/bin/sh` tool call every 5 s.
- **Phase A, 60 s.** The window is open.
- **The ⌘Q simulation.** `app.quit()` is called. `before-quit` sees a live turn, calls `preventDefault()`, destroys the windows and calls `app.dock.hide()`.
- **Phase B, 120 s.** Menu-bar mode.
- **Phase C, 120 s.** Menu-bar mode plus `powerSaveBlocker("prevent-app-suspension")`.

Two sources were sampled every 5 s: `app.getAppMetrics()`, and `ps` over the whole process tree (RSS, and cumulative CPU time for CPU %).

| Phase | Processes | Tree RSS, `ps` avg (min–max) | Per type (`getAppMetrics`, last sample) | CPU, one core | Turn rate | Timer late p50/p95/max |
| --- | --- | --- | --- | --- | --- | --- |
| A, window open | 4 | 267 MB (174–314) | Browser 80, GPU 35, Network 25, Tab 41 | 0.34% | 583 tokens / 60 s | 2.0 / 8.6 / 13.8 ms |
| B, menu bar | 3 | **133 MB (111–144)** | Browser 56, GPU 33, Network 23 | **0.26%** | 1,172 / 120 s (9.77/s) | 2.1 / 6.2 / 13.9 ms |
| C, menu bar + blocker | 3 | 115 MB (110–120) | Browser 57, GPU 30, Network 22 | 0.24% | 1,173 / 120 s (9.78/s) | 1.9 / 3.5 / 106.6 ms |

- **No throttling seen.** No App Nap throttling showed in four minutes of dock-hidden, windowless running: the turn kept 98% of its nominal rate. The blocker is optional for throughput. It is a deliberate choice about idle *system* sleep.
- **Comparison with hostd.** The real `apps/hostd` (`vp pack`), idle on an empty database with temp `HOME`, data and Pi dirs:
  - Node 24.21: **64 MB** average RSS (126 MB peak at boot), 0 s of CPU in 60 s;
  - under the Electron binary with `RUN_AS_NODE`: 124 MB, 0.24 s in 60 s.

  The prototype's main process holds no host-core, so the honest estimate is (b)'s idle **≈ hostd's heap + ~55 MB** (GPU 30–33 plus network service 22–23). That is roughly 50 MB more than a′ while no window is open. It is less while a window is open, because (a) would then run the app and the host side by side.
- **The real app today.** For reference, the real app's main process is 524 MB RSS after 2 days 6 hours with many Sessions. That is the host-core and runtime heap, which either option carries.

### What today's quit path must change

The current path:

- `window-all-closed` already keeps the process alive on darwin (`index.ts:2751`).
- ⌘Q runs `registerAcceptedQuitCoordinator` (`quit-gate.ts`). Its `prepareQuit` calls `prepareHostQuit` → `prepareDesktopQuit` (`host-runtime.ts:34`), then `hostCore.stop("quit")` with `stopPolicy: "desktop-quit"` (VC-627, `host-lifecycle.ts:74`), then `app.exit(0)`.

The changes:

1. **A menu-bar branch ahead of the stop.** When the host has live work (running turns, background shells, armed Runs due soon), ⌘Q becomes "close windows → `app.dock.hide()` → keep the Tray". Use `refuseQuit(event)`, never a bare `preventDefault`, so the coordinator and `prepareTerminalQuit` behind it stand down. Entering menu-bar mode is **not** a host stop: `HostLifecycle.stop` is not called, and the lifecycle needs no new state.
2. **`prepareDesktopQuit` stops Automations unconditionally,** even on a refused quit ("including the two unconditional stops on a refused attempt"). In menu-bar mode, the stop must move behind the decision, or armed Runs die on every ⌘Q.
3. **Terminals.** `prepareTerminalQuit` kills every PTY on quit, and a window close kills the PTYs its webContents owns (`index.ts:511-556`). Until terminal streams are host-owned (VC-568), menu-bar mode keeps today's busy-terminal confirm for terminals. It covers structured turns only.
4. **The unsaved-drafts confirm** stays as it is: closing the window destroys the renderer either way.
5. **A real quit** comes from Tray → "Quit Volli", or ⌘Q with no live work. It keeps the existing path. With live turns it asks, or waits for turns to finish (D-C2's "wait, then hand back" becomes "wait, then exit"). Because a full quit is now rare and unhurried, consider switching it from `desktop-quit` to `drain-and-close`. Today desktop exits with SQLite open and skips `drain-detached`.
6. **Updates.** `quitAndInstall` closes windows *before* `before-quit`. The menu-bar branch must stand down when `updateInstallQuitInFlight()`. The update offer should move to "install when the host is idle" in the Tray (lens A C3).
7. **Getting the window back.** Handle Dock and Spotlight relaunch, `second-instance` (`index.ts:356` returns early when there is no window) and notification clicks with no window: recreate the window and call `app.dock.show()`. `activate` already recreates the window (`index.ts:2738`) but never shows the dock.
8. **Renderer-owned work must move to the host first.** Queued follow-ups are released by the renderer (`session-presentation/src/client.ts:1187-1236`, lens C C1). With no window they never release. This is a **prerequisite** for menu-bar mode, not a nice-to-have. Attention focus (`focusedSessionIds`) must treat "no window" as "nothing focused".
9. **Sleep policy.** Optionally hold `powerSaveBlocker("prevent-app-suspension")` while turns run. It keeps the Mac out of idle sleep (it appeared as `NoIdleSleepAssertion`). Lid-close sleep still happens, under either option.
10. **Tests.** Add quit-gate unit cases for the new branch and the update and second-instance interactions, and a smoke for "⌘Q with a live turn → windowless host → reopen sees the finished turn". The native-window quiet policy (`sealQuietAppActivation`) must cover the dock-hidden state.

Accepted costs of (b), unchanged by the spike:

- an app crash kills local turns;
- logout or reboot ends the host, and boot recovery already marks those turns `interrupted`;
- Electron main never shrinks to window-only.

---

## Recommendation

**Confirm (b): Electron main is the Mac's host, with a menu-bar mode after quit, and hostd is for boxes.**

The spike corrects lens A in two places. Neither changes the decision.

- **The keychain and TCC are not walls for a launchd host that runs the app's own executable (a′).** It reads the app's items and inherits the app's TCC grants silently. A separately signed Node hostd does pay both costs: a new ACL'd keychain item, a re-seal migration that cannot silently rewrite existing items, and its own TCC identity, with prompts or silent `EPERM` in `~/Desktop`, which is where this owner's repos live.
- **Power is available through a native helper or `kern.waketime`.** `NO_POWER_EVENTS` is not forced.

Even the cheapest form, a′, still costs all of this, which (b) does not:

1. A Node keychain addon and a power helper, both signed and shipped (Q1, Q4).
2. SMAppService registration and a "requires approval" UX in Login Items (Q3).
3. Drain → stop → swap → restart around every Squirrel install, because ShipIt does not see the host (Q3).
4. The desktop talks to its own Mac's host over the loopback protocol, so every M2 area must be routed before flag-on, along with the client-local store split, the profile-lock handoff and flag-off semantics (D-C2).
5. Losing the native `WebContentsView` browser locally: Decided 2's Chromium parity bar applies to the local host too.
6. Keeping `runAsNode` enabled as a permanent part of the security posture.

What it buys: turns survive an app *crash*, and a single host binary layout. That benefit is real but narrow for one owner on one Mac.

The menu-bar mode measured at ≈0.25% of one core and ≈55 MB of helper overhead over a headless host. The turn kept its full rate with no window and no dock icon. Its quit-path changes are bounded and local to `apps/desktop/src/main`. One of them, the host-owned follow-up queue, is needed for boxes anyway.

**Revisit trigger.** Re-open D-A2 toward **a′**, not toward a separately signed Node hostd, if app-crash-proof local turns become a measured requirement. The spike shows a′ is technically viable: real `hostd.cjs` served under the Electron binary in `RUN_AS_NODE` mode. Its costs are listed above.

## VC-577 brief outline (for option b)

The title becomes something like "Volli Cloud: menu-bar host — Electron main keeps hosting after quit; the desktop attaches to it in-process".

1. **Goal.** With the `cloud` flag on, ⌘Q with live host work closes the windows and keeps Electron main running as the Mac's host, with a menu-bar Tray. Turns, Automations and the agent socket continue. Reopening the app reattaches the window to the same in-process host. With the flag off, the app behaves exactly as today.
2. **Scope.**
   - The menu-bar quit branch and the real-quit path: the ten changes in Q5, items 1–7 and 9.
   - Tray UI: running count, "Open Volli", "Quit Volli" with the live-work confirm, "Install update when idle".
   - The no-window attention rule.
   - The `drain-and-close` choice for the full quit.
   - The client-local store move (VC-574 E6/E9 and T30 receipts) **only if** M2 routes the desktop through the router link in-process. Under (b) the host still owns `volli.db`, so this shrinks to the inventory plus receipts.
3. **Prerequisites.** Lens C C1, the host-owned follow-up queue. The host must be the sole owner of turn-end release before any window can be absent.
4. **Out of scope.**
   - launchd, SMAppService, a native keychain addon, a power helper and a second updater (all a′ material, recorded here).
   - Terminal persistence without a window (VC-568).
   - The remote browser parity bar (VC-571/VC-619). The local WCV stays.
5. **Flag-off proof.** Core e2e unchanged, plus quit-gate unit tests showing that with the flag off every branch is today's.
6. **Contract and tests.**
   - Unit tests: the quit decision table (live work × unsaved drafts × busy terminals × update-in-flight × flag), `refuseQuit` propagation, the Automations stop ordering, and `second-instance`/`activate` with no window.
   - A smoke: ⌘Q mid-turn → the process stays, the dock is hidden, the Tray is present → the turn completes → reopen → the transcript shows the completed turn, with no `interrupted`.
   - A measurement, re-run on the real app: idle RSS and CPU in menu-bar mode. Budgets from this spike: helpers ≤ 60 MB over a headless host, ≤ 0.5% of one core while a turn streams.
7. **Decisions to record in the brief.**
   - Menu-bar residency when idle: stay resident until "Quit", or auto-exit N minutes after the last turn.
   - Whether to hold `prevent-app-suspension` during turns (idle-sleep trade-off).
   - The update-install policy.
   - Whether to register a `mainAppService` login item, so the host is back after a reboot (recovery only; it is not a launchd host).
8. **Dependencies.** D-C2 becomes moot (flag-off is a transport swap in one process). VC-615's "Update host" applies to boxes only.

## Evidence index (`.scratch/vc691/`, local only)

- `kc/kc.c`, `kc/create.js`, `kc/read.js`, `kc/run-*.sh`, `kc/stable-dr.sh`, `kc/trust.js`: keychain probes. Evidence files: `evidence/q1-*.json(l)`, `q1-acl-dump.txt`, `q1-stable-dr.txt`, `q1-stable-dr-acl.txt`, `q1-acl-change-prompt.log`.
- `launchd/agent.sh`: the throwaway LaunchAgent runner (temp plist, `bootstrap gui/$UID`, wait, `bootout`, delete). `evidence/agent-*.launchctl` show `type = LaunchAgent`, `domain = gui/501`.
- `tcc/probe.js`, `tcc/desktop-count.js`, `tcc/desktop-child.js`: TCC probes. Evidence: `evidence/q2-*` (tccd `AUTHREQ_*` lines).
- `power/power.swift`: power probe. Evidence: `evidence/q4-power-launchd.jsonl`.
- `menubar/main.js`, `menubar/run.sh`: the menu-bar prototype. Evidence: `evidence/q5-menubar-summary.jsonl`.
- `hostd/run.sh`: hostd idle measurement. Evidence: `evidence/q5-hostd-idle*.txt`.
