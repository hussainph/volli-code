import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSync } from "vite";

export const LOCK_COMMAND = "pnpm --filter @volli/desktop migrations:lock";
export const MIGRATIONS_PATH = fileURLToPath(
  new URL("../src/main/db/migrations.ts", import.meta.url),
);
export const LOCK_PATH = fileURLToPath(
  new URL("../src/main/db/migrations.lock.json", import.meta.url),
);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function walk(node, visit) {
  if (!node || typeof node !== "object") return;
  if (typeof node.type === "string") visit(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach((child) => walk(child, visit));
    else if (value && typeof value === "object") walk(value, visit);
  }
}

function bindingNames(pattern) {
  if (!pattern) return [];
  if (pattern.type === "Identifier") return [pattern.name];
  if (pattern.type === "AssignmentPattern") return bindingNames(pattern.left);
  if (pattern.type === "RestElement") return bindingNames(pattern.argument);
  if (pattern.type === "ArrayPattern") return pattern.elements.flatMap(bindingNames);
  if (pattern.type === "ObjectPattern") {
    return pattern.properties.flatMap((property) =>
      bindingNames(property.type === "RestElement" ? property.argument : property.value),
    );
  }
  throw new Error(`Unsupported migration binding: ${pattern.type}`);
}

/**
 * Original TS, not fn.toString(): SSR rewrites imports to __vite_ssr_import_N__,
 * while pack renames/inlines them. Source spans survive both transforms. Follow
 * referenced declarations too: editing a reconciler's helper/SQL is an edit to
 * the shipped migration even when its own function body is unchanged.
 */
export function migrationFingerprints(
  migrations,
  readSource = (path) => readFileSync(path, "utf8"),
) {
  const modules = new Map();
  function moduleAt(path) {
    if (modules.has(path)) return modules.get(path);
    const source = readSource(path).replaceAll("\r\n", "\n");
    const parsed = parseSync(path, source);
    if (parsed.errors.length) throw new Error(`Cannot fingerprint ${path}: invalid TypeScript`);
    const declarations = new Map();
    for (const statement of parsed.program.body) {
      const node = statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
      if (["FunctionDeclaration", "ClassDeclaration", "TSEnumDeclaration"].includes(node?.type)) {
        declarations.set(node.id.name, node);
      }
      if (node?.type === "VariableDeclaration") {
        for (const declaration of node.declarations) {
          for (const name of bindingNames(declaration.id)) declarations.set(name, declaration);
        }
      }
      if (statement.type === "ExportNamedDeclaration") {
        for (const specifier of statement.specifiers) {
          declarations.set(specifier.exported.name, { unsupported: "re-export" });
        }
      }
      if (node?.type === "ImportDeclaration" && node.importKind !== "type") {
        for (const specifier of node.specifiers) {
          if (specifier.importKind !== "type") {
            declarations.set(specifier.local.name, {
              imported:
                specifier.type === "ImportSpecifier" ? specifier.imported.name : "unsupported",
              from: node.source.value,
              // Adding an unrelated import to this statement must not relock
              // an old migration; only its module/export dependency is frozen.
              text: JSON.stringify([
                node.source.value,
                specifier.type === "ImportSpecifier" ? specifier.imported.name : specifier.type,
              ]),
            });
          }
        }
      }
    }
    const result = { source, declarations };
    modules.set(path, result);
    return result;
  }

  function declarationSource(path, name, seen = new Set()) {
    const key = `${path}:${name}`;
    if (seen.has(key)) return [];
    seen.add(key);
    const { source, declarations } = moduleAt(path);
    const node = declarations.get(name);
    if (!node) throw new Error(`Cannot fingerprint migration dependency ${name} in ${path}`);
    if (node.unsupported) {
      throw new Error(
        `Migration dependency ${name}: ${node.unsupported} cannot be fingerprinted; import its declaration directly`,
      );
    }
    if (node.imported) {
      // Platform/library imports are pinned by the dependency lock, not TS source.
      if (!node.from.startsWith(".") && !node.from.startsWith("@volli/")) return [node.text];
      if (node.imported === "unsupported") {
        throw new Error(`Migration dependency ${name}: use a named source import`);
      }
      let target = node.from.startsWith(".")
        ? resolve(dirname(path), node.from)
        : fileURLToPath(import.meta.resolve(node.from));
      if (!/\.[cm]?[jt]s$/.test(target)) target += ".ts";
      return [node.text, ...declarationSource(target, node.imported, seen)];
    }
    const references = new Set();
    walk(node, (child) => {
      if (child.type === "Identifier" && declarations.has(child.name) && child.name !== name) {
        references.add(child.name);
      }
    });
    return [
      source.slice(node.start, node.end),
      ...[...references]
        .toSorted()
        .flatMap((reference) => declarationSource(path, reference, seen)),
    ];
  }

  const { declarations } = moduleAt(MIGRATIONS_PATH);
  const registry = declarations.get("MIGRATIONS")?.init;
  const entries = registry?.type === "TSAsExpression" ? registry.expression : registry;
  if (entries?.type !== "ArrayExpression") throw new Error("MIGRATIONS must be an array literal");
  const applyNames = new Map();
  for (const entry of entries.elements) {
    if (entry?.type !== "ObjectExpression")
      throw new Error("MIGRATIONS entries must be object literals");
    const properties = new Map(
      entry.properties.map((property) => [property.key?.name, property.value]),
    );
    const version = properties.get("version")?.value;
    const apply = properties.get("apply");
    if (apply && apply.type !== "Identifier") {
      throw new Error(`Migration ${version}: apply must reference a named function declaration`);
    }
    if (apply) applyNames.set(version, apply.name);
  }
  return Object.fromEntries(
    migrations.map((migration) => {
      const name = applyNames.get(migration.version);
      if (Boolean(migration.apply) !== Boolean(name)) {
        throw new Error(`Migration ${migration.version}: source/runtime apply mismatch`);
      }
      const applySource = name ? declarationSource(MIGRATIONS_PATH, name) : null;
      return [migration.version, sha256(JSON.stringify([migration.sql, applySource]))];
    }),
  );
}

