import type Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type { VolliIpcChannel } from "../ipc/contract";

// Hoisted above module evaluation so the electron mock factory can capture into
// it — the shape cli-ipc.test.ts and data-ipc.test.ts use.
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

import { writeUpdateChannel } from "./auto-update";
import { openTestDb, type TestDb } from "./db/test-helpers";
import { writeSecret } from "./db/secrets-repo";
import {
  collectSupportInfo,
  registerSupportIpcHandlers,
  type SupportInfoDeps,
} from "./support-info";

/** Every field the support report is allowed to learn from main — nothing else may appear. */
const ALLOWLIST = ["appVersion", "arch", "channel", "platform", "schemaVersion"];

let fixture: TestDb | null = null;

afterEach(() => {
  fixture?.cleanup();
  fixture = null;
  handlers.clear();
});

function testDb(): Database.Database {
  fixture = openTestDb();
  return fixture.db;
}

function deps(overrides: Partial<SupportInfoDeps> = {}): SupportInfoDeps {
  return {
    appVersion: () => "0.2.0-canary.4",
    database: () => null,
    platform: "darwin",
    arch: "arm64",
    ...overrides,
  };
}

function invoke(channel: VolliIpcChannel): Promise<unknown> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`no handler for ${channel}`);
  // `ipcMain.handle` hands the event first; the registry appends the sender.
  return Promise.resolve(handler(...([{ sender: {} }] as never[])));
}

describe("collectSupportInfo", () => {
  it("answers exactly the allowlisted fields", () => {
    const db = testDb();

    const info = collectSupportInfo(deps({ database: () => db }));

    expect(Object.keys(info).toSorted()).toEqual(ALLOWLIST);
  });

  it("reports the app version as the build version, and this process's OS and architecture", () => {
    const info = collectSupportInfo(
      deps({ database: () => testDb(), platform: "linux", arch: "x64" }),
    );

    expect(info).toMatchObject({ appVersion: "0.2.0-canary.4", platform: "linux", arch: "x64" });
  });

  it("reads the release channel and schema version the database actually holds", () => {
    const db = testDb();
    writeUpdateChannel(db, "canary", 1_700_000_000_000);

    const info = collectSupportInfo(deps({ database: () => db }));

    expect(info.channel).toBe("canary");
    expect(info.schemaVersion).toBe(db.pragma("user_version", { simple: true }));
    expect(info.schemaVersion).toBeGreaterThan(0);
  });

  it("defaults a profile that never chose a line to stable", () => {
    expect(collectSupportInfo(deps({ database: () => testDb() })).channel).toBe("stable");
  });

  // A launch whose database never opened is exactly when About is most worth
  // reading, but the required metadata is not complete enough to copy.
  it("refuses to present missing database facts as a complete support result", () => {
    expect(() => collectSupportInfo(deps())).toThrow("Profile database is unavailable");
  });

  // `pragma` answers whatever SQLite says; a build that cannot produce a
  // number must fail the input rather than report a plausible zero.
  it("refuses an unreadable user_version", () => {
    const db = {
      pragma: () => undefined,
      prepare: () => ({ get: () => undefined }),
    } as unknown as Database.Database;

    expect(() => collectSupportInfo(deps({ database: () => db }))).toThrow(
      "Database schema version is unavailable",
    );
  });

  /**
   * The allowlist as a behaviour, not a shape: the module reads `user_version`
   * and the update-channel key, and nothing else. A future field added by
   * reaching into another table would fail here before it could reach a
   * clipboard.
   */
  it("touches only the schema version and the release-channel key", () => {
    const db = testDb();
    const statements: string[] = [];
    const pragmas: string[] = [];
    const watched = new Proxy(db, {
      get(target, property, receiver) {
        if (property === "prepare") {
          return (sql: string) => {
            statements.push(sql);
            return target.prepare(sql);
          };
        }
        if (property === "pragma") {
          return (source: string, options?: unknown) => {
            pragmas.push(source);
            return (target.pragma as (s: string, o?: unknown) => unknown)(source, options);
          };
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
    });

    collectSupportInfo(deps({ database: () => watched }));

    expect(pragmas).toEqual(["user_version"]);
    expect(statements).toEqual(["SELECT value FROM app_state WHERE key = ?"]);
    for (const sql of statements) {
      expect(sql.toLowerCase()).not.toContain("secret");
    }
  });

  it("carries no credential, even when the profile holds one", () => {
    const db = testDb();
    writeSecret(db, "web-access.exa.api-key", "sentinel-credential-do-not-export", Date.now());

    const info = collectSupportInfo(deps({ database: () => db }));

    expect(JSON.stringify(info)).not.toContain("sentinel-credential-do-not-export");
  });
});

describe("registerSupportIpcHandlers", () => {
  it("answers the read with the collected support facts", async () => {
    const db = testDb();
    registerSupportIpcHandlers(deps({ database: () => db }));

    await expect(invoke("volli:support-info")).resolves.toEqual({
      ok: true,
      info: collectSupportInfo(deps({ database: () => db })),
    });
  });

  it("reports missing required database metadata as data rather than a rejection", async () => {
    registerSupportIpcHandlers(deps());

    await expect(invoke("volli:support-info")).resolves.toEqual({
      ok: false,
      error: "Profile database is unavailable",
    });
  });

  it("reports a thrown read as data rather than a rejection", async () => {
    registerSupportIpcHandlers(
      deps({
        database: () => {
          throw new Error("database is closed");
        },
      }),
    );

    await expect(invoke("volli:support-info")).resolves.toEqual({
      ok: false,
      error: "database is closed",
    });
  });
});
