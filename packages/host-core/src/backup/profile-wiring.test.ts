/**
 * The profile-file register held against the code that actually writes under
 * the profile root (VC-829).
 *
 * `decisions.test.ts` binds the areas it knows about to the functions that
 * mint them. That catches an area that MOVES, never one that APPEARS: a new
 * `join(userData, "something")` nobody listed ships with no backup decision.
 * This file parses the production source of every process that owns a
 * profile — host-core, desktop main and hostd — derives the top-level areas
 * from the wiring itself, and requires a {@link PROFILE_FILE_DECISIONS} entry
 * for each.
 *
 * What it recognises (syntactically, with the toolchain's own TypeScript
 * parser — Vite's `parseAst`, oxc's ESTree — not regex):
 *
 * - a `join`/`resolve` imported from `node:path` (named, renamed, or through
 *   a namespace/default import such as `path.join`), called with two or more
 *   arguments whose FIRST is the profile root;
 * - the profile root as an identifier or property named `userData`,
 *   `userDataPath`, `userDataDir` or `dataDir`, a `*.getPath("userData")`
 *   call, a local alias declared straight from one of those, and the few
 *   file-scoped names in {@link FILE_ROOTS};
 * - as the area, the second argument: a string literal (its first `/`
 *   segment), a template's static head (`.volli-restore-${now}` must fall
 *   under a trailing glob such as `.volli-restore-*`), or an identifier the
 *   file imports or declares as a top-level `const` with a static value (a
 *   literal, or a `join` of literals) — how hostd's `STATUS_FILE_NAME` & co.
 *   are found. Anything else is dynamic and fails until it is listed in
 *   {@link REVIEWED_DYNAMIC_SEGMENTS} with a representative name, which is
 *   then held against the register like a literal.
 *
 * What it does NOT see, stated rather than implied:
 *
 * - a root under another name (`root`, `base`, a parameter called anything
 *   else), a template path such as `${userData}/x`, or a path handed through
 *   a helper whose parameter is not one of the names above;
 * - siblings derived from a FILE in the profile rather than the root:
 *   `${dbPath}-wal`, `recoveryPendingPath(dbPath)`, the migration safety
 *   copies `backup-retention.ts` names from `dbPath`;
 * - an imported constant's module is not followed: constants are matched by
 *   their imported NAME across the scanned trees, and a name two modules
 *   define differently stays dynamic rather than guessed;
 * - anything a spawned program (Chromium, an agent CLI) writes on its own.
 *
 * So green means "every area the recognised wiring names has a decision",
 * not "nothing else is ever written beside them".
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseAst } from "vite";
import { describe, expect, it } from "vite-plus/test";

import { PROFILE_FILE_DECISIONS } from "./decisions";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

/** Every production tree whose process owns, or is handed, the profile root. */
const SCANNED_TREES = ["packages/host-core/src", "apps/desktop/src/main", "apps/hostd/src"];

/** Names that mean the app's profile root wherever they appear. */
const ROOT_NAMES = ["userData", "userDataPath", "userDataDir", "dataDir"];

/**
 * Names that mean the app's profile root in ONE file. `profileRoot` is not a
 * global root name: in `browser/` it is the parent of throwaway Chromium
 * profiles, not Volli's profile.
 */
const FILE_ROOTS: Record<string, readonly string[]> = {
  // Restore's `request.profileRoot` is the profile being replaced.
  "packages/host-core/src/backup/restore.ts": ["profileRoot"],
  "packages/host-core/src/backup/restore-schedule.ts": ["root"],
  "packages/host-core/src/backup/restore-service.ts": ["root"],
  "packages/host-core/src/backup/restore-worker.ts": ["root"],
};

/**
 * Root names that, in one file, are NOT the app profile: `chromium-launch.ts`
 * calls a launch's private Chromium profile `userDataDir`, Chromium's own
 * flag name.
 */
const FILE_NOT_ROOTS: Record<string, readonly string[]> = {
  "packages/host-core/src/browser/chromium-launch.ts": ["userDataDir"],
};

/**
 * Segments the scanner cannot read statically, each reviewed by hand. Keyed
 * by `<file>::<segment source text>`; `sample` is a name the site really
 * produces, checked against the register as a literal is. A new dynamic site
 * fails until someone reviews it here; one that disappears fails too.
 */
