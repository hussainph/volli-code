import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import type { HarnessId } from "@volli/shared";

import {
  decideRegisteredHarnesses,
  recordHarnessDelivery,
  scanHarnessManifests,
  trustedHarnessAdapters,
} from "./harness-registry";
import { getRegisteredHarness, recordHarnessTrust } from "./db/harness-registry-repo";
import { openTestDb, type TestDb } from "./db/test-helpers";

let root: string;
let fixture: TestDb;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "volli-harness-registry-"));
  fixture = openTestDb();
});

afterEach(async () => {
  fixture.cleanup();
  await rm(root, { recursive: true, force: true });
});

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    manifestVersion: 1,
    slug: "my-harness",
    label: "My Harness",
    command: "my-harness",
    events: [{ event: "input.needed", native: "Notification", delivery: "async", timeoutMs: 5000 }],
    ...overrides,
  };
}

/** Writes `<harnesses>/<dir>/harness.json` and returns its path. */
async function write(dir: string, body: unknown): Promise<string> {
  const directory = join(root, "harnesses", dir);
  await mkdir(directory, { recursive: true });
  const path = join(directory, "harness.json");
  await writeFile(path, typeof body === "string" ? body : JSON.stringify(body), "utf8");
  return path;
}

describe("scanHarnessManifests", () => {
  it("reads a manifest into an adapter, alongside the hash of the bytes it read", async () => {
    const path = await write("my-harness", manifest());

    const [scanned, ...rest] = await scanHarnessManifests(join(root, "harnesses"));

    expect(rest).toEqual([]);
    expect(scanned?.slug).toBe("my-harness");
    expect(scanned?.manifestPath).toBe(path);
    expect(scanned?.manifestSha256).toMatch(/^[\da-f]{64}$/);
    expect(scanned?.adapter?.command).toBe("my-harness");
    expect(scanned?.errors).toEqual([]);
  });

  it("finds nothing when nobody has registered a harness", async () => {
    expect(await scanHarnessManifests(join(root, "harnesses"))).toEqual([]);
  });

  it("ignores a directory that holds no manifest", async () => {
    await mkdir(join(root, "harnesses", "empty"), { recursive: true });
    expect(await scanHarnessManifests(join(root, "harnesses"))).toEqual([]);
  });

  it("reports unreadable JSON against the document rather than throwing at boot", async () => {
    await write("my-harness", "{ not json");

    const [scanned] = await scanHarnessManifests(join(root, "harnesses"));

    expect(scanned?.adapter).toBeNull();
    expect(scanned?.errors).toEqual([{ path: "", message: "must be readable JSON" }]);
  });

  it("keeps a hash for an invalid manifest, so fixing it counts as a change", async () => {
    await write("my-harness", manifest({ command: "/usr/bin/my-harness" }));

    const [scanned] = await scanHarnessManifests(join(root, "harnesses"));

    expect(scanned?.adapter).toBeNull();
    expect(scanned?.errors.map((error) => error.path)).toEqual(["command"]);
    expect(scanned?.manifestSha256).toMatch(/^[\da-f]{64}$/);
  });

  it("refuses a manifest whose slug is not the directory it was found in", async () => {
    await write("other-name", manifest());

    const [scanned] = await scanHarnessManifests(join(root, "harnesses"));

    expect(scanned?.adapter).toBeNull();
    expect(scanned?.errors).toEqual([
      { path: "slug", message: "must match the directory it lives in" },
    ]);
  });

  it("reads every registered harness, in directory order", async () => {
    await write("b-harness", manifest({ slug: "b-harness", command: "b-harness" }));
    await write("a-harness", manifest({ slug: "a-harness", command: "a-harness" }));

    const scanned = await scanHarnessManifests(join(root, "harnesses"));

    expect(scanned.map((entry) => entry.slug)).toEqual(["a-harness", "b-harness"]);
  });
});

