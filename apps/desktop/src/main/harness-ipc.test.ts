import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { HARNESS_CHANNELS } from "@volli/shared";
import type {
  HarnessPendingResult,
  PendingHarnessManifest,
  Result,
  VolliIpcChannel,
} from "@volli/shared";

// Hoisted above module evaluation so the electron mock factory can capture into
// it — the shape data-ipc.test.ts and theme-ipc.test.ts use.
const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: never[]) => unknown>(),
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle(channel: string, handler: (...args: never[]) => unknown) {
      handlers.set(channel, handler);
    },
  },
}));

import { registerHarnessIpcHandlers } from "./harness-ipc";
import { decideRegisteredHarnesses, scanHarnessManifests } from "./harness-registry";
import { getRegisteredHarness } from "./db/harness-registry-repo";
import { openTestDb, type TestDb } from "./db/test-helpers";

let root: string;
let fixture: TestDb;

beforeEach(async () => {
  handlers.clear();
  root = await mkdtemp(join(tmpdir(), "volli-harness-ipc-"));
  fixture = openTestDb();
});

afterEach(async () => {
  fixture.cleanup();
  await rm(root, { recursive: true, force: true });
});

const harnessesDir = (): string => join(root, "harnesses");

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

/** Writes `<harnesses>/<dir>/harness.json`. */
async function write(dir: string, body: unknown): Promise<void> {
  const directory = join(harnessesDir(), dir);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "harness.json"),
    typeof body === "string" ? body : JSON.stringify(body),
    "utf8",
  );
}

/** The hash on disk right now for `slug` — the value a real prompt would have carried. */
async function hashOf(slug: string): Promise<string> {
  const scanned = await scanHarnessManifests(harnessesDir());
  const found = scanned.find((entry) => entry.slug === slug);
  if (found === undefined) throw new Error(`no manifest for ${slug}`);
  return found.manifestSha256;
}

/**
 * Registers the surface against the temp db and temp manifest dir. Every
 * command resolves to a stand-in binary unless `resolveBinary` says otherwise,
 * so a test only mentions PATH when PATH is what it is about.
 */
function setup(
  options: { resolveBinary?: (command: string) => Promise<string | null> } = {},
): void {
  registerHarnessIpcHandlers(
    { ok: true, db: fixture.db },
    {
      harnessesDir: harnessesDir(),
      resolveBinary:
        options.resolveBinary ?? ((command) => Promise.resolve(`/opt/homebrew/bin/${command}`)),
      launchArgv: () => ["--volli-hook", "/tmp/volli.sock"],
      now: () => 1000,
    },
  );
}

/** Invokes a captured handler the way `ipcMain.handle` dispatch would. */
function invoke<T>(channel: VolliIpcChannel, ...args: unknown[]): T {
  const handler = handlers.get(channel);
  if (handler === undefined) throw new Error(`no handler registered for ${channel}`);
  return (handler as (...callArgs: unknown[]) => T)({}, ...args);
}

const pending = (): Promise<HarnessPendingResult> =>
  invoke<Promise<HarnessPendingResult>>("volli:harness-pending");

const setTrust = (input: unknown): Promise<Result> =>
  invoke<Promise<Result>>("volli:harness-trust-set", input);

/** The one pending manifest, or a failure that names why there wasn't exactly one. */
async function onlyPending(): Promise<PendingHarnessManifest> {
  const result = await pending();
  if (!result.ok) throw new Error(`pending failed: ${result.error}`);
  const [first, ...rest] = result.pending;
  if (first === undefined || rest.length > 0) {
    throw new Error(`expected one pending manifest, got ${result.pending.length}`);
  }
  return first;
}

describe("volli:harness-pending", () => {
  it("states what a discovered manifest will run, before anything has run it", async () => {
    await write("my-harness", manifest());
    setup();

    const waiting = await onlyPending();

    expect(waiting.slug).toBe("my-harness");
    expect(waiting.label).toBe("My Harness");
    expect(waiting.binaryPath).toBe("/opt/homebrew/bin/my-harness");
    expect(waiting.argv).toEqual([
      "/opt/homebrew/bin/my-harness",
      "--volli-hook",
      "/tmp/volli.sock",
    ]);
    expect(waiting.claimedEvents).toEqual(["input.needed"]);
    expect(waiting.manifestPath).toBe(join(harnessesDir(), "my-harness", "harness.json"));
    expect(waiting.manifestSha256).toMatch(/^[\da-f]{64}$/);
  });

  it("asks nothing when nobody has registered a harness", async () => {
    setup();

    expect(await pending()).toEqual({ ok: true, pending: [] });
  });
});

