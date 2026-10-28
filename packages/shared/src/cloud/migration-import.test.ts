import { describe, expect, it } from "vite-plus/test";

import {
  MIGRATION_DEFERRED_STREAMS,
  MIGRATION_IMPORT_STREAMS,
  MIGRATION_PLACEHOLDERS,
  MigrationDigest,
  MigrationRowError,
  canonicalJson,
  jsonBytes,
  migrationDocument,
  migrationRowDigest,
  reportableProblem,
  resolvePlaceholders,
  storageProblem,
  type MigrationImportStream,
  type MigrationTarget,
} from "./migration-import";
import { MIGRATION_FIXTURE_RECORDS, fixtureUuid } from "./migration-import.fixture";

const U = fixtureUuid;
const target: MigrationTarget = { userId: U(901), workspaceId: U(902), runnerId: U(903) };
const USER = MIGRATION_PLACEHOLDERS.userId;
const RUNNER = MIGRATION_PLACEHOLDERS.runnerId;
const WORKSPACE = MIGRATION_PLACEHOLDERS.workspaceId;
const AT = 1_800_000_000_000;
const RECORDS = MIGRATION_FIXTURE_RECORDS;

function map(stream: MigrationImportStream, overrides: Record<string, unknown> = {}) {
  return migrationDocument(stream, { ...RECORDS[stream], ...overrides }, target, AT);
}

function refusal(run: () => unknown): { code: string; field: string } {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(MigrationRowError);
    const { code, field } = error as MigrationRowError;
    return { code, field };
  }
  throw new Error("expected a refusal");
}