const REVIEWED_DYNAMIC_SEGMENTS: Record<string, { sample: string; why: string }> = {
  "packages/host-core/src/backup/restore-service.ts::previous": {
    sample: ".volli-replaced-1800000000000",
    why: "status selects only the exact preserved-profile directory namespace to reveal in Finder",
  },
  "packages/host-core/src/backup/restore-schedule.ts::name": {
    sample: ".volli-restore-prepared.json",
    why: "readIntent accepts only the local prepared or accepted restore record constants",
  },
  "packages/host-core/src/backup/restore-schedule.ts::prepared.staging": {
    sample: ".volli-restore-1800000000000",
    why: "readIntent validates this single-segment restore staging name before deletion",
  },
  "packages/host-core/src/backup/restore-schedule.ts::intent.staging": {
    sample: ".volli-restore-1800000000000",
    why: "readIntent validates this single-segment restore staging name before activation or deletion",
  },
  "packages/host-core/src/backup/restore-schedule.ts::intent.previous": {
    sample: ".volli-replaced-1800000000000",
    why: "readIntent validates this single-segment previous-profile name before activation",
  },
  "packages/host-core/src/backup/restore-service.ts::name": {
    sample: ".volli-inspect-123-00000000-0000-4000-8000-000000000000",
    why: "the dead-worker sweep validates the inspection scratch namespace and owner pid before deletion",
  },
  "packages/host-core/src/database-recovery.ts::`${name}.restore-`": {
    sample: "volli.db.restore-Ab12Cd",
    why: "mkdtemp staging beside the database; `name` is the profile database's basename",
  },
  "packages/host-core/src/database-recovery.ts::selected.name": {
    sample: "volli.db.backup-v57",
    why: "reads an existing migration safety copy chosen from the directory allowlist",
  },
  "packages/host-core/src/database-recovery.ts::`${name}.damaged-${randomUUID().slice(0, 8)}`": {
    sample: "volli.db.damaged-1a2b3c4d",
    why: "the damaged database a recovery swap sets aside",
  },
  "apps/hostd/src/credentials.ts::reset.archive": {
    sample: "session-secrets.enc.locked-20260101T000000Z-0a1b2c3d",
    why: "archiveSealedStore's `<store>.locked-<time>-<random>` name (VC-641)",
  },
};

interface SourceFile {
  /** Repository-relative, `/`-separated. */
  path: string;
  text: string;
}

type Segment =
  | { kind: "name"; name: string }
  | { kind: "prefix"; prefix: string }
  | { kind: "dynamic"; text: string };

interface Wiring {
  file: string;
  line: number;
  segment: Segment;
}

/** The slice of oxc's ESTree this scanner reads; everything else is walked blind. */
interface Node {
  type: string;
  start: number;
  end: number;
  [key: string]: unknown;
}

/** Production TypeScript only: no tests, fixtures, test support or declarations. */
function isProductionSource(path: string): boolean {
  if (!/\.tsx?$/.test(path) || path.endsWith(".d.ts")) return false;
  const parts = path.split("/");
  if (parts.some((part) => ["test-support", "testing", "fixtures", "test-helpers"].includes(part)))
    return false;
  return !/(^|\.)test[.-]|fixture/.test(parts.at(-1) ?? "");
}

function readProductionSources(): SourceFile[] {
  return SCANNED_TREES.flatMap((tree) =>
    readdirSync(join(REPO_ROOT, tree), { recursive: true, encoding: "utf8" })
      .map((entry) => `${tree}/${entry.split(sep).join("/")}`)
      .filter(isProductionSource)
      .map((path) => ({ path, text: readFileSync(join(REPO_ROOT, path), "utf8") })),
  );
}

function isNode(value: unknown): value is Node {
  return typeof value === "object" && value !== null && typeof (value as Node).type === "string";
}

function children(node: Node): Node[] {
  return Object.values(node).flatMap((value) =>
    Array.isArray(value) ? value.filter(isNode) : isNode(value) ? [value] : [],
  );
}

function walk(node: Node, visit: (node: Node) => void): void {
  visit(node);
  for (const child of children(node)) walk(child, visit);
}

/** Strip `( )`, `as`, `satisfies` and `!`. */
function unwrap(node: Node): Node {
  let current = node;
  while (
    [
      "ParenthesizedExpression",
      "TSAsExpression",
      "TSSatisfiesExpression",
      "TSNonNullExpression",
    ].includes(current.type)
  ) {
    current = current.expression as Node;
  }
  return current;
}

