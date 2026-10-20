#!/usr/bin/env node
/**
 * VC-632 PR B: one package entry per host-core cluster.
 *
 *   node scripts/codemods/host-core-cluster-entries.mjs          # rewrite in place
 *   node scripts/codemods/host-core-cluster-entries.mjs --check  # report, change nothing
 *
 * `--check` formats what a run would write (entries, importers, the root and
 * `package.json`) and compares it with the checked-in files: it exits 0 on a
 * clean tree and names each file a run would change.
 *
 * 1. Reads every `@volli/host-core/<subpath>` import outside the package
 *    (apps/desktop, apps/hostd), resolving the subpath through the exports
 *    map host-core shipped before this change (`host-core-exports-before-vc632.json`)
 *    to the file it named.
 * 2. Writes `packages/host-core/src/entries/<cluster>.ts` for each cluster in
 *    CLUSTERS, and `src/testing/index.ts`: explicit `export { … } from` lists of
 *    exactly the names those importers use, grouped by source file. A name
 *    already in an entry stays (so a re-run after a main sync only adds).
 * 3. Rewrites each importer to `@volli/host-core/<cluster>`, merging the
 *    imports a file now takes from one entry into one declaration.
 * 4. Rewrites `package.json` `exports` to the root, the clusters and `./testing`.
 *
 * Only specifiers and import lists change: every name still binds to the
 * declaration it bound to. Test-only modules (TESTING), the Session writer's
 * constructors and the `*ForTest` resets (PRIVATE) are served by `./testing`
 * alone. A client import of a name that became PRIVATE after its importer was
 * migrated is reported, and moved to `@volli/host-core/testing` by hand.
 *
 * Mocks (`vi.mock`, `importActual`, `typeof import(…)`) are rewritten to the
 * cluster entry too; a factory that replaced a whole file module must then
 * spread `importOriginal()` — the four test files that mock host-core were
 * adjusted by hand after this ran.
 */
