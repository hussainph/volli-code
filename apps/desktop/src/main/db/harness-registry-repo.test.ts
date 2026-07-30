import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import {
  getRegisteredHarness,
  listRegisteredHarnesses,
  markHarnessEventVerified,
  recordHarnessTrust,
  restoreRegisteredHarness,
} from "./harness-registry-repo";
import { openTestDb, type TestDb } from "./test-helpers";

let fixture: TestDb;

beforeEach(() => {
  fixture = openTestDb();
});

afterEach(() => {
  fixture.cleanup();
});

const manifest = {
  slug: "my-harness",
  manifestPath: "/home/dev/.agents/harnesses/my-harness/harness.json",
  manifestSha256: "a1",
  decision: "trusted",
  declaredEvents: ["input.needed", "turn.completed"],
} as const;

describe("recordHarnessTrust", () => {
  it("records a verdict about specific manifest bytes, and reads it back", () => {
    recordHarnessTrust(fixture.db, manifest, 1000);
    const record = getRegisteredHarness(fixture.db, "my-harness");
    expect(record).toMatchObject({
      slug: "my-harness",
      manifestPath: manifest.manifestPath,
      manifestSha256: "a1",
      decision: "trusted",
      declaredEvents: ["input.needed", "turn.completed"],
      verifiedEvents: [],
      decidedAt: 1000,
      createdAt: 1000,
    });
  });

  it("reads nothing for a harness nobody has ruled on", () => {
    expect(getRegisteredHarness(fixture.db, "my-harness")).toBeUndefined();
  });

  it("stores no copy of the manifest's contents beyond what a verdict is about", () => {
    recordHarnessTrust(fixture.db, manifest, 1000);
    const row = fixture.db.prepare("SELECT * FROM registered_harnesses").get() as Record<
      string,
      unknown
    >;
    expect(Object.keys(row).toSorted()).toEqual([
      "created_at",
      "decided_at",
      "decision",
      "declared_events",
      "manifest_path",
      "manifest_sha256",
      "slug",
      "updated_at",
      "verified_events",
    ]);
  });

  it("keeps the verified ledger when the same bytes are ruled on again", () => {
    recordHarnessTrust(fixture.db, manifest, 1000);
    markHarnessEventVerified(fixture.db, "my-harness", "input.needed", 1100);
    recordHarnessTrust(fixture.db, { ...manifest, decision: "blocked" }, 1200);
    expect(getRegisteredHarness(fixture.db, "my-harness")).toMatchObject({
      decision: "blocked",
      verifiedEvents: ["input.needed"],
      createdAt: 1000,
      decidedAt: 1200,
    });
  });

  it("clears the verified ledger when the manifest changed underneath it", () => {
    recordHarnessTrust(fixture.db, manifest, 1000);
    markHarnessEventVerified(fixture.db, "my-harness", "input.needed", 1100);
    recordHarnessTrust(fixture.db, { ...manifest, manifestSha256: "b2" }, 1200);
    expect(getRegisteredHarness(fixture.db, "my-harness")).toMatchObject({
      manifestSha256: "b2",
      verifiedEvents: [],
    });
  });

  it("lists every registered harness, whatever the verdict", () => {
    recordHarnessTrust(fixture.db, manifest, 1000);
    recordHarnessTrust(fixture.db, { ...manifest, slug: "other", decision: "blocked" }, 1100);
    expect(listRegisteredHarnesses(fixture.db).map((row) => row.slug)).toEqual([
      "my-harness",
      "other",
    ]);
  });
});

describe("restoreRegisteredHarness", () => {
  it("removes the row entirely when there was nothing there before", () => {
    recordHarnessTrust(fixture.db, manifest, 1000);

    restoreRegisteredHarness(fixture.db, "my-harness", undefined);

    expect(getRegisteredHarness(fixture.db, "my-harness")).toBeUndefined();
  });

  it("puts every column back, so a rolled-back write leaves no trace", () => {
    recordHarnessTrust(fixture.db, manifest, 1000);
    markHarnessEventVerified(fixture.db, "my-harness", "input.needed", 1100);
    const before = getRegisteredHarness(fixture.db, "my-harness");
    // The write being undone: a different verdict about different bytes, which
    // moves the decision, the hash, the timestamps and the ledger at once.
    recordHarnessTrust(
      fixture.db,
      { ...manifest, manifestSha256: "b2", decision: "blocked" },
      1200,
    );

    restoreRegisteredHarness(fixture.db, "my-harness", before);

    expect(getRegisteredHarness(fixture.db, "my-harness")).toEqual(before);
  });

  it("is a no-op on a harness that was never registered", () => {
    restoreRegisteredHarness(fixture.db, "ghost", undefined);

    expect(listRegisteredHarnesses(fixture.db)).toEqual([]);
  });
});

describe("markHarnessEventVerified", () => {
  it("verifies an event on its first real delivery", () => {
    recordHarnessTrust(fixture.db, manifest, 1000);
    expect(markHarnessEventVerified(fixture.db, "my-harness", "input.needed", 1100)).toBe(true);
    expect(getRegisteredHarness(fixture.db, "my-harness")?.verifiedEvents).toEqual([
      "input.needed",
    ]);
  });

  it("is a no-op on every delivery after the first", () => {
    recordHarnessTrust(fixture.db, manifest, 1000);
    markHarnessEventVerified(fixture.db, "my-harness", "input.needed", 1100);
    expect(markHarnessEventVerified(fixture.db, "my-harness", "input.needed", 1200)).toBe(false);
    expect(getRegisteredHarness(fixture.db, "my-harness")?.verifiedEvents).toEqual([
      "input.needed",
    ]);
  });

  it("verifies an event the manifest never declared — delivery is the evidence", () => {
    recordHarnessTrust(fixture.db, manifest, 1000);
    expect(markHarnessEventVerified(fixture.db, "my-harness", "session.ended", 1100)).toBe(true);
    expect(getRegisteredHarness(fixture.db, "my-harness")?.verifiedEvents).toEqual([
      "session.ended",
    ]);
  });

  it("records nothing for a harness that was never registered", () => {
    expect(markHarnessEventVerified(fixture.db, "ghost", "input.needed", 1100)).toBe(false);
    expect(listRegisteredHarnesses(fixture.db)).toEqual([]);
  });
});

describe("a hand-edited row", () => {
  it("drops event names that are not part of the canonical union", () => {
    recordHarnessTrust(fixture.db, manifest, 1000);
    fixture.db
      .prepare("UPDATE registered_harnesses SET declared_events = ?, verified_events = ?")
      .run('["input.needed","agent.vibed"]', "not json at all");
    expect(getRegisteredHarness(fixture.db, "my-harness")).toMatchObject({
      declaredEvents: ["input.needed"],
      verifiedEvents: [],
    });
  });

  it("is ignored entirely when its slug could not name a harness", () => {
    recordHarnessTrust(fixture.db, manifest, 1000);
    fixture.db.prepare("UPDATE registered_harnesses SET slug = 'Not A Slug'").run();
    expect(listRegisteredHarnesses(fixture.db)).toEqual([]);
    expect(getRegisteredHarness(fixture.db, "Not A Slug")).toBeUndefined();
  });
});
