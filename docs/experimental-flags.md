# Experimental flags

Unfinished product work ships dark on `main`. The pure registry is
`packages/shared/src/experiments.ts`; it is the only source of ids, labels,
warning copy, defaults, build availability, and `host | device` scope. The first id is `cloud`,
**off by default**. Existing dev-only Code Mode and MCP configs are separate.

## Consumer API

- Main code gates new work with `isExperimentEnabled("cloud")` from
  `apps/desktop/src/main/experiments.ts`. Check before starting cloud work.
- The composition root installs one `ExperimentalSettings` after opening the
  database, before feature consumers run. It has no Electron dependency.
  Existing host integrations are maintenance-only; new cloud work follows
  [Workspace authority and offline](BOUNDARIES.md#workspace-authority-and-offline).
- Clients read `settings.experiments` through session-rpc. Each entry carries
  `{ enabled, source, visible? }`, where source is `default`, `storage`, or `environment`.
  `visible: false` hides the switch; no visible experiments means no Experimental
  category. Older hosts omit `visible`, which means visible.
- Clients write only `settings.setExperiment({ id: "cloud", enabled: true })`.
  It returns the effective projection after persistence, not a raw storage blob.
- Host implementations can call `readExperiments()` / `setExperiment(id, enabled)`.
  Unknown ids fail type-checking and runtime validation.

## Storage and boot

`volli:experimental-flags` is one JSON object (for example `{"cloud":true}`)
under `app_state` in today's `volli.db`. **Classification: host-level settings,
not Workspace data** in the compatibility path. The launch switch remains
machine-local; this classification is not a plan for a new host authority.
No schema migration is needed. Device-scoped flags are device-local, never
portable workspace preferences; the registry carries each flag's scope.

Cloud's experimental switch is available in dev and canary builds. Stable
builds hide it and ignore stored intent. Only a fresh backend preview grant
for the signed-in account enables cloud for a stable launch; the Account
pane is available for enrollment and a waitlist message only when the host
has a configured sign-in provider and backend. The host advertises that
capability as `cloud.enrollment`; a hidden switch is not evidence of it. Verification
has a two-second launch deadline: failure or timeout opens the unchanged
local board, never a cached grant. An account check that finishes later may
offer a restart, but never changes stores in a running window. See
`convex/SCHEMA-NOTES.md` for administration and invite codes. The stored flag
is not rewritten, so returning to canary restores it. Build kind comes from
the running version, never the user-selected update channel. On stable,
`source: default` means launch policy, not a persisted opt-in.

`VOLLI_EXPERIMENTAL=cloud` opts in at boot in dev/canary builds only, showing
the environment-locked switch. It never bypasses the stable preview gate.
The value is a comma-separated list of ids, trimmed and matched case-insensitively
(`Cloud` enables `cloud`); duplicate ids are accepted. Unknown or retired env ids
are ignored and logged together in one warning at boot, never a launch failure.
For example, `VOLLI_EXPERIMENTAL=cloud,retired-flag` enables cloud and warns about
`retired-flag`. Code APIs and RPC commands still reject unknown ids strictly.
Only listed registered flags are overridden; an empty or absent variable leaves
build-available storage/defaults in effect. The environment
is captured once, never persisted, and wins over stored `false`. Settings shows
**Set by environment** and disables that toggle. The host also refuses a write
to an environment-controlled flag.

Unknown stored ids from a newer build are ignored on read and preserved on write.
Unreadable JSON or a malformed
known value falls back to that flag's default. Writes go through the shared
SQLite transaction gate; readers see committed settings only. A failed write
leaves the prior value effective. User changes apply to subsequent reader calls;
a consumer that constructs a service only at boot still needs a restart to
reconstruct it.

## Tests

Later desktop suites can import `describeWithExperiment` from
`apps/desktop/src/main/test-helpers/experiments.ts`:

```ts
describeWithExperiment("cloud", () => {
  it("uses the cloud path", () => {
    expect(isExperimentEnabled("cloud")).toBe(true);
  });
});
```

It installs the on state for each serial test and restores the prior reader
on teardown, without editing the environment or database. Keep the existing
flag-off suite alongside it; do not use concurrent tests with this global fixture.

## What `cloud` changes today

- **Commands precedence.** A personal Command (`<userData>/commands`) wins a
  name the project's `.volli/commands` also defines — Volli Cloud's
  personal > project > workspace order. Flag off, the project's copy wins, as
  before. Skills do not move: `.agents/skills` is a repo file, and repo files
  always apply, so a personal Skill (`~/.agents/skills`) adds slugs but never
  replaces the repo's, with the flag on or off; only admin policy can deny a
  repo entry. Every configuration surface declares its levels, merge and order
  in one resolver, `packages/shared/src/config-resolution.ts`; Commands are the
  only surface whose order the flag moves so far. The flag is read at each
  load, so a change applies to the next picker read or Session start.
- **Environment recipe.** A new worktree's setup runs its own `.agents/setup`
  when the checkout has one, with the project's **Then run** command as the
  fallback (never both). It runs with nothing on stdin, under `VOLLI=1`,
  `VOLLI_RUNNER_KIND` (`mac` or `linux`), `VOLLI_PROJECT`, `VOLLI_TICKET`,
  `VOLLI_WORKING_COPY` and `VOLLI_SETUP_REASON`. Each run is recorded beside
  the worktree's first-run markers in `~/.volli/worktree-first-run`. A setup
  that fails blocks every later chat start of that ticket until you choose
  **Retry setup**, **Start anyway** or **Fix with an agent** (a new ticket that
  carries the failure). A terminal runs the same setup in its shell and records
  it, but is not blocked. `.agents/resume` runs before the first chat start
  after Volli starts or the Mac wakes; the start waits up to 10 seconds, then
  lets it finish in the background. Flag off, **Then run** runs exactly as
  before. Code: `packages/host-core/src/worktree/recipe.ts`.

Settings → Experimental exposes the registry-backed flags. With `cloud` off,
no cloud product service or cloud-only UI is enabled. The stable Account
pane is enrollment only.
