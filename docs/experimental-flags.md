# Experimental flags

Unfinished product work ships dark on `main`. The pure registry is
`packages/shared/src/experiments.ts`; it is the only source of ids, labels,
warning copy, defaults, and `host | device` scope. The first id is `cloud`,
**off by default**. Existing dev-only Code Mode and MCP configs are separate.

## Consumer API

- Main code gates new work with `isExperimentEnabled("cloud")` from
  `apps/desktop/src/main/experiments.ts`. Check before starting cloud work.
- The composition root installs one `ExperimentalSettings` after opening the
  database, before feature consumers run. It has no Electron dependency and can
  later be hosted by `hostd`.
- Clients read `settings.experiments` through session-rpc. Each entry carries
  `{ enabled, source }`, where source is `default`, `storage`, or `environment`.
- Clients write only `settings.setExperiment({ id: "cloud", enabled: true })`.
  It returns the effective projection after persistence, not a raw storage blob.
- Host implementations can call `readExperiments()` / `setExperiment(id, enabled)`.
  Unknown ids fail type-checking and runtime validation.

## Storage and boot

`volli:experimental-flags` is one JSON object (for example `{"cloud":true}`)
under `app_state` in today's `volli.db`. **Classification: host-level settings,
not workspace data**; the future host-level settings database owns this key.
No schema migration is needed. Device-scoped flags are device-local, never
portable workspace preferences; the registry carries each flag's scope.

`VOLLI_EXPERIMENTAL=cloud` opts in at boot in both dev and packaged builds.
The value is a comma-separated list of ids, trimmed and matched case-insensitively
(`Cloud` enables `cloud`); duplicate ids are accepted. Unknown or retired env ids
are ignored and logged together in one warning at boot, never a launch failure.
For example, `VOLLI_EXPERIMENTAL=cloud,retired-flag` enables cloud and warns about
`retired-flag`. Code APIs and RPC commands still reject unknown ids strictly.
Only listed registered flags are overridden; an empty or absent variable leaves
storage/defaults in effect. The environment
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

Settings → Experimental is built here. Moving auto-model controls from Models
onto this page remains VC-518's work.