export function assertContiguousVersions(versions, label) {
  if (!versions.length) throw new Error(`${label}: expected versions 1..N, got no entries`);
  versions.forEach((version, index) => {
    if (version !== index + 1) {
      throw new Error(
        `${label}: expected version ${index + 1}, got ${version} (gap, duplicate or out of order)`,
      );
    }
  });
}

export function assertMigrationLock(migrations, fingerprints, lock, { allowMissing = false } = {}) {
  assertContiguousVersions(
    migrations.map((migration) => migration.version),
    "MIGRATIONS",
  );
  if (lock.format !== 1) throw new Error("Unsupported migrations.lock.json format");
  const versions = Object.keys(lock)
    .filter((key) => key !== "format")
    .map(Number);
  if (versions.length) assertContiguousVersions(versions, "migrations.lock.json");
  for (const version of versions) {
    if (!fingerprints[version] || fingerprints[version] !== lock[version]) {
      throw new Error(`you edited shipped migration ${version}: add a new migration instead`);
    }
  }
  for (const migration of migrations) {
    if (!Object.hasOwn(lock, migration.version) && !allowMissing) {
      throw new Error(
        `new migration ${migration.version} has no lock entry: run \`${LOCK_COMMAND}\` to add it`,
      );
    }
  }
  if (!allowMissing && migrations.at(-1).version !== versions.at(-1)) {
    throw new Error("Schema head must equal the last migration lock entry");
  }
}

// A final metadata sentinel leaves every version line comma-terminated: adding
// N inserts exactly one line, and two different N entries conflict in git.
export function formatMigrationLock(lock) {
  const versions = Object.keys(lock)
    .filter((key) => key !== "format")
    .map(Number);
  return `{\n${versions.map((version) => `  "${version}": "${lock[version]}",\n`).join("")}  "format": 1\n}\n`;
}

/** Preserve every existing byte; validate before appending anything. */
export function appendMissingMigrationLocks(migrations, fingerprints, text) {
  const lock = JSON.parse(text);
  assertMigrationLock(migrations, fingerprints, lock, { allowMissing: true });
  if (text !== formatMigrationLock(lock))
    throw new Error("Migration lock must use sorted, one-line entries");
  const missing = migrations.filter((migration) => !Object.hasOwn(lock, migration.version));
  const lines = missing
    .map((migration) => `  "${migration.version}": "${fingerprints[migration.version]}",\n`)
    .join("");
  return text.replace('  "format": 1\n', `${lines}  "format": 1\n`);
}
