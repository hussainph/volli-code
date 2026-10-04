# @volli/host-core

The host's services, composed without Electron. Volli Cloud
([ruling](../../docs/plans/volli-cloud.md)) runs one host program everywhere:
Electron main today, `apps/hostd` next. Both call `createHostCore` and wire
what it returns. Electron main keeps only window-only work.

```ts
import { createHostCore, throwTransactionViolation } from "@volli/host-core";

const host = createHostCore(
  { log: console }, // ports: what host-core asks of its process
  {
    // options: how this host behaves
    dataDir: "/var/lib/volli",
    onTransactionViolation: throwTransactionViolation,
    devDiagnostics: false,
  },
);
if (!host.database.ok) console.error(host.database.error);
```

## Rules

- **No `electron`, directly or through a relative import.**
  `node scripts/check-host-electron-imports.mjs` gates every `packages/*`.
- **Node only, and it runs on Linux.** `Test (packages)` runs this package's
  `test:coverage` under plain Node in CI's Linux host lane.
- **Ports in, services out.** `createHostCore(ports, options)` returns
  services. It never reaches for a global the host owns.
  - **Options** are policy: data directory, overrides, handler choices. Policy
    has no defaults; every host states it. `userData` is the `dataDir`
    option, and `app.isPackaged` decisions are options.
  - **Ports** are what host-core asks its process to do: log, and (in later
    slices) broadcast to windows or deliver a notification. Desktop passes
    Electron-backed ports; `hostd` passes its own.
- **Composition stays thin in the host.** `apps/desktop/src/main/index.ts`
  resolves Electron facts (`app.getPath("userData")`, `app.isPackaged`,
  `VOLLI_DB_PATH` in dev), calls `createHostCore`, and wires the result
  exactly as it wired the inline construction before.

## What is here

| Path                     | Exports                                                                                                                     | Moved in |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------- | -------- |
| `src/index.ts`           | `createHostCore`, `defaultDatabasePath`, `DbHandle`, the guard handlers                                                     | VC-553   |
| `src/db/`                | `@volli/host-core/db` (`openVolliDb`), `@volli/host-core/db/<file>` (migrations, repos, `transaction-gate`, `test-helpers`) | VC-553   |
| `src/db-open-failure.ts` | `DbOpenFailure` (typed, on `HostCore.databaseFailure`); the sentence a failed open is answered with                         | VC-553   |
| `scripts/`               | `pnpm --filter @volli/host-core migrations:lock`                                                                            | VC-553   |

The Session ledger, gate (`session-control/`) and Session engine wiring follow
in VC-612.

### Persistence

- **Database.** `createHostCore` opens `<dataDir>/volli.db` (or
  `options.databasePath`), creating the directory and running migrations. A
  failed open does not throw. It is classified once, logged through
  `ports.log`, and returned as `{ ok: false, error }`. A host keeps serving in
  degraded mode.