describe("decideRegisteredHarnesses", () => {
  it("holds a manifest nobody has confirmed, whatever it declares", async () => {
    await write("my-harness", manifest());
    const scanned = await scanHarnessManifests(join(root, "harnesses"));

    const decided = decideRegisteredHarnesses(fixture.db, scanned);

    expect(decided[0]?.decision).toBe("reconfirm");
    expect(trustedHarnessAdapters(decided)).toEqual([]);
  });

  it("launches a manifest whose exact bytes were trusted", async () => {
    await write("my-harness", manifest());
    const scanned = await scanHarnessManifests(join(root, "harnesses"));
    recordHarnessTrust(
      fixture.db,
      {
        slug: "my-harness",
        manifestPath: scanned[0]?.manifestPath ?? "",
        manifestSha256: scanned[0]?.manifestSha256 ?? "",
        decision: "trusted",
        declaredEvents: ["input.needed"],
      },
      1000,
    );

    const decided = decideRegisteredHarnesses(fixture.db, scanned);

    expect(decided[0]?.decision).toBe("trusted");
    expect(trustedHarnessAdapters(decided).map((adapter) => adapter.id)).toEqual(["my-harness"]);
  });

  it("holds a trusted manifest again once a byte of it changes", async () => {
    await write("my-harness", manifest());
    const before = await scanHarnessManifests(join(root, "harnesses"));
    recordHarnessTrust(
      fixture.db,
      {
        slug: "my-harness",
        manifestPath: before[0]?.manifestPath ?? "",
        manifestSha256: before[0]?.manifestSha256 ?? "",
        decision: "trusted",
        declaredEvents: ["input.needed"],
      },
      1000,
    );
    await write("my-harness", manifest({ label: "My Harness (edited)" }));

    const decided = decideRegisteredHarnesses(
      fixture.db,
      await scanHarnessManifests(join(root, "harnesses")),
    );

    expect(decided[0]?.decision).toBe("reconfirm");
    expect(trustedHarnessAdapters(decided)).toEqual([]);
  });

  it("never launches a manifest that does not parse, however it was ruled on", async () => {
    await write("my-harness", manifest({ command: "volli" }));
    const scanned = await scanHarnessManifests(join(root, "harnesses"));
    recordHarnessTrust(
      fixture.db,
      {
        slug: "my-harness",
        manifestPath: scanned[0]?.manifestPath ?? "",
        manifestSha256: scanned[0]?.manifestSha256 ?? "",
        decision: "trusted",
        declaredEvents: [],
      },
      1000,
    );

    const decided = decideRegisteredHarnesses(fixture.db, scanned);

    expect(decided[0]?.decision).toBe("trusted");
    expect(trustedHarnessAdapters(decided)).toEqual([]);
  });

  it("keeps refusing a manifest the user blocked", async () => {
    await write("my-harness", manifest());
    const scanned = await scanHarnessManifests(join(root, "harnesses"));
    recordHarnessTrust(
      fixture.db,
      {
        slug: "my-harness",
        manifestPath: scanned[0]?.manifestPath ?? "",
        manifestSha256: scanned[0]?.manifestSha256 ?? "",
        decision: "blocked",
        declaredEvents: ["input.needed"],
      },
      1000,
    );

    const decided = decideRegisteredHarnesses(fixture.db, scanned);

    expect(decided[0]?.decision).toBe("blocked");
    expect(trustedHarnessAdapters(decided)).toEqual([]);
  });
});

describe("recordHarnessDelivery", () => {
  const registered = "my-harness" as HarnessId;

  function trust(declaredEvents: readonly ("input.needed" | "turn.completed")[]): void {
    recordHarnessTrust(
      fixture.db,
      {
        slug: registered,
        manifestPath: join(root, "harnesses/my-harness/harness.json"),
        manifestSha256: "a1",
        decision: "trusted",
        declaredEvents,
      },
      1000,
    );
  }

  it("writes the delivery down before it reads the ledger back", () => {
    trust([]);

    // Nothing was claimed, so nothing could have been verified in advance: the
    // first arrival is the evidence, and it counts on the way in rather than
    // after a second one nobody may ever send.
    expect(recordHarnessDelivery(fixture.db, registered, "input.needed", 1100)).toBe("verified");
    expect(getRegisteredHarness(fixture.db, registered)?.verifiedEvents).toEqual(["input.needed"]);
  });

  it("leaves a claim that has never arrived unconfirmed", () => {
    trust(["input.needed", "turn.completed"]);

    recordHarnessDelivery(fixture.db, registered, "input.needed", 1100);

    const record = getRegisteredHarness(fixture.db, registered);
    expect(record?.verifiedEvents).toEqual(["input.needed"]);
    expect(record?.declaredEvents).toContain("turn.completed");
  });

  it("calls an event from a harness it has no record of absent", () => {
    expect(recordHarnessDelivery(fixture.db, "ghost" as HarnessId, "input.needed", 1100)).toBe(
      "absent",
    );
  });

  it("needs no ledger for a harness Volli ships an adapter for", () => {
    expect(recordHarnessDelivery(fixture.db, "claude-code", "input.needed", 1100)).toBe("verified");
    expect(getRegisteredHarness(fixture.db, "claude-code")).toBeUndefined();
  });
});
