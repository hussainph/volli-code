import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { PiModelAccess } from "@volli/agent-runtime";
import type { SessionEngine } from "@volli/session-engine";
import { type SessionUsage } from "@volli/shared";
import { openTestDb, type TestDb } from "./db/test-helpers";
import { clientCapabilities } from "./ports";
import { createHostRuntimeServices } from "./runtime-services";
import { createDesktopDecisions } from "./decision/desktop";

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