describe("volli:harness-pending — what it does not ask about", () => {
  it("stops asking once a verdict has been recorded about those bytes", async () => {
    await write("my-harness", manifest());
    setup();
    const waiting = await onlyPending();

    expect(
      await setTrust({
        slug: "my-harness",
        manifestSha256: waiting.manifestSha256,
        decision: "trusted",
      }),
    ).toEqual({ ok: true });
    expect(await pending()).toEqual({ ok: true, pending: [] });
  });

  it("asks again the moment those bytes change", async () => {
    await write("my-harness", manifest());
    setup();
    await setTrust({
      slug: "my-harness",
      manifestSha256: await hashOf("my-harness"),
      decision: "trusted",
    });

    await write("my-harness", manifest({ label: "My Harness (edited)" }));

    expect((await onlyPending()).label).toBe("My Harness (edited)");
  });

  it("holds its peace about a manifest that does not parse — there is no command line to confirm", async () => {
    await write("my-harness", manifest({ command: "/usr/bin/my-harness" }));
    setup();

    expect(await pending()).toEqual({ ok: true, pending: [] });
  });

  it("waits for the binary to exist rather than naming one that does not", async () => {
    await write("my-harness", manifest());
    setup({ resolveBinary: () => Promise.resolve(null) });

    expect(await pending()).toEqual({ ok: true, pending: [] });
  });
});

describe("volli:harness-trust-set", () => {
  it("lets a confirmed manifest launch, and files the events it claimed", async () => {
    await write("my-harness", manifest());
    setup();
    const waiting = await onlyPending();

    await setTrust({
      slug: "my-harness",
      manifestSha256: waiting.manifestSha256,
      decision: "trusted",
    });

    const decided = decideRegisteredHarnesses(
      fixture.db,
      await scanHarnessManifests(harnessesDir()),
    );
    expect(decided[0]?.decision).toBe("trusted");
    const record = getRegisteredHarness(fixture.db, "my-harness");
    expect(record?.declaredEvents).toEqual(["input.needed"]);
    // Claims gate nothing: the ledger starts empty however much was declared.
    expect(record?.verifiedEvents).toEqual([]);
  });

  it("keeps a refused manifest inert, and stops asking about it", async () => {
    await write("my-harness", manifest());
    setup();
    const waiting = await onlyPending();

    await setTrust({
      slug: "my-harness",
      manifestSha256: waiting.manifestSha256,
      decision: "blocked",
    });

    const decided = decideRegisteredHarnesses(
      fixture.db,
      await scanHarnessManifests(harnessesDir()),
    );
    expect(decided[0]?.decision).toBe("blocked");
    expect(await pending()).toEqual({ ok: true, pending: [] });
  });

  it("refuses a verdict about bytes that are no longer there, and re-asks instead", async () => {
    await write("my-harness", manifest());
    setup();
    const waiting = await onlyPending();

    // Edited between the dialog rendering and the button being pressed.
    await write("my-harness", manifest({ command: "other-harness" }));

    expect(
      await setTrust({
        slug: "my-harness",
        manifestSha256: waiting.manifestSha256,
        decision: "trusted",
      }),
    ).toEqual({
      ok: false,
      error: "my-harness changed on disk, so it needs confirming again.",
    });
    expect(getRegisteredHarness(fixture.db, "my-harness")).toBeUndefined();
    expect((await onlyPending()).argv).toContain("/opt/homebrew/bin/other-harness");
  });

  it("refuses a verdict about a manifest that is no longer on disk", async () => {
    setup();

    expect(await setTrust({ slug: "ghost", manifestSha256: "a1", decision: "trusted" })).toEqual({
      ok: false,
      error: "No harness manifest for ghost.",
    });
  });

  it("refuses to record a verdict about a manifest that does not parse", async () => {
    await write("my-harness", manifest({ command: "volli" }));
    setup();

    expect(
      await setTrust({
        slug: "my-harness",
        manifestSha256: await hashOf("my-harness"),
        decision: "trusted",
      }),
    ).toEqual({ ok: false, error: "my-harness isn't a valid manifest." });
    expect(getRegisteredHarness(fixture.db, "my-harness")).toBeUndefined();
  });

  it("refuses a payload that names no version of anything", async () => {
    setup();

    expect(await setTrust({ slug: "my-harness", decision: "trusted" })).toEqual({
      ok: false,
      error: "Invalid harness verdict",
    });
  });
});

describe("a db that would not open", () => {
  it("answers every channel with the open failure rather than hanging or lying", async () => {
    registerHarnessIpcHandlers(
      { ok: false, error: "database is locked" },
      {
        harnessesDir: harnessesDir(),
        resolveBinary: () => Promise.resolve("/opt/homebrew/bin/my-harness"),
        launchArgv: () => [],
        now: () => 1000,
      },
    );

    for (const channel of HARNESS_CHANNELS) {
      expect(invoke(channel, {})).toEqual({ ok: false, error: "database is locked" });
    }
  });
});