const nameOf = (node: Node): string | undefined =>
  node.type === "Identifier" ? (node.name as string) : undefined;

/** A file's view of itself: its path imports, named imports and static constants. */
interface FileScope {
  path: string;
  text: string;
  program: Node;
  /** Local names of `join`/`resolve` imported from `node:path`. */
  joins: Set<string>;
  /** Local names bound to the `node:path` module (`path.join`). */
  pathModules: Set<string>;
  /** Local name → imported name, for every named import. */
  imported: Map<string, string>;
  /** Top-level `const NAME = <static path>`. */
  constants: Map<string, string>;
}

function isPathJoin(call: Node, scope: FileScope): boolean {
  const callee = unwrap(call.callee as Node);
  const local = nameOf(callee);
  if (local !== undefined) return scope.joins.has(local);
  if (callee.type !== "MemberExpression" || callee.computed) return false;
  const object = nameOf(callee.object as Node);
  const method = nameOf(callee.property as Node);
  return (
    object !== undefined &&
    scope.pathModules.has(object) &&
    (method === "join" || method === "resolve")
  );
}

/** A literal path, or a path `join` of literals, as one `/`-separated string. */
function staticPath(node: Node, scope: FileScope): string | undefined {
  const expression = unwrap(node);
  if (expression.type === "Literal" && typeof expression.value === "string")
    return expression.value;
  if (expression.type === "TemplateLiteral" && (expression.expressions as Node[]).length === 0)
    return ((expression.quasis as Node[])[0]!.value as { cooked: string }).cooked;
  if (expression.type === "CallExpression" && isPathJoin(expression, scope)) {
    const parts = (expression.arguments as Node[]).map((argument) => staticPath(argument, scope));
    return parts.every((part) => part !== undefined) ? parts.join("/") : undefined;
  }
  return undefined;
}

function fileScope({ path, text }: SourceFile): FileScope {
  const program = parseAst(
    text,
    { lang: path.endsWith(".tsx") ? "tsx" : "ts" },
    path,
  ) as unknown as Node;
  const scope: FileScope = {
    path,
    text,
    program,
    joins: new Set(),
    pathModules: new Set(),
    imported: new Map(),
    constants: new Map(),
  };
  const body = program.body as Node[];
  for (const statement of body) {
    if (statement.type !== "ImportDeclaration") continue;
    const fromPath = /^(node:)?path(\/posix)?$/.test((statement.source as Node).value as string);
    for (const specifier of statement.specifiers as Node[]) {
      const local = nameOf(specifier.local as Node)!;
      if (specifier.type !== "ImportSpecifier") {
        if (fromPath) scope.pathModules.add(local);
        continue;
      }
      const imported =
        nameOf(specifier.imported as Node) ?? String((specifier.imported as Node).value);
      scope.imported.set(local, imported);
      if (fromPath && (imported === "join" || imported === "resolve")) scope.joins.add(local);
      if (fromPath && imported === "posix") scope.pathModules.add(local);
    }
  }
  for (const statement of body) {
    const declaration =
      statement.type === "ExportNamedDeclaration"
        ? (statement.declaration as Node | null)
        : statement;
    if (declaration?.type !== "VariableDeclaration" || declaration.kind !== "const") continue;
    for (const declarator of declaration.declarations as Node[]) {
      const name = nameOf(declarator.id as Node);
      const value = declarator.init ? staticPath(declarator.init as Node, scope) : undefined;
      if (name !== undefined && value !== undefined) scope.constants.set(name, value);
    }
  }
  return scope;
}

/**
 * Every top-level area the recognised wiring places under the profile root.
 * Pure over the sources it is given, so a test can hand it a mutated file.
 */
function profileWiring(sources: readonly SourceFile[]): Wiring[] {
  const scopes = sources.map(fileScope);
  // Constant name → every distinct static value it has anywhere scanned.
  const constants = new Map<string, Set<string>>();
  for (const scope of scopes) {
    for (const [name, value] of scope.constants) {
      constants.set(name, (constants.get(name) ?? new Set()).add(value));
    }
  }
  return scopes.flatMap((scope) => scanFile(scope, constants));
}

/** The first `/` segment of a static path; `""`, `.` and `..` are not an area. */
function fromStatic(path: string, text: string): Segment {
  const first = path.split("/")[0] ?? "";
  return ["", ".", ".."].includes(first)
    ? { kind: "dynamic", text }
    : { kind: "name", name: first };
}

