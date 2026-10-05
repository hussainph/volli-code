import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { PiModelAccess } from "@volli/agent-runtime";
import type { SessionEngine } from "@volli/session-engine";
import { type SessionUsage } from "@volli/shared";
import { openTestDb, type TestDb } from "./db/test-helpers";
import { clientCapabilities } from "./ports";
import { createHostRuntimeServices } from "./runtime-services";
import { createDesktopDecisions } from "./decision/desktop";
import { McpSettingsService } from "./mcp/settings";
import { McpOAuthBroker } from "./mcp/oauth";
import { WebAccessSettings } from "./web/settings";

const { ownedModelAccess } = vi.hoisted(() => ({ ownedModelAccess: vi.fn() }));
vi.mock("@volli/agent-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@volli/agent-runtime")>()),
  piOwnedModelAccess: ownedModelAccess,
}));
const { brokerOptions } = vi.hoisted(() => ({
  brokerOptions: [] as { store: unknown; openExternal: (url: string) => Promise<void> }[],
}));
vi.mock("./mcp/oauth", async (importOriginal) => {
  const original = await importOriginal<typeof import("./mcp/oauth")>();
  class RecordingBroker extends original.McpOAuthBroker {
    constructor(options: ConstructorParameters<typeof original.McpOAuthBroker>[0]) {
      brokerOptions.push(options);
      super(options);
    }
  }
  return { ...original, McpOAuthBroker: RecordingBroker };
});
vi.mock("./decision/desktop", () => ({
  createDesktopDecisions: vi.fn(() => ({ decision: true })),
}));

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

function open(): TestDb {
  testDb = openTestDb();
  return testDb;
}

function engine(observe = vi.fn(async () => undefined)): SessionEngine {
  return { observe } as unknown as SessionEngine;
}

describe("live host runtime services", () => {
  it("builds model access, decisions, MCP and Web Access once, against the host database", () => {
    const { db, dbPath } = open();
    ownedModelAccess.mockReturnValue(modelAccess);
    const services = createHostRuntimeServices(db, engine(), ports, { dbPath });

    expect(ownedModelAccess).toHaveBeenCalledTimes(1);
    expect(services.modelAccess).toBe(modelAccess);
    expect(createDesktopDecisions).toHaveBeenCalledTimes(1);
    expect(createDesktopDecisions).toHaveBeenCalledWith(
      expect.objectContaining({
        db,
        models: modelAccess.models,
        catalogReady: modelAccess.catalogReady,
      }),
    );
    expect(services.decisions).toBe(vi.mocked(createDesktopDecisions).mock.results[0]!.value);
    expect(services.mcp).toBeInstanceOf(McpSettingsService);
    // MCP credentials live beside the database, wherever the host put it.
    expect(services.mcp.credentials).toHaveProperty(
      "path",
      dbPath.replace(/[^/]+$/, "mcp-credentials.json"),
    );
    expect(services.webAccess).toBeInstanceOf(WebAccessSettings);
    expect(Object.keys(services).toSorted()).toEqual([
      "decisions",
      "mcp",
      "modelAccess",
      "webAccess",
    ]);
  });

  it("uses the host's model access instead of constructing Pi's own", () => {
    const { db, dbPath } = open();
    const supplied = { models: {}, catalogReady: Promise.resolve() } as PiModelAccess;
    const services = createHostRuntimeServices(db, engine(), ports, {
      dbPath,
      modelAccess: supplied,
    });
    expect(ownedModelAccess).not.toHaveBeenCalled();
    expect(services.modelAccess).toBe(supplied);
    expect(createDesktopDecisions).toHaveBeenCalledWith(
      expect.objectContaining({ models: supplied.models, catalogReady: supplied.catalogReady }),
    );
  });

  it("routes MCP sign-in pages through the host's client capability", async () => {
    const { db, dbPath } = open();
    const openExternal = vi.fn(() => Promise.resolve());
    const services = createHostRuntimeServices(
      db,
      engine(),
      { client: { ...clientCapabilities(undefined), openExternal } },
      { dbPath, modelAccess },
    );
    const broker = brokerOptions.at(-1)!;
    expect(services.mcp.oauth).toBeInstanceOf(McpOAuthBroker);
    expect(broker.store).toBe(services.mcp.credentials);
    await broker.openExternal("https://auth.example/authorize");
    expect(openExternal).toHaveBeenCalledWith("https://auth.example/authorize");
  });

  it("bills decision usage through the host's one Session engine at the local venue by default", async () => {
    const { db, dbPath } = open();
    const observe = vi.fn(async () => undefined);
    createHostRuntimeServices(db, engine(observe), ports, { dbPath, modelAccess });
    const input = vi.mocked(createDesktopDecisions).mock.calls[0]![0];
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
    // Every decision is its own bill.
    await input.recordUsage("session", usage, "agent.classify");
    const ids = observe.mock.calls.map((call) => (call as unknown as [{ id: string }])[0].id);
    expect(new Set(ids).size).toBe(2);
  });

  it("records the host-supplied decision venue", async () => {
    const { db, dbPath } = open();
    const observe = vi.fn(async () => undefined);
    createHostRuntimeServices(db, engine(observe), ports, {
      dbPath,
      modelAccess,
      venue: { id: "cloud-host", kind: "remote" },
    });
    await vi
      .mocked(createDesktopDecisions)
      .mock.calls[0]![0].recordUsage("s", usage, "agent.classify");
    expect(observe).toHaveBeenCalledWith(
      expect.objectContaining({
        provenance: expect.objectContaining({ venue: { id: "cloud-host", kind: "remote" } }),
      }),
    );
  });
});
