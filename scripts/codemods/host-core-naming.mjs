#!/usr/bin/env node
/**
 * VC-632 PR 4: host-core's naming pass, as one mechanical rename.
 *
 *   node scripts/codemods/host-core-naming.mjs          # rename in place
 *   node scripts/codemods/host-core-naming.mjs --check  # list what would change
 *
 * Renames are whole-word and case-sensitive, so `PtyHost` never touches
 * `desktopPtyHost`. They apply to code in host-core, desktop and hostd, and to
 * the current-state docs that name them (the host-core and hostd READMEs, and
 * top-level `docs/*.md`). Dated research and plan documents keep the names
 * they were written with. `.pinned` N-1 copies stay byte-identical: they are
 * main's frozen source, not code this build runs. Each rename's target is checked
 * to be unused before anything is written, so a rename can never merge two names.
 * Files move with `git mv`; the specifiers naming them are rewritten.
 *
 * The convention the renames follow is in `packages/host-core/README.md`,
 * "Naming".
 */
import { execFileSync, spawnSync } from "node:child_process";
import { globSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const check = process.argv.includes("--check");

/** Host-neutral names for host-core's `Desktop*` (it runs on hostd too). */
const DESKTOP_NAMES = {
  createDesktopSessionRuntime: "createHostSessionRuntime",
  DesktopSessionRuntimeOptions: "HostSessionRuntimeOptions",
  createDesktopSessionLocationResolver: "createSessionLocationResolver",
  createDesktopDecisions: "createHostDecisions",
  DesktopMcpDispatch: "HostMcpDispatch",
  desktopMcpDispatch: "hostMcpDispatch",
  DesktopCodeMode: "HostCodeMode",
  desktopCodeMode: "hostCodeMode",
  // The runtime's ports plus the attachment-ending doors the adapter drives.
  DesktopBrowserPort: "AttachmentBrowserPort",
  DesktopShellPort: "AttachmentShellPort",
  DesktopMcpPort: "AttachmentMcpPort",
  DesktopSecretPort: "AttachmentSecretPort",
};

/** `Deps` and `Dependencies` retire: what a constructor asks for is its `Ports`. */
const DEPS_NAMES = Object.fromEntries(
  [
    "AttachmentIdentityDependencies",
    "AutomationRunnerDeps",
    "AutomationServiceDeps",
    "BackgroundShellHostDependencies",
    "BlobProtocolDeps",
    "BrowserPictureStoreDependencies",
    "BrowserTabRegistryDependencies",
    "BrowserTraceStoreDependencies",
    "CredentialHelperDiagnosticsDeps",
    "LoginPathBootstrapDeps",
    "LoginShellProbeDeps",
    "ModelAccessSignInDeps",
    "OrphanCleanupDeps",
    "OrphanProcessDeps",
    "ParkControllerDeps",
    "PendingArmedRunCoordinatorDeps",
    "ProjectRelinkDeps",
    "PublishDeps",
    "ReclaimDeps",
    "RetentionPollDeps",
    "SessionEnvReportBaseDeps",
    "SessionEnvReportDeps",
    "SetupRunDeps",
    "TrimFinishDeps",
    "TrimSweepDeps",
    "VenueReadDeps",
    "WorktreeDeps",
    "WorktreeReadDeps",
  ].map((name) => [name, name.replace(/(Deps|Dependencies)$/, "Ports")]),
);

/** `Host` is a service that owns live resources; what something asks of its host is `Ports` or a `Backend`. */
const HOST_NAMES = {
  PtyHost: "PtyManagerPorts",
  desktopPtyHost: "desktopPtyPorts",
  AgentBrowserHost: "AgentBrowserBackend",
};

/** Applied inside host-core only: a host's own locals may say which host they are. */
const HOST_CORE_LOCALS = { desktopDecisions: "hostDecisions" };

export const RENAMES = { ...DESKTOP_NAMES, ...DEPS_NAMES, ...HOST_NAMES };

/** `agent-runtime.ts` collided with `@volli/agent-runtime`; it is the host's profile lock, runtime paths and CLI shim. */
const FILE_MOVES = [
  ["packages/host-core/src/agent-runtime.ts", "packages/host-core/src/host-profile.ts"],
  ["packages/host-core/src/agent-runtime.test.ts", "packages/host-core/src/host-profile.test.ts"],
  [
    "packages/host-core/src/decision/desktop.ts",
    "packages/host-core/src/decision/host-decisions.ts",
  ],
  [
    "packages/host-core/src/decision/desktop.test.ts",
    "packages/host-core/src/decision/host-decisions.test.ts",
  ],
];

/** The specifiers and path mentions naming a moved file. Never `@volli/agent-runtime`. */
const PATH_REWRITES = [
  [/(["'](?:\.\.?\/)+)agent-runtime(["'])/g, "$1host-profile$2"],
  [/(["']\.\/)desktop(["'])/g, "$1host-decisions$2", "packages/host-core/src/decision/"],
  [/(["'](?:\.\.?\/)+decision\/)desktop(["'])/g, "$1host-decisions$2"],
  [/(host-core\/src\/)agent-runtime(\.ts|["'`])/g, "$1host-profile$2"],
  [/(host-core\/src\/decision\/)desktop(\.ts|["'`])/g, "$1host-decisions$2"],
  [/(`src\/)agent-runtime\.ts`/g, "$1host-profile.ts`"],
  [/(`(?:src\/)?decision\/)desktop\.ts`/g, "$1host-decisions.ts`"],
];

const CODE = [
  "packages/host-core/src/**/*.{ts,tsx,mts,mjs}",
  "packages/host-core/scripts/**/*.{mjs,ts}",
  "apps/desktop/{src,e2e,scripts}/**/*.{ts,tsx,mts,mjs}",
  "apps/desktop/*.ts",
  "apps/hostd/{src,scripts}/**/*.{ts,mts,mjs}",
];
const DOCS = ["packages/host-core/README.md", "apps/hostd/README.md", "docs/*.md"];

const word = (name) => new RegExp(String.raw`(?<![\w$])${name}(?![\w$])`, "g");

function files() {
  return [...CODE, ...DOCS]
    .flatMap((pattern) => globSync(pattern, { cwd: REPO }))
    .filter((file) => !file.includes("node_modules") && !file.endsWith(".pinned"));
}

// A target already in use would merge two names into one.
const inUse = Object.entries({ ...RENAMES, ...HOST_CORE_LOCALS }).filter(([, to]) => {
  const result = spawnSync("git", ["grep", "-q", "-w", to, "--", ".", ":!*.pinned"], { cwd: REPO });
  return result.status === 0;
});

const moved = FILE_MOVES.filter(([from]) => globSync(from, { cwd: REPO }).length > 0);
if (inUse.length > 0 && moved.length > 0) {
  console.error(
    `targets already in use: ${inUse.map(([from, to]) => `${from} → ${to}`).join(", ")}`,
  );
  process.exit(1);
}

if (!check) for (const [from, to] of moved) execFileSync("git", ["mv", from, to], { cwd: REPO });

const touched = [];
for (const file of files()) {
  const path = resolve(REPO, file);
  const before = readFileSync(path, "utf8");
  let after = before;
  for (const [from, to] of Object.entries(RENAMES)) after = after.replace(word(from), to);
  if (file.startsWith("packages/host-core/")) {
    for (const [from, to] of Object.entries(HOST_CORE_LOCALS))
      after = after.replace(word(from), to);
  }
  for (const [pattern, replacement, onlyUnder] of PATH_REWRITES) {
    if (onlyUnder === undefined || file.startsWith(onlyUnder))
      after = after.replace(pattern, replacement);
  }
  if (after === before) continue;
  touched.push(path);
  if (check) console.log(file);
  else writeFileSync(path, after);
}
console.log(
  `${check ? "would rename in" : "renamed in"} ${touched.length} files; ${moved.length} files moved`,
);
if (!check && touched.length > 0) {
  const code = touched.filter((path) => !path.endsWith(".md"));
  if (code.length > 0) spawnSync("vp", ["fmt", ...code], { stdio: "inherit", cwd: REPO });
}