describe("migrationDocument", () => {
  it("maps a valid record of every stream, with no placeholder left", () => {
    for (const stream of MIGRATION_IMPORT_STREAMS) {
      const doc = map(stream);
      expect(JSON.stringify(doc)).not.toContain("$local");
      expect(JSON.stringify(doc)).not.toContain("$target");
    }
    expect(MIGRATION_DEFERRED_STREAMS.automationScheduleCursors).toContain("scheduler");
  });

  it("supplies the backend defaults and drops export-only fields", () => {
    const project = map("projects");
    expect(project).toMatchObject({
      workspaceId: target.workspaceId,
      createdByUserId: target.userId,
      shipBehaviour: "commit",
      coAuthorDefault: true,
      deletedAt: null,
    });
    expect(project).not.toHaveProperty("removedAt");

    const session = map("sessions");
    expect(session).toMatchObject({ origin: { kind: "user" }, status: "open", usageTotals: null });
    expect(session).not.toHaveProperty("lastSequence");
    expect(map("sessions", { parentSessionId: U(30) }).origin).toEqual({
      kind: "session",
      sessionId: U(30),
    });

    expect(map("memberProjectPrefs")).toMatchObject({ themeCanvas: null, themeAppearance: null });
    expect(map("runnerJobs")).toMatchObject({
      rank: 1,
      status: "queued",
      runnerId: target.runnerId,
    });
    expect(map("workingCopies").dirty).toMatchObject({ files: 0 });
  });

  it("restricts a legacy setup command to the Mac it ran on", () => {
    expect(map("projectEnvironment")).toMatchObject({
      runsOn: ["mac", "linux", "cloud"],
      requiresOs: "any",
    });
    expect(map("projectEnvironment", { storedSetup: "make" })).toMatchObject({
      runsOn: ["mac"],
      requiresOs: "macos",
    });
  });

  it("derives a config entry's scope key from its level", () => {
    expect(map("configEntries").scopeKey).toBe(`p:${U(1)}`);
    expect(
      map("configEntries", { level: "personal", userId: USER, projectId: null }).scopeKey,
    ).toBe(`u:${target.userId}`);
    expect(refusal(() => map("configEntries", { level: "workspace" }))).toEqual({
      code: "invalid_field",
      field: "level",
    });
  });

  it("keeps a failed attempt's error and retry key", () => {
    expect(map("automationRuns")).toMatchObject({
      trigger: "manual",
      error: "boom",
      retryCommandId: "cmd-1",
      model: null,
      skipReason: null,
    });
    const plain = map("automationRuns", {
      trigger: "arrival",
      error: undefined,
      retryCommandId: undefined,
    });
    expect(plain.trigger).toBe("arrival");
    expect(plain).not.toHaveProperty("error");
    expect(plain).not.toHaveProperty("retryCommandId");
  });

  it("stores a Session event's id as eventId and its payload kind as kind, stamped on accept", () => {
    expect(map("sessionEvents")).toMatchObject({
      eventId: "event-1",
      kind: "session.created",
      acceptedAt: AT,
    });
    expect(refusal(() => map("sessionEvents", { id: "" })).field).toBe("id");
    expect(refusal(() => map("sessionEvents", { payload: { kind: 3 } })).field).toBe(
      "payload.kind",
    );
    expect(refusal(() => map("sessionEvents", { payload: [1] })).field).toBe("record");
    expect(refusal(() => map("sessionEvents", { kindKnown: undefined })).field).toBe("kindKnown");
  });

  it("keeps a moved blob link's source ordering without requiring it on older exports", () => {
    expect(map("blobLinks", { sourceOrder: 23 })).toMatchObject({ sourceOrder: 23 });
    expect(map("blobLinks")).not.toHaveProperty("sourceOrder");
  });

  it("claims a Session's intake for the target runner", () => {
    expect(map("sessionIntake")).toMatchObject({
      claim: { runnerId: target.runnerId, generation: 1 },
      lastAcceptedAt: AT,
      state: "active",
    });
    expect(map("sessionIntake", { acceptedThrough: 0 }).lastAcceptedAt).toBeNull();
  });

  it("names a pre-claim delegation from its child", () => {
    const doc = map("delegations", {
      toolCallId: null,
      createCommandId: undefined,
      createdAt: null,
    });
    expect(doc).toMatchObject({
      toolCallId: `legacy:${U(22)}`,
      createCommandId: `legacy:${U(22)}`,
      createdAt: 0,
      status: "stopped",
    });
    expect(map("delegations").toolCallId).toBe("call-1");
  });

  it("refuses ids that are not canonical UUIDs", () => {
    expect(refusal(() => map("tickets", { id: "ticket-1" }))).toEqual({
      code: "invalid_id",
      field: "id",
    });
    expect(refusal(() => map("tickets", { assigneeUserId: "NOPE" })).field).toBe("assigneeUserId");
    expect(refusal(() => map("tickets", { labelIds: ["x"] })).field).toBe("labelIds");
    expect(refusal(() => map("tickets", { labelIds: null })).field).toBe("labelIds");
    expect(refusal(() => map("blobLinks", { owner: { kind: "ticket", id: "t" } })).field).toBe(
      "id",
    );
    expect(refusal(() => migrationDocument("projects", null, target, AT)).field).toBe("record");
  });

  it("refuses a document the backend could not store", () => {
    const deep: Record<string, unknown> = {};
    let node = deep;
    for (let i = 0; i < 20; i += 1) node = node.next = {} as Record<string, unknown>;
    expect(refusal(() => map("boardEvents", { payload: deep })).code).toBe("unstorable");
    expect(refusal(() => map("ticketBodies", { body: "x".repeat(1024 * 1024) })).code).toBe(
      "unstorable",
    );
  });
});

describe("reportableProblem", () => {
  it("keeps the rule and the top-level field, never the keys below it", () => {
    expect(reportableProblem("field name the backend refuses at $.payload.secret-path.x")).toBe(
      "field name the backend refuses in payload",
    );
    expect(reportableProblem("array longer than 8192 at $")).toBe("array longer than 8192");
    expect(reportableProblem("document larger than 10 bytes")).toBe(
      "document larger than 10 bytes",
    );
    expect(reportableProblem("non-finite number at $[1][0]")).toBe("non-finite number");
  });
});

describe("resolvePlaceholders", () => {
  it("replaces whole values only, at any depth", () => {
    expect(
      resolvePlaceholders(
        { a: [USER, `${USER}-x`], b: { c: RUNNER, d: WORKSPACE, e: 1, f: null } },
        target,
      ),
    ).toEqual({
      a: [target.userId, `${USER}-x`],
      b: { c: target.runnerId, d: target.workspaceId, e: 1, f: null },
    });
  });
});