- **Migrations.** Shipped migrations are frozen in
  `src/db/migrations.lock.json`. Append a migration, then run
  `pnpm --filter @volli/host-core migrations:lock`. See
  [BOUNDARIES](../../docs/BOUNDARIES.md#shipped-sqlite-migrations).
- **A database from a newer build (VC-602).** Before anything opens the
  file for writing, `openVolliDb` reads its `user_version` and minimum reader
  version on the read-only preflight handle (`src/db/schema-compatibility.ts`).
  - At or below this build's head: migrate as usual.
  - Newer, and the floor is at or below the head: open it, log once, run no
    migration, never lower `user_version`.
  - Newer, and the floor is above the head (or unreadable): throw
    `DatabaseFromNewerVersionError` with the file byte-identical.
    `createHostCore` classifies it as `databaseFailure.kind === "newer-version"`;
    desktop shows its named recovery screen, and a headless host refuses to
    serve with the same typed reason.
  - The floor lives in `app_state` under `volli:min-reader-version`, which
    every schema has. A missing marker reads as the baseline, 58: the head the
    guard shipped at, and the oldest head that can safely back up a v58 file.
    Only a migration declared `raisesMinReader: true` writes it, in its own
    transaction. **Read "Breaking an older reader" above `MIGRATIONS` before
    adding a migration.**
  - A backup of a newer, compatible database is stamped with this build's
    head and carries only this build's columns, so a newer build can restore
    it and migrate it up. Bundles never carry the floor; a restore's
    migrations derive it.
- **Transaction ownership (VC-551).** No transaction spans an `await`. Use
  `withTransaction` / `settleTransaction` from `db/transaction-gate`.
  `openVolliDb` installs the ownership guard after migrations, with the handler
  the host passed as `onTransactionViolation`:
  - Desktop passes `throwTransactionViolation` in dev and tests, and
    `logTransactionViolation` when `app.isPackaged`.
  - **A headless host passes `throwTransactionViolation`.** Nobody is watching
    its log while a bug corrupts a transaction.
  - Tests use `openTestDb()` from `@volli/host-core/db/test-helpers`, which
    installs the throwing handler.
- **The boot-window rule.** Before the guard is installed, migrations and open
  checks run on the raw handle. No statement handle created in that window
  may outlive boot. When the guard installs, it wraps the statements already
  in the `prepared` cache. Any other early statement would escape it.
- **Native module.** `better-sqlite3` 13 is N-API and loads its bundled
  prebuild under both Node and Electron, with no rebuild step. Desktop keeps
  its own `better-sqlite3` dependency. `@volli/*` packages are bundled into
  `dist-electron/main.cjs` (`apps/desktop/vite.config.ts`, `alwaysBundle`), so
  host-core's `require("better-sqlite3")` resolves against the package
  electron-builder ships with the app. A new native or path-reading
  dependency here must also be a desktop dependency, whitelisted for
  packaging. `verify-packed-requires.mjs` fails the build otherwise.

## Moving a service cluster in

This is the pattern for every later move (VC-554 onward). A move is a **pure
move**: no behavior change, no migration, and the app is identical with the
`cloud` flag off.

1. **Measure the cluster's edges.** List every import that leaves it.
   - Everything it imports must already be in host-core, `@volli/shared`
     or `@volli/session-engine`.
   - Otherwise the import becomes a port, an option, or a type moved to
     `@volli/shared`. For example, `FirstPaintHint` moved out of the IPC
     contract, and `contract.ts` re-exports it.
   - Never import from `apps/*`.
   - Past roughly 1,500 changed lines (renames excluded), split at a
     service boundary and file the rest as a follow-up ticket.
2. **`git mv` the files** to `src/<cluster>/`, keeping file names. Change only
   import paths; don't restyle. `git diff -M --stat origin/main...HEAD`
   should read as renames, so that open PRs touching the old paths can
   re-sync.
3. **Export the cluster** as `./<cluster>` and `./<cluster>/*` in
   `package.json`, then rewrite importers mechanically: `./<cluster>/x`
   becomes `@volli/host-core/<cluster>/x`. Leave no re-export shims at the
   old paths. A shim turns the rename into an add.
4. **Move construction.** The cluster's construction leaves the
   `app.whenReady` closure for `createHostCore`, or for a
   `create<Cluster>(ports, options)` that `createHostCore` calls, and appears
   on `HostCore`.
   - Electron facts become options.
   - Calls back into Electron become ports.
   - `index.ts` passes them and wires the result where the inline value used
     to go, in the same order.
5. **Tests move with the code.**
   - A test whose imports all land in host-core moves with `git mv`.
   - A test that still composes desktop modules stays in desktop at its old
     path and imports from `@volli/host-core`. It moves in the ticket that
     moves its last desktop dependency. Examples: `apps/desktop/src/main/db/*.test.ts`
     and `transaction-gate-ledgers.test.ts`.
6. **Coverage moves with the test.** A protected entry in
   `apps/desktop/vite.config.ts` moves to this package's `vite.config.ts`
   when host-core's own tests hold it at 100%. Check that with
   `vp test run <test> --coverage --coverage.include=<file>`. If its test
   must stay in desktop, re-point the desktop entry to
   `**/packages/host-core/src/<path>`, as `db/export.ts` is.
7. **Fix every path reference.** `rg` the old directory across:
   - e2e and bench scripts (`ssrLoadModule("/apps/desktop/src/main/...")`, `load("src/main/...")`);
   - `apps/desktop/scripts`;
   - docs (`BOUNDARIES.md`, `CLAUDE.md`/`AGENTS.md`, the cloud plans).
8. **Lockfile.** A new dependency here uses the same specifier desktop
   already resolves. The `pnpm-lock.yaml` diff is importer entries only, with
   no version changes.
9. **Prove it.**
   - `node scripts/check-host-electron-imports.mjs`;
   - `vp run --filter @volli/host-core typecheck` and the desktop typecheck;
   - the moved test files locally;
   - in CI: `Test (packages)` (Linux), the desktop shards and coverage,
     `Check + Build` (packaging, `verify-packed-requires`) and core e2e.
