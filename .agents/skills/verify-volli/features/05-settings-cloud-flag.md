# 05 — Settings: toggle the `cloud` experimental flag

## Sub-features
- Settings → **System** group → **Experimental** category (components/settings/settings-groups.tsx:330-343). One switch for each entry in the registry.
- Exactly one flag today: id `cloud`, label `Volli Cloud (unstable)`, description `Unfinished cloud features may change or break.`, default **off**, scope `host` (packages/shared/src/experiments.ts:16-24).
- The write goes through the host (`settings.setExperiment` over session-rpc). No optimistic toggle: the switch shows only what the host returns (components/pages/experimental-settings.tsx:56-74).
- Environment lock: `VOLLI_EXPERIMENTAL=cloud` at boot wins over storage. The row then says **Set by environment** and the switch is disabled (experimental-settings.tsx:90-100; main/experiments.ts:56).

## How to get to it (user POV)
1. Sidebar footer → **Settings** (sidebar/primary-sidebar.tsx:109-116). The category rail (nav `Settings categories`) appears.
2. Click **Experimental**, or type `cloud` into the rail's search box `Search settings` (settings/kit/pref-shell.tsx:127,140-144).
3. The section titled **Experimental** shows the row `Volli Cloud (unstable)` with a switch. Flip it on.
4. Leave (sidebar **Home**, which closes Settings: sidebar/nav-list.tsx:57-64), come back, and the switch is still on.

## Driving it with volli-drive
```
volli-drive launch --fixture basic
volli-drive find vd-xxxx "Settings"              # sidebar button (also matches other text; take role=button)
volli-drive act vd-xxxx --gen N --ref eA --kind click
volli-drive find vd-xxxx "Experimental"          # button in navigation "Settings categories"
volli-drive act vd-xxxx --gen N --ref eB --kind click
volli-drive find vd-xxxx "Volli Cloud (unstable)" # role=switch, aria-label = label (experimental-settings.tsx:95-101)
volli-drive act vd-xxxx --gen N --ref eC --kind click
volli-drive wait vd-xxxx --text "Volli Cloud (unstable)"
volli-drive snapshot vd-xxxx                      # switch now [checked]
volli-drive screenshot vd-xxxx --name cloud-on
# persistence across a remount
volli-drive find vd-xxxx "Home"; volli-drive act … --kind click     # closes Settings
# reopen Settings → Experimental, and re-check the switch state
```
- Another way in, from a chat composer: type `/settings` and press ↵ (shared/src/composer-verb.ts; e2e/composer-verbs-smoke.mjs:206-220).

## End state that proves it
- Visible: the `switch "Volli Cloud (unstable)"` is checked (Radix sets `aria-checked="true"`, ui/switch.tsx). There's no error toast `Couldn't save experimental settings…`, and no `Set by environment` text.
- SQL: one JSON row in `app_state` (table at migrations.ts:136-140; key at main/experiments.ts:16). No row exists until the first write.
```
volli-drive state vd-xxxx sql "SELECT value, updated_at FROM app_state WHERE key='volli:experimental-flags'"
# before any toggle: no row     after on: {"cloud":true}     after off again: {"cloud":false}
```
- Turn it off again and re-run the query. The value should flip to `{"cloud":false}` and `updated_at` should advance (shared/src/experiments.ts:91-99 rewrites the whole object).
- CLI: there is no `volli` verb for experiments. UNVERIFIED: whether any `state cli` command exposes them. Use SQL.

## Gotchas
- Don't launch with `VOLLI_EXPERIMENTAL` in the environment. Its value wins, disables the switch, and makes the host refuse the write (`Experiment is set by environment`). Check `volli-drive doctor` or `logs` if the switch is disabled. A boot log line `[volli] Ignoring unknown VOLLI_EXPERIMENTAL ids` means a stray value (main/experiments.ts:34-37).
- While a save is in flight the switch is disabled (`busy`). Snapshot again after the click before asserting.
- No consumer reacts yet. In the desktop app, only the Settings page reads the flag: `isExperimentEnabled("cloud")` has no callers outside main/experiments.ts. So there is nothing else to see change. docs/experimental-flags.md also notes that services built at boot need a restart.
- `find "Settings"` matches several nodes (the button, nav `Settings categories`, the search box). Act on the sidebar `button`.
- AGENTS.md "UI copy" rule: the description line under the label is the registry's own text. It isn't an error or a notice.
