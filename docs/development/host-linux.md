# Linux host development and CI

## The host lane already exists

`.github/workflows/ci.yml`'s **Test (packages)** job runs on Ubuntu 24.04 using
plain Node/Vitest at the exact `.nvmrc` version, not the Electron executable:

```sh
vp run --filter './packages/*' --filter './apps/*' --filter '!@volli/desktop' test:coverage --maxWorkers=$(nproc)
```

It covers `session-engine`, `session-rpc`, `agent-runtime` and `shared` today
(and the other non-desktop workspace suites). `host-protocol`, `host-core` and
`apps/hostd` join through those directory filters as they appear. They must
provide `test:coverage`: the CI policy self-test refuses a host manifest that
would otherwise silently skip. This lane runs on **every PR**, including every
host-path change, and `CI gate` requires success. There is no duplicate host
suite and no path-based waiver of these unit tests.

**Check + Build** runs the host Electron import guard, its deliberate failing
fixture, and the CI policy tests. **Build (host container)** builds and checks
the image on host-package, hostd, container, toolchain or CI-policy changes
(and on main/manual runs). `CI gate` checks its exact expected result:
`success` when selected, `skipped` otherwise. Failure or cancellation never
qualifies. Missing/invalid Scope flags also fail the gate. The policy tests
execute the workflow's actual Bash for the result and path matrices, including
failure, cancellation, unexpected skip, prose-only changes and missing flags.

## Electron boundary

```sh
node scripts/check-host-electron-imports.mjs --self-test
node scripts/check-host-electron-imports.mjs
node scripts/check-host-electron-imports.mjs --report
```

The guard covers all first-party source under `packages/*` and `apps/hostd`,
including tests and configuration. It scans literal module specifiers (also
constant backtick strings), not evaluated programs, computed loader targets,
JSDoc type comments or third-party package internals. Computed loaders emit a
warning rather than silently being treated as a literal. Relative import edges
are followed even when they leave a package for desktop code. Static imports,
export-from, dynamic imports and `require` (also resolve calls) all count;
TypeScript type-only imports are not an exemption. Package `#` aliases and
desktop/renderer aliases fail closed: use relative edges until alias resolution
is implemented. Other workspace packages are independently guarded roots.
The committed VC-486 fixture reproduces `session-runtime/location.ts` reaching
Electron through both `../broadcast` and `../worktree-runtime`; the self-test
requires that checking this fixture exits unsuccessfully. Report mode uses the
same resolver to inventory desktop main modules, not to execute their tests.
Its schema records the closure limitations and illustrative (not exhaustive)
witnesses; output is restricted to JSON files in `.tmp/`, never source/manifests.
An exclusively created temporary file plus atomic rename replaces the output
entry without following a destination symlink; the self-test proves its target
is unchanged.

A desktop Vitest test passing in the Node environment can still have an
Electron-dependent production graph: `vi.mock("electron", ...)` and mocks of
intermediate desktop modules sever those edges. The report is an extraction
inventory, **not proof that an Electron-free module is Linux-portable**, nor
that a mock-dependent test exercises real Electron under Node. Vitest's implicit
`setupFiles` are not source import edges: the main project's `test-setup.ts`
imports `broadcast` after each test to dispose the coalescer, after hoisted mocks
have taken effect. That teardown is relevant even for a test file whose own
graph has no Electron edge. Filesystem,
PTY, native-library and macOS-specific behavior still require their own checks.
The VC-552 inventory comment records the module lists and test caveats.

## Development image

The image in `.devcontainer/host/Dockerfile` is a **development toolchain**, not
a production hostd deployment. Its multi-architecture base is pinned by digest;
its Node version must equal `.nvmrc` (currently 24.15.0), and Corepack installs
the root manifest's exact pnpm version. It includes git/SSH, Python/make/g++ for
native compilation, fonts and Chromium runtime libraries. It contains neither
Electron, Chromium itself, source code, installed workspace dependencies nor
credentials. Apt lists and the npm cache are removed. It runs as non-root `node`.

