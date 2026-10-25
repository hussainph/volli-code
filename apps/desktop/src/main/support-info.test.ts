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
import { openTestDb, type TestDb } from "@volli/host-core/testing";
import { writeSecret } from "@volli/host-core/db";
import {
  collectSupportInfo,
  describeBootRecovery,
  describeCloudRunner,
  describeLastUpdateCheck,
  registerSupportIpcHandlers,
  type SupportInfoDeps,
} from "./support-info";

/** Every field the support report is allowed to learn from main — nothing else may appear. */
const ALLOWLIST = [
  "appVersion",
  "arch",
  "bootRecovery",
  "channel",
  "cloudRunner",
  "lastUpdateCheck",
  "migrationHistory",
  "platform",
  "schemaVersion",
];

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
    // Matches the canary `appVersion` above, as `runningBuildKind` would derive it.
    buildKind: "canary",
    platform: "darwin",
    arch: "arm64",
    lastUpdateCheck: () => null,
    bootRecovery: () => null,
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

  it("says whether the migrations the file ran are the ones this build ships (VC-633)", () => {
    const db = testDb();
    expect(collectSupportInfo(deps({ database: () => db })).migrationHistory).toBe("consistent");
    db.prepare("UPDATE migration_history SET fingerprint = ? WHERE version = 1").run(
      "f".repeat(64),
    );
    expect(collectSupportInfo(deps({ database: () => db })).migrationHistory).toMatch(
      /^diverged: this database ran a different migration than this build at 1\./,
    );
  });

  it("reports the last update check, a failure only as its redacted summary (VC-294)", () => {
    const raw = [
      "Cannot find latest-mac.yml (https://github.com/acme/volli/releases/latest-mac.yml): HttpError: 404 ",
      'Headers: { "x-github-request-id": "C0FF:EE", "set-cookie": "_gh_sess=abc" }',
    ].join("\n");
    const info = collectSupportInfo(
      deps({
        database: () => testDb(),
        lastUpdateCheck: () => ({
          at: Date.UTC(2026, 9, 18, 3),
          result: "error",
          version: null,
          error: raw,
        }),
      }),
    );

    expect(info.lastUpdateCheck).toBe(
      "2026-10-18T03:00:00.000Z, check failed: Cannot find latest-mac.yml: HttpError: 404",
    );
    for (const leak of ["https", "github.com", "C0FF", "_gh_sess", "Headers"]) {
      expect(JSON.stringify(info), leak).not.toContain(leak);
    }
  });

  it("reports what boot recovery did as counts, reasons and error class names (VC-926)", () => {
    const leak = new Error("/Users/ada/secret-project: Command abc already has a terminal receipt");
    leak.name = "SessionEngineConflictError";
    const info = collectSupportInfo(
      deps({
        database: () => testDb(),
        bootRecovery: () => ({
          finishedAt: Date.UTC(2026, 9, 25, 3),
          error: null,
          recovered: 1,
          closed: 2,
          failures: [
            { reason: "reconcile_failed", outcome: "recovered", error: { name: leak.name } },
            {
              reason: "binding_unrecoverable",
              outcome: "closed",
              error: { name: "NativeAttachmentError", code: "queue_admission_timeout" },
            },
            {
              reason: "binding_unrecoverable",
              outcome: "closed",
              error: { name: "NativeAttachmentError", code: "queue_admission_timeout" },
            },
          ],
        }),
      }),
    );

    expect(info.bootRecovery).toBe(
      "2026-10-25T03:00:00.000Z, 1 lost turn recovered, 2 attachments closed; failed: " +
        "reconcile_failed→recovered SessionEngineConflictError, " +
        "binding_unrecoverable→closed NativeAttachmentError:queue_admission_timeout ×2",
    );
    for (const text of ["/Users", "secret-project", "terminal receipt"]) {
      expect(JSON.stringify(info), text).not.toContain(text);
    }
  });

  it("words a boot recovery that has not finished, or found nothing, on one line", () => {
    expect(describeBootRecovery(null)).toBe("not finished");
    expect(
      describeBootRecovery({ finishedAt: 0, error: null, recovered: 0, closed: 0, failures: [] }),
    ).toBe("1970-01-01T00:00:00.000Z, 0 lost turns recovered, 0 attachments closed");
    expect(
      describeBootRecovery({ finishedAt: 0, error: null, recovered: 2, closed: 1, failures: [] }),
    ).toBe("1970-01-01T00:00:00.000Z, 2 lost turns recovered, 1 attachment closed");
    expect(
      describeBootRecovery({
        finishedAt: 0,
        error: { name: "Error", code: "SQLITE_BUSY" },
        recovered: 0,
        closed: 0,
        failures: [],
      }),
    ).toBe(
      "1970-01-01T00:00:00.000Z, 0 lost turns recovered, 0 attachments closed; sweep failed: Error:SQLITE_BUSY",
    );
    expect(
      describeBootRecovery({
        finishedAt: 0,
        error: { name: "TypeError" },
        recovered: 0,
        closed: 0,
        failures: [],
      }),
    ).toMatch(/; sweep failed: TypeError$/);
    const failures = Array.from({ length: 7 }, (_, index) => ({
      reason: "reconcile_failed" as const,
      outcome: "closed" as const,
      error: { name: `Error${index}` },
    }));
    expect(
      describeBootRecovery({ finishedAt: 0, error: null, recovered: 0, closed: 7, failures }),
    ).toMatch(/Error4, 2 more$/);
  });

  it("words every last-check result on one line", () => {
    const at = Date.UTC(2026, 9, 18, 3);
    const iso = "2026-10-18T03:00:00.000Z";
    expect(describeLastUpdateCheck(null)).toBe("none recorded");
    expect(describeLastUpdateCheck({ at, result: "up-to-date", version: null, error: null })).toBe(
      `${iso}, up to date`,
    );
    expect(
      describeLastUpdateCheck({ at, result: "available", version: "0.3.0", error: null }),
    ).toBe(`${iso}, found 0.3.0`);
    expect(describeLastUpdateCheck({ at, result: "available", version: null, error: null })).toBe(
      `${iso}, found an update`,
    );
    expect(describeLastUpdateCheck({ at, result: "error", version: null, error: null })).toBe(
      `${iso}, check failed: Unknown error`,
    );
    expect(
      describeLastUpdateCheck({ at, result: "download-error", version: "0.3.0", error: "ENOSPC" }),
    ).toBe(`${iso}, download of 0.3.0 failed: ENOSPC`);
    expect(
      describeLastUpdateCheck({ at, result: "download-error", version: null, error: null }),
    ).toBe(`${iso}, download failed: Unknown error`);
  });

  it("defaults a profile that never chose a line to the line its build follows (VC-851)", () => {
    const db = testDb();
    // A fresh canary install takes canaries — the report must not say Stable.
    expect(collectSupportInfo(deps({ database: () => db })).channel).toBe("canary");
    expect(
      collectSupportInfo(
        deps({ appVersion: () => "0.2.2", buildKind: "stable", database: () => db }),
      ).channel,
    ).toBe("stable");
  });

  it("reports an explicit Stable on a canary build as stable", () => {
    const db = testDb();
    writeUpdateChannel(db, "stable", 1_700_000_000_000);
    expect(collectSupportInfo(deps({ database: () => db })).channel).toBe("stable");
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

    expect(pragmas).toEqual(["user_version", "user_version"]);
    expect(statements).toEqual([
      "SELECT value FROM app_state WHERE key = ?",
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'migration_history'",
      "SELECT version, fingerprint, origin FROM migration_history ORDER BY version",
    ]);
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

describe("describeCloudRunner", () => {
  it("names the state, a problem and the waiting count, never the runner's id or name", () => {
    const base = {
      state: "online" as const,
      runnerId: "22222222-2222-4222-8222-222222222222",
      runnerName: "danas-mac",
      since: 1,
      waitingFacts: 0,
      problem: null,
      message: null,
    };
    expect(describeCloudRunner(null)).toBe("off");
    expect(describeCloudRunner({ ...base, state: "off" })).toBe("off");
    expect(describeCloudRunner(base)).toBe("online · 0 updates waiting");
    expect(describeCloudRunner({ ...base, state: "offline", waitingFacts: 1 })).toBe(
      "offline · 1 update waiting",
    );
    const removed = describeCloudRunner({
      ...base,
      state: "removed",
      problem: "credential_reuse",
      message: "danas-mac was used from two places.",
    });
    expect(removed).toBe("removed (credential_reuse) · 0 updates waiting");
    expect(removed).not.toContain("danas-mac");
  });
});