describe("storageProblem", () => {
  it("accepts plain JSON and names the first rule a value breaks", () => {
    expect(storageProblem({ a: [1, "x", true, null, { _b: 2 }] })).toBeNull();
    expect(storageProblem({ a: { $schema: "x" } })).toBe("field name the backend refuses at $.a");
    expect(storageProblem({ é: 1 })).toBe("field name the backend refuses at $");
    expect(storageProblem({ "": 1 })).toBe("field name the backend refuses at $");
    expect(storageProblem({ ["k".repeat(1025)]: 1 })).toBe("field name the backend refuses at $");
    expect(storageProblem([0, [Number.NaN]])).toBe("non-finite number at $[1][0]");
    expect(storageProblem(Array.from({ length: 8193 }, () => 0))).toBe(
      "array longer than 8192 at $",
    );
    expect(storageProblem({ a: [{ b: Infinity }] })).toBe("non-finite number at $.a[0].b");
    expect(
      storageProblem(Object.fromEntries(Array.from({ length: 1025 }, (_, i) => [`k${i}`, i]))),
    ).toBe("object with more than 1024 fields at $");
  });
});

describe("digests", () => {
  it("canonical JSON sorts keys, drops undefined fields and keeps array order", () => {
    expect(canonicalJson({ b: 1, a: [2, undefined, { d: undefined, c: "x" }], e: null })).toBe(
      '{"a":[2,null,{"c":"x"}],"b":1,"e":null}',
    );
    expect(canonicalJson(undefined)).toBe("null");
    expect(jsonBytes(undefined)).toBe(4);
    expect(jsonBytes({ a: "é" })).toBe(10);
  });

  it("row digests ignore stamped fields and key order", () => {
    const a = migrationRowDigest("sessionEvents", { sessionId: "s", acceptedAt: 1, sequence: 1 });
    const b = migrationRowDigest("sessionEvents", { sequence: 1, sessionId: "s", acceptedAt: 2 });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(migrationRowDigest("tickets", { acceptedAt: 1 })).not.toBe(
      migrationRowDigest("tickets", { acceptedAt: 2 }),
    );
  });

  it("the table digest is order-independent and does not cancel duplicates", () => {
    const rows = ["a", "b", "c"].map((id) => migrationRowDigest("tickets", { id }));
    const forward = new MigrationDigest();
    const backward = new MigrationDigest();
    for (const row of rows) forward.add(row);
    for (const row of rows.toReversed()) backward.add(row);
    expect(forward.value).toBe(backward.value);
    expect(forward.count).toBe(3);
    expect(new MigrationDigest().value).toBe("0".repeat(32));

    const twice = new MigrationDigest();
    twice.add(rows[0]!);
    twice.add(rows[0]!);
    expect(twice.value).not.toBe(new MigrationDigest().value);
    const full = new MigrationDigest();
    full.add("f".repeat(64));
    full.add("0".repeat(31) + "1");
    expect(full.value).toBe("0".repeat(32));
  });

  it("a resumed digest continues batch by batch to the same value", () => {
    const rows = ["a", "b", "c", "d"].map((id) => migrationRowDigest("tickets", { id }));
    const whole = new MigrationDigest();
    for (const row of rows) whole.add(row);
    const first = new MigrationDigest();
    first.add(rows[2]!);
    first.add(rows[0]!);
    const second = MigrationDigest.resume(first.count, first.value);
    second.add(rows[3]!);
    second.add(rows[1]!);
    expect(second.count).toBe(4);
    expect(second.value).toBe(whole.value);
    expect(MigrationDigest.resume(0, "0".repeat(32)).value).toBe(new MigrationDigest().value);
    expect(() => MigrationDigest.resume(-1, "0".repeat(32))).toThrow(RangeError);
    expect(() => MigrationDigest.resume(1.5, "0".repeat(32))).toThrow(RangeError);
    expect(() => MigrationDigest.resume(0, "F".repeat(32))).toThrow(RangeError);
    expect(() => MigrationDigest.resume(0, "0".repeat(31))).toThrow(RangeError);
  });

  it("a project's move state is stamped, never digested", () => {
    expect(migrationRowDigest("projects", { id: "p", moveState: "importing" })).toBe(
      migrationRowDigest("projects", { id: "p" }),
    );
  });
});
