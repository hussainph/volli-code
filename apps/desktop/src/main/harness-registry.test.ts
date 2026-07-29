import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { HarnessId } from "@volli/shared";

import {
  decideRegisteredHarnesses,
  MAX_MANIFEST_BYTES,
  MAX_SCANNED_HARNESS_DIRS,
  recordHarnessDelivery,
  scanHarnessManifests,
  trustedHarnessAdapters,
} from "./harness-registry";
import type { HarnessManifestScan, ScannedHarnessManifest } from "./harness-registry";
import { ensureHarnessRuntime } from "./harness-runtime";
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
    events: [{ event: "input.needed", native: "Notification", delivery: "async" }],
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

const harnessesDir = (): string => join(root, "harnesses");

/** The manifests one scan read. Its `gap` is asserted directly where the gap is the subject. */
async function scanManifests(): Promise<ScannedHarnessManifest[]> {
  return (await scanHarnessManifests(harnessesDir())).manifests;
}

describe("scanHarnessManifests", () => {
  it("reads a manifest into an adapter, alongside the hash of the bytes it read", async () => {
    const path = await write("my-harness", manifest());

    const [scanned, ...rest] = await scanManifests();

    expect(rest).toEqual([]);
    expect(scanned?.slug).toBe("my-harness");
    expect(scanned?.manifestPath).toBe(path);
    expect(scanned?.manifestSha256).toMatch(/^[\da-f]{64}$/);
    expect(scanned?.adapter?.command).toBe("my-harness");
    expect(scanned?.errors).toEqual([]);
  });

  it("finds nothing when nobody has registered a harness", async () => {
    // Measured, and measured empty: the whole point of the gap is that this is
    // not the same value a failure produces.
    expect(await scanHarnessManifests(harnessesDir())).toEqual({ manifests: [], gap: null });
  });

  it("ignores a directory that holds no manifest", async () => {
    await mkdir(join(root, "harnesses", "empty"), { recursive: true });
    expect(await scanHarnessManifests(harnessesDir())).toEqual({ manifests: [], gap: null });
  });

  it("reports unreadable JSON against the document rather than throwing at boot", async () => {
    await write("my-harness", "{ not json");

    const [scanned] = await scanManifests();

    expect(scanned?.adapter).toBeNull();
    expect(scanned?.errors).toEqual([{ path: "", message: "must be readable JSON" }]);
  });

  it("keeps a hash for an invalid manifest, so fixing it counts as a change", async () => {
    await write("my-harness", manifest({ command: "/usr/bin/my-harness" }));

    const [scanned] = await scanManifests();

    expect(scanned?.adapter).toBeNull();
    expect(scanned?.errors.map((error) => error.path)).toEqual(["command"]);
    expect(scanned?.manifestSha256).toMatch(/^[\da-f]{64}$/);
  });

  it("refuses a manifest whose slug is not the directory it was found in", async () => {
    await write("other-name", manifest());

    const [scanned] = await scanManifests();

    expect(scanned?.adapter).toBeNull();
    expect(scanned?.errors).toEqual([
      { path: "slug", message: "must match the directory it lives in" },
    ]);
  });

  it("reads every registered harness, in directory order", async () => {
    await write("b-harness", manifest({ slug: "b-harness", command: "b-harness" }));
    await write("a-harness", manifest({ slug: "a-harness", command: "a-harness" }));

    const scanned = await scanManifests();

    expect(scanned.map((entry) => entry.slug)).toEqual(["a-harness", "b-harness"]);
  });
});

describe("scanHarnessManifests — a scan that could not see everything", () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it("does not report a directory it could not list as a directory with nothing in it", async () => {
    // A file where the directory should be: ENOTDIR, the same shape as the
    // EACCES/EMFILE/EIO this is really about, without depending on which user
    // the suite runs as.
    await writeFile(harnessesDir(), "", "utf8");

    expect(await scanHarnessManifests(harnessesDir())).toEqual({
      manifests: [],
      gap: "directory-unreadable",
    });
    expect(warn).toHaveBeenCalled();
  });

  it("does not report a manifest it could not read as a harness that is gone", async () => {
    await write("readable", manifest({ slug: "readable", command: "readable" }));
    // A manifest that points at itself: ELOOP, which is the same class of answer
    // as the EACCES/EMFILE this is really about and needs no special user.
    const looping = join(harnessesDir(), "blocked", "harness.json");
    await mkdir(join(harnessesDir(), "blocked"), { recursive: true });
    await symlink(looping, looping);

    const scan = await scanHarnessManifests(harnessesDir());

    // What it could read, it still reports — and it still says it read less than
    // there was, which is what disqualifies the whole scan as a census.
    expect(scan.manifests.map((entry) => entry.slug)).toEqual(["readable"]);
    expect(scan.gap).toBe("manifest-unreadable");
  });

  it("stops at the ceiling and names what it skipped rather than capping in silence", async () => {
    const slugs = Array.from({ length: MAX_SCANNED_HARNESS_DIRS + 2 }, (_, index) =>
      // Zero-padded so directory order is the order the names imply.
      "h".concat(String(index).padStart(3, "0")),
    );
    for (const slug of slugs) await write(slug, manifest({ slug, command: slug }));

    const scan = await scanHarnessManifests(harnessesDir());

    expect(scan.manifests).toHaveLength(MAX_SCANNED_HARNESS_DIRS);
    expect(scan.gap).toBe("too-many-manifests");
    const logged = warn.mock.calls.flat().join(" ");
    for (const skipped of slugs.slice(MAX_SCANNED_HARNESS_DIRS)) {
      expect(logged).toContain(skipped);
    }
  });

  it("refuses a file too large to be a manifest, and says so — but that is a measurement", async () => {
    await write("huge", "x".repeat(MAX_MANIFEST_BYTES + 1));

    const scan = await scanHarnessManifests(harnessesDir());

    // Nothing here could not be measured: the file was seen and rejected, so a
    // caller reconciling wrappers is right to treat this harness as absent.
    expect(scan).toEqual({ manifests: [], gap: null });
    expect(warn.mock.calls.flat().join(" ")).toContain("huge");
  });
});

