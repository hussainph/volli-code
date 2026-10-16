import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import {
  appendMissingMigrationLocks,
  assertContiguousVersions,
  assertMigrationLock,
  formatMigrationLock,
  LOCK_COMMAND,
  LOCK_PATH,
  MIGRATIONS_PATH,
  migrationFingerprints,
} from "../../scripts/migrations-lock.mjs";
import { MIGRATIONS } from "./migrations";

const text = readFileSync(LOCK_PATH, "utf8");
const lock = JSON.parse(text) as Record<string, string | number>;
const fingerprints = migrationFingerprints(MIGRATIONS);

function assertSourceEdit(oldText: string, newText: string, version: number): void {
  const changed = migrationFingerprints(MIGRATIONS, (path: string) => {
    const source = readFileSync(path, "utf8");
    if (path !== MIGRATIONS_PATH) return source;
    expect(source).toContain(oldText);
    return source.replace(oldText, newText);
  });
  expect(() => assertMigrationLock(MIGRATIONS, changed, lock)).toThrow(
    `you edited shipped migration ${version}: add a new migration instead`,
  );
}

function fingerprintWithHelper(declaration: string) {
  return migrationFingerprints(MIGRATIONS, (path: string) => {
    const source = readFileSync(path, "utf8");
    if (path !== MIGRATIONS_PATH) return source;
    return `${source.replace(
      "function applyMigration033RunAttendance(db: Database.Database): void {",
      "function applyMigration033RunAttendance(db: Database.Database): void { void FrozenHelper;",
    )}\n${declaration}\n`;
  });
}