function scanFile(scope: FileScope, constants: Map<string, Set<string>>): Wiring[] {
  const notRoots = new Set(FILE_NOT_ROOTS[scope.path] ?? []);
  const roots = new Set(
    [...ROOT_NAMES, ...(FILE_ROOTS[scope.path] ?? [])].filter((name) => !notRoots.has(name)),
  );
  const sourceOf = (node: Node): string => scope.text.slice(node.start, node.end);

  const isRoot = (node: Node): boolean => {
    const expression = unwrap(node);
    const name = nameOf(expression);
    if (name !== undefined) return roots.has(name);
    if (expression.type === "MemberExpression" && !expression.computed)
      return roots.has(nameOf(expression.property as Node) ?? "");
    if (expression.type !== "CallExpression") return false;
    const callee = unwrap(expression.callee as Node);
    const [argument] = expression.arguments as Node[];
    return (
      callee.type === "MemberExpression" &&
      nameOf(callee.property as Node) === "getPath" &&
      argument !== undefined &&
      staticPath(argument, scope) === "userData"
    );
  };

  // Simple aliases — `const root = app.getPath("userData")` — file-scoped,
  // shadowing ignored.
  walk(scope.program, (node) => {
    const name = node.type === "VariableDeclarator" ? nameOf(node.id as Node) : undefined;
    if (name !== undefined && !notRoots.has(name) && node.init && isRoot(node.init as Node))
      roots.add(name);
  });

  const segmentOf = (node: Node): Segment => {
    const expression = unwrap(node);
    const text = sourceOf(node);
    const literal = staticPath(expression, scope);
    if (literal !== undefined) return fromStatic(literal, text);
    if (expression.type === "TemplateLiteral") {
      const head = ((expression.quasis as Node[])[0]!.value as { cooked: string }).cooked;
      if (head.includes("/")) return fromStatic(head, text);
      return head === "" ? { kind: "dynamic", text } : { kind: "prefix", prefix: head };
    }
    const name = nameOf(expression);
    if (name !== undefined) {
      // Only a name this file declares at top level or imports: a parameter
      // that merely shares a constant's name stays dynamic.
      const local = scope.constants.get(name);
      if (local !== undefined) return fromStatic(local, text);
      const imported = scope.imported.get(name);
      const values = imported === undefined ? undefined : constants.get(imported);
      if (values?.size === 1) return fromStatic([...values][0]!, text);
    }
    return { kind: "dynamic", text };
  };

  const found: Wiring[] = [];
  walk(scope.program, (node) => {
    if (node.type !== "CallExpression" || !isPathJoin(node, scope)) return;
    const [root, area] = node.arguments as Node[];
    if (root === undefined || area === undefined || !isRoot(root)) return;
    const line = scope.text.slice(0, node.start).split("\n").length;
    const segment: Segment =
      area.type === "SpreadElement" ? { kind: "dynamic", text: sourceOf(area) } : segmentOf(area);
    found.push({ file: scope.path, line, segment });
  });
  return found;
}