import { spawnSync } from "node:child_process";
import { existsSync, globSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");
const PKG = resolve(REPO, "packages/host-core");
const SRC = resolve(PKG, "src");
const NAME = "@volli/host-core";
const OLD_EXPORTS = JSON.parse(
  readFileSync(resolve(HERE, "host-core-exports-before-vc632.json"), "utf8"),
);
const check = process.argv.includes("--check");

/** Cluster → what it is, and the source files (globs relative to src/) it owns. */
export const CLUSTERS = {
  ports: {
    doc: "what host code asks of the process hosting it, with the headless answers",
    files: ["ports/**"],
  },
  db: {
    doc: "the SQLite database: open, migrations, the transaction gate and the repositories",
    files: ["db/**"],
  },
  secrets: {
    doc: "persistent Session secrets, the sealed credential module and its keys",
    files: ["secrets/**"],
  },
  sessions: {
    doc: "the Sessions module: listing, peek and activity watches, concurrency and tokens. The one Session writer is built by `createHostCore`, never here",
    files: [
      "session-control/**",
      "sessions/**",
      "session-services.ts",
      "session-concurrency.ts",
      "session-tokens.ts",
    ],
  },
  "session-runtime": {
    doc: "the Pi-backed Session runtime: staged assembly, facade, lifecycle, model access and decisions, background shells",
    files: [
      "session-runtime/**",
      "shell/**",
      "model-access/**",
      "decision/**",
      "runtime-services.ts",
      "session-env.ts",
      "pi-session-orphans.ts",
      "pi-tool-output.ts",
      "verb-input.ts",
    ],
  },
  integrations: {
    doc: "agent tool backends and exporters: MCP, Code Mode, Web Access and observability",
    files: ["mcp/**", "codemode/**", "web/**", "observability/**"],
  },
  files: {
    doc: "worktree files for clients: reads, writes, search, watches, blobs, prompt templates and skills",
    files: [
      "volli-fs.ts",
      "file-*.ts",
      "blob-*.ts",
      "turn-attachments.ts",
      "prompt-templates.ts",
      "skills.ts",
    ],
  },
  worktree: {
    doc: "ticket worktrees: git, ensure/trim/remove, snapshots, activity and the cleanup engine",
    files: ["worktree/**", "worktree-runtime.ts", "credential-helper-diagnostics.ts"],
  },
  board: {
    doc: "Projects and Tickets: create, relink, roots, base branch, ticket commands, moves and wakes",
    files: ["project-*.ts", "ticket-*.ts", "detached-work.ts"],
  },
  pty: {
    doc: "the terminal supervisor and its stream contract",
    files: ["pty/**"],
  },
  browser: {
    doc: "the agent browser's engine-agnostic half: backend interface, CDP controller, stores",
    files: ["browser/**"],
  },
  automations: {
    doc: "Automations: engine, service, runner and scheduler",
    files: ["automations/**", "automation-services.ts"],
  },
  agents: {
    doc: "what agents reach: the socket, its verb table, the tool door, watches, harnesses and the CLI install",
    files: ["agent-*.ts", "agent-dispatch/**", "watches.ts", "harness-*.ts", "host-profile.ts"],
  },
  maintenance: {
    doc: "keeping a host healthy: backup, recovery, process reaping, retention, quiet windows, login PATH and shutdown",
    files: [
      "backup/**",
      "process/**",
      "maintenance-services.ts",
      "database-recovery.ts",
      "retention-runtime.ts",
      "orphan-scan.ts",
      "quiet-windows.ts",
      "login-*.ts",
      "host-shutdown.ts",
      "shutdown-deadline.ts",
    ],
  },
};

/** Test support: served by `./testing` only; production code may not import it. */
export const TESTING = [
  "db/test-helpers.ts",
  "session-control/test-support.ts",
  "worktree/scripted-git.ts",
  "backup/test-fixture.ts",
  "secrets/test-support/**",
  "testing/**",
];

/**
 * Names that leave production entries. The Session writer's constructors are
 * built once, by `createHostCore`; tests that need a standalone ledger take
 * it from `./testing`.
 */
export const PRIVATE = {
  "session-control/index.ts": ["createSqliteSessionLedger", "createCheckpointFailureReporter"],
  "session-control/sqlite-ledger.ts": ["createSqliteSessionLedger", "SqliteSessionLedger"],
  // The database-file fence (VC-628): only `database-file.ts` sequences a swap.
  "db/recovery-pending.ts": ["beginDatabaseRecovery", "recoveryPendingPath"],
  // Test-only resets of module state: test support, so `./testing` serves them.
  "worktree/deletion-lease.ts": ["resetDeletionLeasesForTest"],
  "worktree/index.ts": ["resetDeletionLeasesForTest"],
  "worktree/snapshot.ts": ["resetWorktreeSnapshotsForTest"],
  "orphan-scan.ts": ["resetOrphanScanForTest"],
  "retention-runtime.ts": ["resetRetentionWatcherForTest"],
};

const ROOT_OWN = "index.ts";

/** Entries exist: this run follows a main sync, and only adds what main's new imports need. */
const RERUN = existsSync(resolve(SRC, "entries"));

/** A name an entry serves under another name, because the entry already has one by that name. */
export const ALIASES = {
  "secrets/test-support/n1/secrets/store.ts": { SecretStore: "N1SecretStore" },
};

/**
 * Run by plain `node` (type stripping, no resolver for extensionless
 * imports), so they import the one Node-loadable file by path, as the
 * e2e scripts' `ssrLoadModule("/packages/host-core/src/…")` already do.
 */
const NODE_DIRECT = new Set([
  "apps/desktop/scripts/session-storage-digest.mjs",
  "apps/desktop/e2e/automations-notification-smoke.mjs",
]);

// ---------------------------------------------------------------- resolution

/** Desktop's standalone test engine duplicated host-core's; its importers take host-core's. */
const DESKTOP_TEST_ENGINE = /(["'])(?:\.\.?\/)+test-session-engine\1/g;
const TEST_ENGINE_SPECIFIER = `${NAME}/testing/session-engine`;

function oldTarget(specifier) {
  if (specifier === TEST_ENGINE_SPECIFIER) return "testing/session-engine.ts";
  const key = specifier === NAME ? "." : `.${specifier.slice(NAME.length)}`;
  // On a re-run a cluster entry (`./db` is both an old and a new name) is already migrated.
  if (RERUN && (key === "./testing" || Object.hasOwn(CLUSTERS, key.slice(2)))) return null;
  const rel = (path) => relative(SRC, resolve(PKG, path)).split("\\").join("/");
  if (OLD_EXPORTS[key]) return rel(OLD_EXPORTS[key]);
  for (const [pattern, target] of Object.entries(OLD_EXPORTS)) {
    const star = pattern.indexOf("*");
    if (star < 0) continue;
    const prefix = pattern.slice(0, star);
    const suffix = pattern.slice(star + 1);
    if (key.startsWith(prefix) && key.endsWith(suffix)) {
      return rel(target.replaceAll("*", key.slice(prefix.length, key.length - suffix.length)));
    }
  }
  return null;
}

const globCache = new Map();
function matches(file, pattern) {
  if (!globCache.has(pattern)) globCache.set(pattern, new Set(globSync(pattern, { cwd: SRC })));
  return globCache.get(pattern).has(file);
}

function clusterOf(file) {
  if (TESTING.some((pattern) => matches(file, pattern))) return "testing";
  if (file === ROOT_OWN) return ".";
  for (const [cluster, { files }] of Object.entries(CLUSTERS)) {
    if (files.some((pattern) => matches(file, pattern))) return cluster;
  }
  throw new Error(`no cluster owns src/${file}`);
}

const entrySpecifier = (cluster) => (cluster === "." ? NAME : `${NAME}/${cluster}`);
const entryFile = (cluster) =>
  cluster === "testing" ? resolve(SRC, "testing/index.ts") : resolve(SRC, `entries/${cluster}.ts`);

/** `value` | `type` | null: how `file` exports `name`, following `export *`. */
function exportKind(file, name, seen = new Set()) {
  if (seen.has(file)) return null;
  seen.add(file);
  const path = resolve(SRC, file);
  if (!existsSync(path)) return null;
  const source = readFileSync(path, "utf8");
  const declared = new RegExp(
    String.raw`export\s+(?:declare\s+)?(?:default\s+)?(?:(async\s+function\*?|function\*?|const|let|var|class|abstract\s+class|enum|const\s+enum)|(interface|type))\s+${name}\b`,
  ).exec(source);
  if (declared) return declared[1] ? "value" : "type";
  for (const match of source.matchAll(/export\s+(type\s+)?\{([^}]*)\}/g)) {
    for (const raw of match[2].split(",")) {
      const spec = raw.trim().replace(/^\s*\/\/.*$/gm, "");
      if (!spec) continue;
      const isType = Boolean(match[1]) || spec.startsWith("type ");
      const exported = spec
        .replace(/^type\s+/, "")
        .split(/\s+as\s+/)
        .at(-1)
        .trim();
      if (exported === name) return isType ? "type" : "value";
    }
  }
  for (const match of source.matchAll(/export\s+\*\s+from\s+["'](\.[^"']+)["']/g)) {
    const base = relative(SRC, resolve(dirname(path), match[1]))
      .split("\\")
      .join("/");
    for (const candidate of [`${base}.ts`, `${base}/index.ts`, base]) {
      const kind = exportKind(candidate, name, seen);
      if (kind) return kind;
    }
  }
  return null;
}

/**
 * The root re-exported the ports module wholesale (`export * from "./ports"`).
 * That line goes: a port name a client took from the root is served by `./ports`.
 */
const ROOT_STAR = ["ports/index.ts"];
const ROOT_STAR_LINE = /^export \* from "\.\/ports";\n/m;

function starSource(name) {
  return ROOT_STAR.find((file) => exportKind(file, name)) ?? null;
}

// ------------------------------------------------------------ consumer scan

const CONSUMER_GLOB = "apps/{desktop,hostd}/{src,e2e,scripts}/**/*.{ts,tsx,mts,mjs}";
const IMPORT_DECL =
  /^(import|export)(\s+type)?\s+([^;]*?)\s+from\s*(["'])(@volli\/host-core(?:\/[^"']*)?)\4;?[ \t]*\n?/gms;
/**
 * A mock names the module it replaces. Mocking a cluster entry would replace
 * only the client's view and leave host-core's own importers on the real
 * module, so a mock keeps naming the host-core file, by path.
 */
const MOCK_SPECIFIERS = [
  /(<\s*typeof\s+import\s*\(\s*)(["'])(@volli\/host-core(?:\/[^"']*)?)\2/g,
  /(\bvi\.(?:mock|doMock|unmock|doUnmock|importActual|importMock)\s*(?:<[^>]*>)?\s*\(\s*)(["'])(@volli\/host-core(?:\/[^"']*)?)\2/g,
];
const DYNAMIC_SPECIFIER = /(\bimport\s*\(\s*)(["'])(@volli\/host-core(?:\/[^"']*)?)\2/g;

/** `consumer` → host-core `srcRelative`, as a relative path (`.ts` kept when asked). */
function pathInto(consumer, srcRelative, keepExtension) {
  let rel = relative(dirname(consumer), resolve(SRC, srcRelative)).split("\\").join("/");
  if (!keepExtension) rel = rel.replace(/\.ts$/, "");
  return rel.startsWith(".") ? rel : `./${rel}`;
}

/** entry → file → Map(name → kind) */
const wanted = new Map();
function want(cluster, file, name, kind) {
  if (!wanted.has(cluster)) wanted.set(cluster, new Map());
  const files = wanted.get(cluster);
  if (!files.has(file)) files.set(file, new Map());
  const names = files.get(file);
  if (names.get(name) !== "value") names.set(name, kind);
}

/** Where (cluster, file) one imported `name` of `file` is served from. */
function route(file, name) {
  if (file === ROOT_OWN) {
    const viaStar = starSource(name);
    if (viaStar) return route(viaStar, name);
    return { cluster: ".", file };
  }
  if (PRIVATE[file]?.includes(name)) return { cluster: "testing", file };
  return { cluster: clusterOf(file), file };
}

function parseSpecifiers(clause) {
  const braces = clause.match(/\{([^}]*)\}/);
  const rest = clause
    .replace(/\{[^}]*\}/, "")
    .replace(/,/g, "")
    .trim();
  const list = braces
    ? braces[1]
        .split(",")
        .map((spec) => spec.trim())
        .filter(Boolean)
        .map((spec) => {
          const isType = spec.startsWith("type ");
          const [name, alias] = spec.replace(/^type\s+/, "").split(/\s+as\s+/);
          return { name: name.trim(), alias: alias?.trim(), isType };
        })
    : [];
  return { list, rest };
}

const consumers = globSync(CONSUMER_GLOB, { cwd: REPO }).filter((f) => !f.includes("node_modules"));
const rewrites = [];
const unresolved = [];

for (const file of consumers) {
  const path = resolve(REPO, file);
  const original = readFileSync(path, "utf8");
  const source = original.replace(DESKTOP_TEST_ENGINE, `"${TEST_ENGINE_SPECIFIER}"`);
  if (!source.includes(NAME)) continue;
  if (NODE_DIRECT.has(file)) {
    const direct = source.replace(IMPORT_DECL, (whole, ...groups) => {
      const target = oldTarget(groups[4]);
      return target === null ? whole : whole.replace(groups[4], pathInto(path, target, true));
    });
    if (direct !== original) rewrites.push({ path, mutated: direct });
    continue;
  }
  /** cluster → { first: index, values, types, typeOnlyDecl, keyword } */
  const groups = new Map();
  const removals = [];
  let mutated = source;

  for (const match of source.matchAll(IMPORT_DECL)) {
    const [whole, keyword, typeKw, clause, , specifier] = match;
    const target = oldTarget(specifier);
    if (target === null) {
      // Already a cluster entry (a re-run): keep the import; add any name main's
      // new code imports that the entry does not serve yet, through the old map.
      const cluster = specifier === NAME ? "." : specifier.slice(NAME.length + 1);
      if (cluster === "." || clause.startsWith("*")) continue;
      const entry = relative(SRC, entryFile(cluster)).split("\\").join("/");
      for (const spec of parseSpecifiers(clause).list) {
        if (cluster !== "testing" && Object.values(PRIVATE).some((n) => n.includes(spec.name))) {
          unresolved.push(
            `${file}: ${spec.name} is served by ${NAME}/testing; import it from there`,
          );
          continue;
        }
        if (exportKind(entry, spec.name)) continue;
        const privately =
          cluster === "testing"
            ? Object.entries(PRIVATE).find(([, names]) => names.includes(spec.name))?.[0]
            : undefined;
        if (privately !== undefined) {
          want("testing", privately, spec.name, exportKind(privately, spec.name) ?? "value");
          continue;
        }
        const old = OLD_EXPORTS[`./${cluster}`];
        if (!old) {
          unresolved.push(
            `${file}: ${spec.name} is not in ${specifier}; add it to the entry by hand`,
          );
          continue;
        }
        const routed = route(relative(SRC, resolve(PKG, old)).split("\\").join("/"), spec.name);
        want(routed.cluster, routed.file, spec.name, exportKind(routed.file, spec.name) ?? "value");
      }
      continue;
    }
    const namespace = clause.match(/^\*\s+as\s+(\w+)$/);
    // A namespace a test spies on must be the module itself: spying on the
    // entry's namespace would leave host-core's own callers unspied.
    if (namespace && new RegExp(String.raw`\.spyOn\(\s*${namespace[1]}\b`).test(source)) {
      removals.push({
        index: match.index,
        length: whole.length,
        text: whole.replace(specifier, pathInto(path, target, false)),
      });
      continue;
    }
    if (namespace) {
      const cluster = clusterOf(target);
      for (const member of new Set(
        [...source.matchAll(new RegExp(String.raw`\b${namespace[1]}\.(\w+)`, "g"))].map(
          (m) => m[1],
        ),
      )) {
        const kind = exportKind(target, member) ?? "value";
        want(cluster, target, member, kind);
      }
      removals.push({
        index: match.index,
        length: whole.length,
        text: whole.replace(specifier, entrySpecifier(cluster)),
      });
      continue;
    }
    const { list, rest } = parseSpecifiers(clause);
    if (rest) {
      unresolved.push(`${file}: default import ${rest} from ${specifier}`);
      continue;
    }
    removals.push({ index: match.index, length: whole.length, text: "" });
    for (const spec of list) {
      const routed = route(target, spec.name);
      const kind = exportKind(routed.file, spec.name) ?? (typeKw || spec.isType ? "type" : "value");
      const alias = ALIASES[routed.file]?.[spec.name];
      if (alias) {
        if (spec.alias === alias) spec.alias = undefined;
        else spec.alias ??= spec.name;
        spec.name = alias;
      }
      want(routed.cluster, routed.file, spec.name, kind);
      const key = `${keyword} ${routed.cluster}`;
      if (!groups.has(key))
        groups.set(key, { first: match.index, keyword, cluster: routed.cluster, specs: [] });
      const group = groups.get(key);
      group.specs.push({ ...spec, isType: Boolean(typeKw) || spec.isType });
    }
  }

  // Merge each cluster's named imports into one declaration at its first site.
  for (const group of groups.values()) {
    const seen = new Set();
    const specs = group.specs.filter((spec) => {
      const id = `${spec.isType}:${spec.name}:${spec.alias ?? ""}`;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
    // A name imported as both a value and a type needs only the value.
    const values = new Set(specs.filter((s) => !s.isType).map((s) => `${s.name}:${s.alias ?? ""}`));
    const kept = specs.filter((s) => !s.isType || !values.has(`${s.name}:${s.alias ?? ""}`));
    const allTypes = kept.every((s) => s.isType);
    const text = kept
      .map(
        (s) => `${!allTypes && s.isType ? "type " : ""}${s.name}${s.alias ? ` as ${s.alias}` : ""}`,
      )
      .join(", ");
    const declaration = `${group.keyword}${allTypes ? " type" : ""} { ${text} } from "${entrySpecifier(group.cluster)}";\n`;
    const site = removals.find((r) => r.index === group.first);
    site.text += declaration;
  }

  for (const removal of removals.toSorted((a, b) => b.index - a.index)) {
    mutated =
      mutated.slice(0, removal.index) +
      removal.text +
      mutated.slice(removal.index + removal.length);
  }
  for (const mock of MOCK_SPECIFIERS) {
    mutated = mutated.replace(mock, (all, lead, quote, specifier) => {
      const target = oldTarget(specifier);
      if (target === null) return all;
      return `${lead}${quote}${pathInto(path, target, false)}${quote}`;
    });
  }
  mutated = mutated.replace(DYNAMIC_SPECIFIER, (all, lead, quote, specifier) => {
    const target = oldTarget(specifier);
    if (target === null) return all;
    return `${lead}${quote}${entrySpecifier(target === ROOT_OWN ? "." : clusterOf(target))}${quote}`;
  });
  if (mutated !== original) rewrites.push({ path, mutated });
}

// Names an entry already exports stay (re-runs only add).
for (const cluster of [...Object.keys(CLUSTERS), "testing"]) {
  const path = entryFile(cluster);
  if (!existsSync(path)) continue;
  const source = readFileSync(path, "utf8");
  for (const match of source.matchAll(
    /export\s+(type\s+)?\{([^}]*)\}\s+from\s+["']([^"']+)["']/g,
  )) {
    const file = relative(SRC, resolve(dirname(path), match[3]))
      .split("\\")
      .join("/");
    const real = existsSync(resolve(SRC, `${file}.ts`)) ? `${file}.ts` : `${file}/index.ts`;
    for (const raw of match[2].split(",")) {
      const spec = raw.trim();
      if (!spec) continue;
      const isType = Boolean(match[1]) || spec.startsWith("type ");
      const exported = spec
        .replace(/^type\s+/, "")
        .split(/\s+as\s+/)
        .at(-1);
      // A name that has since become private moves to `./testing`.
      const served = PRIVATE[real]?.includes(exported) ? "testing" : cluster;
      want(served, real, exported, isType ? "type" : "value");
    }
  }
}

// ---------------------------------------------------------------- entries

/** The file that declares `name`, following `export { name } from` and `export * from`. */
function origin(file, name, seen = new Set()) {
  if (seen.has(file)) return null;
  seen.add(file);
  const path = resolve(SRC, file);
  if (!existsSync(path)) return null;
  const source = readFileSync(path, "utf8");
  const near = (specifier) => {
    const base = relative(SRC, resolve(dirname(path), specifier))
      .split("\\")
      .join("/");
    return [`${base}.ts`, `${base}/index.ts`].find((candidate) =>
      existsSync(resolve(SRC, candidate)),
    );
  };
  for (const match of source.matchAll(
    /export\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["'](\.[^"']+)["']/g,
  )) {
    const names = match[1].split(",").map((spec) => spec.trim().replace(/^type\s+/, ""));
    const hit = names.find((spec) => spec.split(/\s+as\s+/).at(-1) === name);
    if (hit) return origin(near(match[2]), hit.split(/\s+as\s+/)[0], seen);
  }
  // Imported then re-exported by a bare `export { name }`.
  if (new RegExp(String.raw`export\s+(?:type\s+)?\{[^}]*\b${name}\b[^}]*\}\s*;`).test(source)) {
    const imported = new RegExp(
      String.raw`import\s+(?:type\s+)?\{[^}]*\b${name}\b[^}]*\}\s*from\s*["'](\.[^"']+)["']`,
    ).exec(source);
    if (imported) return origin(near(imported[1]), name, seen);
  }
  for (const match of source.matchAll(/export\s+\*\s+from\s+["'](\.[^"']+)["']/g)) {
    const found = exportKind(near(match[1]) ?? "", name)
      ? origin(near(match[1]), name, seen)
      : null;
    if (found) return found;
  }
  return file;
}

/** One binding exported twice (an index and its module) is served once; two bindings are a clash. */
function dedupe(cluster, files) {
  const owner = new Map();
  const clashes = [];
  for (const [file, names] of files) {
    for (const name of Array.from(names.keys())) {
      const previous = owner.get(name);
      if (previous === undefined || previous === file) {
        owner.set(name, file);
        continue;
      }
      const declared = origin(file, name);
      if (declared !== origin(previous, name)) {
        clashes.push(`${cluster}: ${name} in ${previous} and ${file}`);
        continue;
      }
      // Keep the declaring module when it is one of the two; otherwise the first seen.
      const keep = declared === file ? file : previous;
      const drop = keep === file ? previous : file;
      const kind = files.get(drop).get(name) === "value" ? "value" : files.get(keep).get(name);
      files.get(drop).delete(name);
      files.get(keep).set(name, kind);
      owner.set(name, keep);
    }
  }
  for (const [file, names] of files) if (names.size === 0) files.delete(file);
  return clashes;
}

function importPath(fromFile, srcRelative) {
  let rel = relative(dirname(fromFile), resolve(SRC, srcRelative)).split("\\").join("/");
  rel = rel.replace(/\.ts$/, "").replace(/\/index$/, "");
  return rel.startsWith(".") ? rel : `./${rel}`;
}

const TESTING_DOC =
  "test support for host-core's clients: database and Session fixtures, scripted git, the backup fixture profile, a standalone Session engine and ledger, child-process helpers. Production code never imports it (`package-interface.test.ts`, and desktop's and hostd's own guards)";

const clashes = [];
const written = [];
for (const [cluster, files] of [...wanted].toSorted(([a], [b]) => a.localeCompare(b))) {
  if (cluster === ".") continue;
  clashes.push(...dedupe(cluster, files));
  const path = entryFile(cluster);
  const doc = cluster === "testing" ? TESTING_DOC : CLUSTERS[cluster].doc;
  const lines = [
    "/**",
    ` * \`${entrySpecifier(cluster)}\`: ${doc}.`,
    " *",
    " * An explicit list: a name is public because a client, or a client's test,",
    " * imports it as this cluster's API. Add one here when a client needs it;",
    " * host-core's own files import the module itself, never this entry. See",
    " * the cluster map in the package README.",
    " */",
  ];
  for (const [file, names] of [...files].toSorted(([a], [b]) => a.localeCompare(b))) {
    const specs = [...names]
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([name, kind]) => {
        const original = Object.entries(ALIASES[file] ?? {}).find(
          ([, alias]) => alias === name,
        )?.[0];
        const spelled = original ? `${original} as ${name}` : name;
        return kind === "type" ? `type ${spelled}` : spelled;
      });
    const allTypes = [...names.values()].every((kind) => kind === "type");
    const list = allTypes ? specs.map((s) => s.replace(/^type /, "")) : specs;
    lines.push(
      `export${allTypes ? " type" : ""} { ${list.join(", ")} } from "${importPath(path, file)}";`,
    );
  }
  written.push({ path, text: `${lines.join("\n")}\n` });
}

if (clashes.length > 0 || unresolved.length > 0) {
  console.error([...clashes, ...unresolved].join("\n"));
  process.exit(1);
}

// ---------------------------------------------------------------- exports map

const exportsMap = { ".": { types: "./src/index.ts", import: "./src/index.ts" } };
for (const cluster of Object.keys(CLUSTERS).toSorted()) {
  const target = `./src/entries/${cluster}.ts`;
  exportsMap[`./${cluster}`] = { types: target, import: target };
}
exportsMap["./testing"] = { types: "./src/testing/index.ts", import: "./src/testing/index.ts" };

/** `path` → what this run would leave there, before formatting. */
const proposed = new Map([
  ...written.map(({ path, text }) => [path, text]),
  ...rewrites.map(({ path, mutated }) => [path, mutated]),
]);
const rootPath = resolve(SRC, ROOT_OWN);
proposed.set(rootPath, readFileSync(rootPath, "utf8").replace(ROOT_STAR_LINE, ""));
const manifestPath = resolve(PKG, "package.json");
{
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.exports = exportsMap;
  proposed.set(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

/**
 * The proposed files as the formatter leaves them: written under `.tmp/` (in
 * the repository, so the same formatter config applies), formatted, read back.
 */
function formatted(files) {
  const scratch = resolve(REPO, ".tmp/host-core-cluster-entries-check");
  rmSync(scratch, { recursive: true, force: true });
  try {
    const copies = [...files].map(([path, text]) => {
      const copy = resolve(scratch, relative(REPO, path));
      mkdirSync(dirname(copy), { recursive: true });
      writeFileSync(copy, text);
      return [path, copy];
    });
    spawnSync("vp", ["fmt", ...copies.map(([, copy]) => copy)], { stdio: "ignore", cwd: REPO });
    return new Map(copies.map(([path, copy]) => [path, readFileSync(copy, "utf8")]));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (check) {
  // Compare what a run would leave after formatting with what is checked in,
  // so a clean tree passes and only a real difference fails.
  const stale = [...formatted(proposed)]
    .filter(([path, text]) => !existsSync(path) || readFileSync(path, "utf8") !== text)
    .map(([path]) => relative(REPO, path));
  for (const path of stale) console.log(path);
  console.log(
    `would change ${stale.length} files (formatted; ${written.length} entries, ${rewrites.length} importers, root and package.json compared)`,
  );
  process.exitCode = stale.length > 0 ? 1 : 0;
} else {
  for (const [path, text] of proposed) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
  spawnSync("vp", ["fmt", ...proposed.keys()], { stdio: "inherit", cwd: REPO });
  console.log(`rewrote ${rewrites.length} importers; wrote ${written.length} entries`);
}