describe("shipped migration lock", () => {
  it("locks the contiguous history and derives the same head as MIGRATIONS", () => {
    expect(() => assertMigrationLock(MIGRATIONS, fingerprints, lock)).not.toThrow();
    expect(text).toBe(formatMigrationLock(lock));
    expect(Object.keys(lock).findLast((key) => key !== "format")).toBe(
      String(MIGRATIONS.at(-1)!.version),
    );
  });

  it("rejects a deliberate edit to shipped SQL", () => {
    const edited = MIGRATIONS.map((migration) =>
      migration.version === 1 ? { ...migration, sql: `${migration.sql}\nSELECT 1;` } : migration,
    );
    expect(() => assertMigrationLock(edited, migrationFingerprints(edited), lock)).toThrow(
      "you edited shipped migration 1: add a new migration instead",
    );
  });

  // VC-602: whether a migration raises the minimum reader version shipped with
  // it. Declaring it on (or off) after the fact would let an older build open a
  // file it cannot use, or lock one out for nothing.
  it("rejects declaring raisesMinReader on a shipped migration", () => {
    for (const version of [1, MIGRATIONS.at(-1)!.version]) {
      const declared = MIGRATIONS.map((migration) =>
        migration.version === version
          ? { ...migration, raisesMinReader: true as const }
          : migration,
      );
      expect(() => assertMigrationLock(declared, migrationFingerprints(declared), lock)).toThrow(
        `you edited shipped migration ${version}: add a new migration instead`,
      );
    }
  });

  it("locks a new migration's raisesMinReader declaration with it", () => {
    const version = MIGRATIONS.at(-1)!.version + 1;
    const raising = [
      ...MIGRATIONS,
      { version, name: "breaking", sql: "SELECT 1;", raisesMinReader: true as const },
    ];
    const additive = [...MIGRATIONS, { version, name: "breaking", sql: "SELECT 1;" }];
    const raisingFingerprints = migrationFingerprints(raising);
    expect(raisingFingerprints[version]).not.toBe(migrationFingerprints(additive)[version]);
    const locked = JSON.parse(appendMissingMigrationLocks(raising, raisingFingerprints, text));
    expect(() => assertMigrationLock(raising, raisingFingerprints, locked)).not.toThrow();
    // Dropping the declaration once locked is an edit, too.
    expect(() => assertMigrationLock(additive, migrationFingerprints(additive), locked)).toThrow(
      `you edited shipped migration ${version}: add a new migration instead`,
    );
  });

  it("accepts raisesMinReader only as true or absent", () => {
    const version = MIGRATIONS.at(-1)!.version + 1;
    const malformed = [
      ...MIGRATIONS,
      { version, name: "x", sql: "SELECT 1;", raisesMinReader: false as unknown as true },
    ];
    expect(() => migrationFingerprints(malformed)).toThrow(
      `Migration ${version}: raisesMinReader must be \`true\` or omitted`,
    );
  });

  it("rejects a deliberate edit to shipped apply source", () => {
    assertSourceEdit('column.name === "attendance"', 'column.name === "changed_attendance"', 33);
  });

  it("locks helpers and SQL referenced by apply, not just its function body", () => {
    assertSourceEdit('if (!names.has("merged_at"))', 'if (!names.has("changed_merged_at"))', 46);
    // 024 executes 023's SQL for the old parallel lineage too.
    const changed = migrationFingerprints(MIGRATIONS, (path: string) =>
      readFileSync(path, "utf8").replace(
        "CREATE TABLE legacy_safe_storage_secrets (",
        "CREATE TABLE changed_legacy_secrets (",
      ),
    );
    expect(changed[24]).not.toBe(fingerprints[24]);
  });

  it("locks imported apply helpers as well", () => {
    const changed = migrationFingerprints(MIGRATIONS, (path: string) => {
      const source = readFileSync(path, "utf8");
      return path.endsWith("native-observation-id.ts")
        ? source.replace(
            "export function compactNativeObservationEventId(",
            "export function compactNativeObservationEventId( /* shipped edit */",
          )
        : source;
    });
    expect(changed[42]).not.toBe(fingerprints[42]);
    expect(() => assertMigrationLock(MIGRATIONS, changed, lock)).toThrow(
      "you edited shipped migration 42: add a new migration instead",
    );
  });

  it("does not relock shipped apply code when an unrelated import is added", () => {
    const changed = migrationFingerprints(MIGRATIONS, (path: string) => {
      const source = readFileSync(path, "utf8");
      return path === MIGRATIONS_PATH
        ? source.replace(
            "import { compactNativeObservationEventId }",
            "import { compactNativeObservationEventId, unrelatedHelper }",
          )
        : source;
    });
    expect(changed).toEqual(fingerprints);
  });

  it("fingerprints original source independently of runtime function transforms", () => {
    const transformed = MIGRATIONS.map((migration) =>
      migration.apply
        ? {
            ...migration,
            apply: () => {
              throw new Error("stand-in for transformed function source");
            },
          }
        : migration,
    );
    expect(migrationFingerprints(transformed)).toEqual(fingerprints);
  });

  it.each([
    ['class FrozenHelper { value = "before"; }', 'class FrozenHelper { value = "after"; }'],
    ['enum FrozenHelper { Value = "before" }', 'enum FrozenHelper { Value = "after" }'],
    [
      'const { FrozenHelper } = { FrozenHelper: "before" };',
      'const { FrozenHelper } = { FrozenHelper: "after" };',
    ],
  ])("locks additional declaration kinds: %s", (before, after) => {
    expect(fingerprintWithHelper(before)[33]).not.toBe(fingerprintWithHelper(after)[33]);
  });

  it("fails loudly on an unsupported re-export dependency", () => {
    expect(() =>
      fingerprintWithHelper('export { helper as FrozenHelper } from "./some-helper";'),
    ).toThrow("re-export cannot be fingerprinted; import its declaration directly");
  });

  it("rejects a missing lock entry with the exact author command", () => {
    const head = MIGRATIONS.at(-1)!.version;
    const missing = { ...lock };
    delete missing[head];
    expect(() => assertMigrationLock(MIGRATIONS, fingerprints, missing)).toThrow(
      `new migration ${head} has no lock entry: run \`${LOCK_COMMAND}\` to add it`,
    );
  });

  it("rejects a new migration until its lock entry is appended", () => {
    const version = MIGRATIONS.at(-1)!.version + 1;
    const next = [...MIGRATIONS, { version, name: "new migration", sql: "SELECT 1;" }];
    const nextFingerprints = migrationFingerprints(next);
    expect(() => assertMigrationLock(next, nextFingerprints, lock)).toThrow(
      `new migration ${version} has no lock entry`,
    );
    const appended = appendMissingMigrationLocks(next, nextFingerprints, text);
    expect(appended.replace(`  "${version}": "${nextFingerprints[version]}",\n`, "")).toBe(text);
    expect(() => assertMigrationLock(next, nextFingerprints, JSON.parse(appended))).not.toThrow();
    expect(appendMissingMigrationLocks(next, nextFingerprints, appended)).toBe(appended);
  });

  it("never rewrites an existing fingerprint, even when a new entry is missing", () => {
    const edited = MIGRATIONS.map((migration) =>
      migration.version === 1 ? { ...migration, sql: "SELECT 1;" } : migration,
    );
    const missing = { ...lock };
    delete missing[MIGRATIONS.at(-1)!.version];
    expect(() =>
      appendMissingMigrationLocks(
        edited,
        migrationFingerprints(edited),
        formatMigrationLock(missing),
      ),
    ).toThrow("you edited shipped migration 1: add a new migration instead");
  });

  it("rejects deleting a shipped migration", () => {
    const removed = MIGRATIONS.slice(0, -1);
    expect(() => assertMigrationLock(removed, migrationFingerprints(removed), lock)).toThrow(
      `you edited shipped migration ${MIGRATIONS.at(-1)!.version}: add a new migration instead`,
    );
  });

  it.each([[1, 1], [1, 3], [2], [1, 2.5], [2, 1], []])(
    "rejects gaps, duplicates and reordering: %j",
    (...versions) => {
      expect(() => assertContiguousVersions(versions, "history")).toThrow("expected version");
    },
  );

  it("rejects malformed, duplicate, or reordered lock lines instead of rewriting them", () => {
    expect(() => appendMissingMigrationLocks(MIGRATIONS, fingerprints, `${text}\n`)).toThrow(
      "sorted, one-line entries",
    );
    const duplicate = text.replace('  "format": 1', `  "1": "${fingerprints[1]}",\n  "format": 1`);
    expect(() => appendMissingMigrationLocks(MIGRATIONS, fingerprints, duplicate)).toThrow(
      "sorted, one-line entries",
    );
  });
});