/** The register's areas are literal names or `*` globs. */
function areaMatches(area: string, name: string): boolean {
  const pattern = area
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${pattern}$`).test(name);
}

const decided = (name: string): boolean =>
  PROFILE_FILE_DECISIONS.some((entry) => areaMatches(entry.area, name));

/** A templated name is decided only by a trailing glob every expansion falls under. */
const prefixDecided = (prefix: string): boolean =>
  PROFILE_FILE_DECISIONS.some(({ area }) => {
    const stem = area.slice(0, -1);
    return area.endsWith("*") && !stem.includes("*") && prefix.startsWith(stem);
  });

/** Every wiring site with no decision, as readable lines. */
function undecided(wiring: readonly Wiring[]): string[] {
  return wiring.flatMap(({ file, line, segment }) => {
    const at = `${file}:${line}`;
    if (segment.kind === "name")
      return decided(segment.name) ? [] : [`${at} creates "${segment.name}" with no decision`];
    if (segment.kind === "prefix")
      return prefixDecided(segment.prefix)
        ? []
        : [`${at} creates "${segment.prefix}*" with no glob decision`];
    const reviewed = REVIEWED_DYNAMIC_SEGMENTS[`${file}::${segment.text}`];
    if (reviewed === undefined)
      return [`${at} joins an unreviewed dynamic segment ${segment.text}`];
    return decided(reviewed.sample)
      ? []
      : [`${at} creates "${reviewed.sample}" (${segment.text}) with no decision`];
  });
}

describe("profile wiring against the backup register (VC-829)", () => {
  const sources = readProductionSources();
  const wiring = profileWiring(sources);

  it("reads the production wiring it claims to, not an empty or test-only tree", () => {
    expect(sources.length).toBeGreaterThan(100);
    expect(
      sources.filter(({ path }) => /\.test\.ts$|test-support|fixture|testing\//.test(path)),
    ).toEqual([]);
    // Not a list of what must exist: proof that each recognised form —
    // literal, property root, multi-segment, imported constant — is seen,
    // in all three trees.
    const names = new Set(
      wiring.flatMap(({ segment }) => (segment.kind === "name" ? [segment.name] : [])),
    );
    for (const name of [
      "blobs",
      "session-transcripts",
      "volli.db",
      "shell",
      "session-secrets.key",
    ]) {
      expect(names, `${name} should be discovered from source`).toContain(name);
    }
    for (const tree of SCANNED_TREES) {
      expect(
        wiring.some(({ file }) => file.startsWith(`${tree}/`)),
        tree,
      ).toBe(true);
    }
  });

  it("has a decision for every profile area named by the recognised production wiring", () => {
    expect(undecided(wiring)).toEqual([]);
  });

  it("keeps no reviewed dynamic segment the source no longer contains", () => {
    const present = new Set(
      wiring.flatMap(({ file, segment }) =>
        segment.kind === "dynamic" ? [`${file}::${segment.text}`] : [],
      ),
    );
    expect(Object.keys(REVIEWED_DYNAMIC_SEGMENTS).filter((key) => !present.has(key))).toEqual([]);
  });

  it("fails for a new store joined under the profile root without a decision", () => {
    const target = "packages/host-core/src/blob-store.ts";
    const original = sources.find(({ path }) => path === target)!;
    expect(original, `${target} hosts the mutation`).toBeDefined();
    const mutated: SourceFile = {
      path: target,
      text:
        original.text +
        "\nexport function unregisteredStoreRoot(userDataPath: string): string {\n" +
        '  return join(userDataPath, "unregistered-store");\n}\n',
    };

    expect(undecided(profileWiring([original]))).toEqual([]);
    expect(undecided(profileWiring([mutated]))).toEqual([
      expect.stringMatching(
        /^packages\/host-core\/src\/blob-store\.ts:\d+ creates "unregistered-store" with no decision$/,
      ),
    ]);
  });

  it("follows constants and templates, and leaves non-roots and Chromium's profile alone", () => {
    const probe = (path: string, text: string): string[] =>
      undecided(profileWiring([{ path, text }]));

    expect(
      probe(
        "apps/hostd/src/probe.ts",
        'import { join } from "node:path";\nexport const PROBE_FILE = join("probe-dir", "x.json");\n' +
          "export const at = (dataDir: string) => join(dataDir, PROBE_FILE);\n",
      ),
    ).toEqual([expect.stringContaining('creates "probe-dir"')]);
    expect(
      probe(
        "apps/hostd/src/probe.ts",
        'import * as path from "node:path";\n' +
          "export const at = (o: { userData: string }, n: number) => path.join(o.userData, `probe-${n}`);\n",
      ),
    ).toEqual([expect.stringContaining('creates "probe-*" with no glob decision')]);
    // A parameter that shares a constant's name is not that constant.
    expect(
      probe(
        "apps/hostd/src/probe.ts",
        'import { join } from "node:path";\n' +
          "export const at = (dataDir: string, STATUS_FILE_NAME: string) => join(dataDir, STATUS_FILE_NAME);\n",
      ),
    ).toEqual([expect.stringContaining("unreviewed dynamic segment STATUS_FILE_NAME")]);
    expect(
      probe(
        "packages/host-core/src/browser/chromium-launch.ts",
        'import { join } from "node:path";\n' +
          "export const at = (profileRoot: string, userDataDir: string, cwd: string, dataDir: string) =>\n" +
          '  [join(profileRoot, "Default"), join(userDataDir, "Default"), join(cwd, "x"), [dataDir, "y"].join("/")];\n',
      ),
    ).toEqual([]);
  });
});