/**
 * The census `index.ts` derives, mirrored: `detected !== null && dbHandle.ok &&
 * scan.gap === null`. It is inlined here because that expression is exactly what
 * a failed scan must never be able to make "complete", and the wrapper sweep is
 * what happens when it does.
 */
function censusFor(scan: HarnessManifestScan): "complete" | "partial" {
  return scan.gap === null ? "complete" : "partial";
}

describe("a scan that failed cannot authorize a cleanup", () => {
  it("keeps the wrappers of every registered harness when the manifest directory would not read", async () => {
    const binDir = join(root, "bin");
    await mkdir(binDir, { recursive: true });
    // What last boot left behind for a registered harness the user trusted.
    await writeFile(join(binDir, "my-harness"), "#!/bin/sh\n# volli wrapper\n", { mode: 0o755 });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await writeFile(harnessesDir(), "", "utf8"); // the transient blip

    const scan = await scanHarnessManifests(harnessesDir());
    const runtime = await ensureHarnessRuntime({
      binDir,
      harnessRoot: join(root, "harness"),
      socketPath: join(root, "volli.sock"),
      shimPath: join(binDir, "volli"),
      // The scan yielded nothing, so there is nothing to trust and nothing to
      // write — the exact shape in which a wrapper sweep would find every
      // wrapper on disk unaccounted for.
      adapters: trustedHarnessAdapters(decideRegisteredHarnesses(fixture.db, scan.manifests)),
      adapterCensus: censusFor(scan),
      resolveCommand: () => Promise.resolve(null),
    });
    warn.mockRestore();

    expect(scan.gap).toBe("directory-unreadable");
    expect(censusFor(scan)).toBe("partial");
    expect(runtime.wrappers).toEqual([]);
    expect(await readFile(join(binDir, "my-harness"), "utf8")).toContain("# volli wrapper");
  });

  it("removes the same wrapper once the directory reads and the harness really is gone", async () => {
    const binDir = join(root, "bin");
    await mkdir(binDir, { recursive: true });
    await writeFile(join(binDir, "my-harness"), "#!/bin/sh\n# volli wrapper\n", { mode: 0o755 });
    await mkdir(harnessesDir(), { recursive: true }); // measured, and genuinely empty

    const scan = await scanHarnessManifests(harnessesDir());
    await ensureHarnessRuntime({
      binDir,
      harnessRoot: join(root, "harness"),
      socketPath: join(root, "volli.sock"),
      shimPath: join(binDir, "volli"),
      adapters: [],
      adapterCensus: censusFor(scan),
      resolveCommand: () => Promise.resolve(null),
    });

    expect(censusFor(scan)).toBe("complete");
    await expect(readFile(join(binDir, "my-harness"), "utf8")).rejects.toThrow();
  });
});

describe("decideRegisteredHarnesses", () => {
  it("holds a manifest nobody has confirmed, whatever it declares", async () => {
    await write("my-harness", manifest());
    const scanned = await scanManifests();

    const decided = decideRegisteredHarnesses(fixture.db, scanned);

    expect(decided[0]?.decision).toBe("reconfirm");
    expect(trustedHarnessAdapters(decided)).toEqual([]);
  });

  it("launches a manifest whose exact bytes were trusted", async () => {
    await write("my-harness", manifest());
    const scanned = await scanManifests();
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
    const before = await scanManifests();
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

    const decided = decideRegisteredHarnesses(fixture.db, await scanManifests());

    expect(decided[0]?.decision).toBe("reconfirm");
    expect(trustedHarnessAdapters(decided)).toEqual([]);
  });

  it("never launches a manifest that does not parse, however it was ruled on", async () => {
    await write("my-harness", manifest({ command: "volli" }));
    const scanned = await scanManifests();
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
    const scanned = await scanManifests();
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
