import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { PiModelAccess } from "@volli/agent-runtime";
import type { SessionEngine } from "@volli/session-engine";
import { type SessionUsage } from "@volli/shared";
import { openTestDb, type TestDb } from "./db/test-helpers";
import { clientCapabilities } from "./ports";
import { createHostRuntimeServices } from "./runtime-services";
import { createDesktopDecisions } from "./decision/desktop";
import { existsSync } from "node:fs";
import { CredentialLock } from "./secrets/credential-lock";
import { fileCredentialKeyring } from "./secrets/file-key";

const { ownedModelAccess } = vi.hoisted(() => ({ ownedModelAccess: vi.fn() }));
vi.mock("@volli/agent-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@volli/agent-runtime")>()),
  piOwnedModelAccess: ownedModelAccess,
}));
vi.mock("./decision/desktop", () => ({ createDesktopDecisions: vi.fn(() => ({})) }));

let testDb: TestDb | undefined;
afterEach(() => {
  testDb?.cleanup();
  testDb = undefined;
  vi.clearAllMocks();
});

const ports = { client: clientCapabilities(undefined) };
const modelAccess = {
  models: {},
  catalogReady: Promise.resolve(),
} as PiModelAccess;

function options() {
  if (testDb === undefined) throw new Error("test database not opened");
  return { dbPath: testDb.dbPath };
}

describe("staged host runtime services", () => {
  it("does no eager model access and leaves database-backed services degraded", () => {
    const services = createHostRuntimeServices(null, null, ports, { dbPath: "/profile/volli.db" });
    expect(ownedModelAccess).not.toHaveBeenCalled();
    expect(services.createModelAccess()).toBeNull();
    expect(services.createDecisions(modelAccess)).toBeNull();
    expect(services.createWebAccess()).toBeNull();
    const mcp = services.createMcp();
    expect(mcp.settings).toBeNull();
    expect(mcp.credentials.path).toBe("/profile/mcp-credentials.json");
    expect(ownedModelAccess).not.toHaveBeenCalled();
  });

  it("builds MCP and Web Access against the host database, beside an overridden database path", () => {
    testDb = openTestDb();
    const services = createHostRuntimeServices(testDb.db, null, ports, options());
    expect(ownedModelAccess).not.toHaveBeenCalled();
    ownedModelAccess.mockReturnValue(modelAccess);
    expect(services.createModelAccess()).toBe(modelAccess);
    expect(ownedModelAccess).toHaveBeenCalledTimes(1);
    expect(services.createDecisions(null)).toBeNull();
    const mcp = services.createMcp();
    expect(mcp.settings).not.toBeNull();
    expect(mcp.credentials.path).toBe(testDb.dbPath.replace(/[^/]+$/, "mcp-credentials.json"));
    expect(services.createWebAccess()).not.toBeNull();
  });

  it("seals Web Access keys beside the database with the host's keyring (VC-643)", async () => {
    testDb = openTestDb();
    const services = createHostRuntimeServices(testDb.db, null, ports, options());
    const results: unknown[] = [];
    const dir = testDb.dbPath.replace(/[^/]+$/, "");
    const web = services.createWebAccess({
      keyring: fileCredentialKeyring({ path: `${dir}session-secrets.key` }),
      mayUnlockUnattended: () => false,
      onResult: (result) => results.push(result),
    })!;
    expect(web.saveKey("exa", "exa-runtime-services-key").sealing).toBe("sealed");
    expect(existsSync(`${dir}host-credentials.enc`)).toBe(true);
    expect(await web.reconcileSealing()).toMatchObject({ sealing: "sealed", written: false });
    expect(results).toHaveLength(2);
    // No keyring: legacy mode, honestly pending.
    const bare = services.createWebAccess({ keyring: null })!;
    expect(await bare.reconcileSealing()).toEqual({ sealing: "pending", reason: "no-keyring" });
    new CredentialLock(`${dir}host-credentials.lock`).close();
  });

  it("bills decision usage through the host's one Session engine", async () => {
    testDb = openTestDb();
    const observe = vi.fn(async () => undefined);
    const services = createHostRuntimeServices(
      testDb.db,
      { observe } as unknown as SessionEngine,
      ports,
      options(),
    );
    services.createDecisions(modelAccess);
    const input = vi.mocked(createDesktopDecisions).mock.calls[0]![0];
    const usage: SessionUsage = {
      cause: "decision",
      providerId: "fixture",
      modelId: "fixture",
      inputTokens: 1,
      outputTokens: 2,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      costUsd: null,
      costBasis: "unavailable",
    };
    await input.recordUsage("session", usage, "agent.classify");
    expect(observe).toHaveBeenCalledWith({
      id: expect.stringMatching(/^usage:decision:/),
      kind: "usage.recorded",
      sessionId: "session",
      occurredAt: expect.any(Number),
      provenance: {
        source: { kind: "system", id: "decision-service", detail: { purpose: "agent.classify" } },
        venue: { id: "local", kind: "local" },
      },
      attachmentId: null,
      turnId: null,
      usage,
    });
  });

  it("records the host-supplied decision venue", async () => {
    testDb = openTestDb();
    const observe = vi.fn(async () => undefined);
    const services = createHostRuntimeServices(
      testDb.db,
      { observe } as unknown as SessionEngine,
      ports,
      options(),
    );
    services.createDecisions(modelAccess, { id: "cloud-host", kind: "remote" });
    await vi
      .mocked(createDesktopDecisions)
      .mock.calls[0]![0].recordUsage("s", {} as SessionUsage, "agent.classify");
    expect(observe).toHaveBeenCalledWith(
      expect.objectContaining({
        provenance: expect.objectContaining({ venue: { id: "cloud-host", kind: "remote" } }),
      }),
    );
  });

  it("keeps the decision metering no-op when no engine is available", async () => {
    testDb = openTestDb();
    const services = createHostRuntimeServices(testDb.db, null, ports, options());
    services.createDecisions(modelAccess);
    const input = vi.mocked(createDesktopDecisions).mock.calls[0]![0];
    await expect(
      input.recordUsage("session", {} as SessionUsage, "agent.classify"),
    ).resolves.toBeUndefined();
  });
});