Build locally or on the Linux dogfood box from the repository root:

```sh
docker build -f .devcontainer/host/Dockerfile -t volli-host-dev .
docker run --rm -it --init -v "$PWD:/workspace" volli-host-dev
# Inside the container, in a fresh Linux checkout:
pnpm --filter volli-code --filter './packages/*' --filter './apps/hostd' install --frozen-lockfile
pnpm exec vp check
# Run only the package/test file being developed locally; full coverage is CI's job.
```

The same configuration can be opened via **Dev Containers: Open Folder in
Container**, selecting `.devcontainer/host/devcontainer.json`. Use a separate
Linux checkout; do not reuse a Mac's installed dependency directories or a
checkout being used by a desktop Electron build. The filtered install includes
root tooling, all packages and hostd when present, **not desktop**: its Electron
native postinstall must not run in this host-only checkout. Until hostd exists,
pnpm's no-match notice for that one filter is expected. The devcontainer keeps
the root dependency store in a named Docker volume. On Linux the bind mount must
be writable by uid 1000 (`node`); adjust the container user/mount permissions
for your own checkout if needed. No production secrets are baked or mounted.
Standalone Chromium provisioning belongs to the browser/worker ticket; these
libraries support it without installing another browser in every dev image.

The previous 24.13.0 `.nvmrc` pin could not install the current dependency graph:
jsdom 30.0.1 requires Node ^24.15.0 in the 24.x line, and `engineStrict` rejects
older versions. The host lane/image therefore use 24.15.0, and the root
`engines.node` floor is ^24.15.0 too. The host lane's exact-version install
checks the full graph rather than inferring compatibility from the caret range.

When bumping Node, update `.nvmrc`, the Dockerfile's tag and multi-arch digest
together; the image build catches drift. A root `packageManager` bump also
requires rebuilding the image: the pinned Corepack cache is read-only to `node`.
The Dockerfile-specific ignore file
limits its build context to the toolchain manifests, not local credentials.

## Native modules: keep host and Electron installs separate

`@volli/host-core` and desktop both depend on `better-sqlite3` and, since
VC-560, `node-pty` (the terminal supervisor moved into host-core). Desktop's
postinstall runs `electron-rebuild -f -w node-pty,better-sqlite3`. SQLite 13
is N-API and loads its bundled `prebuilds/<platform>-<arch>.node` under both
Node and Electron, so the Electron rebuild is deliberately a no-op for it and
host-core's tests load the same package under plain Node with no rebuild step.

node-pty 1.1.0 is N-API too, but ships prebuilds only for macOS and Windows.
On macOS the Electron rebuild's `build/Release/pty.node` also loads under
plain Node, so host-core's PTY tests run on a desktop checkout as-is. On Linux
the package compiles from source at install, and in a full workspace install
desktop's postinstall then rebuilds it against Electron's headers. The host
lane does not lean on that: **Test (packages)** rebuilds node-pty for its own
Node and probes it before the tests run:

```sh
# The same commands CI runs, after the job's install:
env -u npm_config_arch -u npm_config_target_arch \
    npm_config_runtime=node \
    npm_config_target="$(node -p 'process.versions.node')" \
    npm_config_disturl=https://nodejs.org/download/release \
    npm_config_build_from_source=true \
    pnpm --filter @volli/host-core rebuild node-pty
node packages/host-core/scripts/probe-node-pty.mjs
```

`npm_config_build_from_source=true` makes node-pty's install script remove its
prebuilds and run node-gyp; the runner and the image supply the compiler and
Python. The probe loads node-pty from host-core and runs one shell through it,
naming the failure otherwise. That job never runs Electron, so rebuilding its
tree is safe; the desktop jobs keep their own Electron build. **Never do this
to a desktop dependency tree you will run Electron from**, or run
`electron-rebuild` over a host tree: those builds must not overwrite one
another. A host-only install (the devcontainer's filtered install) never runs
desktop's postinstall, so node-pty's own install script already builds it for
the running Node; the probe is still the check.
