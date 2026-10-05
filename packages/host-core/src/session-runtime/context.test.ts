import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { SessionEngine } from "@volli/session-engine";
import { openTestDb, testProject, testTicket, type TestDb } from "../db/test-helpers";
import { insertProject } from "../db/projects-repo";
import { insertTicket } from "../db/tickets-repo";
import { desktopMcpDispatch } from "../mcp/dispatch-policy";
import { createRuntimeContextResolver } from "./context";
import type { SessionToolSurfacePorts } from "./sessions";

let db: TestDb;
afterEach(() => db?.cleanup());
function fixture() {
  db = openTestDb();
  insertProject(db.db, testProject({ id: "p", path: "/repo", ticketPrefix: "VC" }));
  insertTicket(db.db, testTicket("p", { id: "t", ticketNumber: 1 }));
  const getSession = vi.fn().mockResolvedValue({
    session: { id: "s", projectId: "p", ticketId: "t", role: "ticket", parentSessionId: null },
    modelSelection: { providerId: "scripted", modelId: "test", reasoningLevel: "off" },
  });
  const listEvents = vi.fn().mockResolvedValue([]);
  const getOrRecordSessionInput = vi.fn(async ({ input }) => input);
  const waitForBirth = vi.fn(async () => {});
  const resolve = vi.fn(() => ["read", "codemode"]);
  const context = createRuntimeContextResolver({
    db: db.db,
    sessionEngine: { getSession, listEvents, getOrRecordSessionInput } as unknown as SessionEngine,
    venue: { id: "test-host", kind: "remote" },
    mcpDispatch: desktopMcpDispatch({ env: {}, packaged: true, log: vi.fn() }),
    waitForBirth,
    toolSurface: () => ({ resolve }) as unknown as SessionToolSurfacePorts,
  });
  return { context, getSession, listEvents, getOrRecordSessionInput, waitForBirth, resolve };
}

describe("shared attach context", () => {
  it("waits for birth before reading, backfills without grants or Code Mode, and uses host venue", async () => {
    const f = fixture();
    const birth = Promise.withResolvers<void>();
    f.waitForBirth.mockReturnValue(birth.promise);
    const attaching = f.context("s");
    expect(f.getSession).not.toHaveBeenCalled();
    birth.resolve();
    expect(await attaching).toMatchObject({ role: "ticket", ticketId: "t", toolSurface: ["read"] });
    expect(f.resolve).toHaveBeenCalledWith("ticket", []);
    expect(
      f.getOrRecordSessionInput.mock.calls.every(
        ([input]) => input.provenance.venue.id === "test-host",
      ),
    ).toBe(true);
  });

  it("reuses frozen tools, resources and brief; never reselects today's tool surface", async () => {
    const f = fixture();
    f.listEvents.mockResolvedValue([
      {
        payload: {
          kind: "session.input.recorded",
          input: { kind: "tool-surface", tools: ["read"], mcpManagementNames: "server" },
        },
      },
      {
        payload: {
          kind: "session.input.recorded",
          input: { kind: "prompt-resources", resources: [{ name: "skill", text: "old" }] },
        },
      },
    ]);
    f.getOrRecordSessionInput.mockResolvedValue({ kind: "runtime-brief", text: "frozen brief" });
    expect(await f.context("s")).toMatchObject({
      brief: "frozen brief",
      promptResources: [{ name: "skill", text: "old" }],
    });
    expect(f.resolve).not.toHaveBeenCalled();
  });

  it.each(["project", "subagent"])("briefs the Session's own %s role", async (role) => {
    const f = fixture();
    f.getSession.mockResolvedValue({
      session: { projectId: "p", ticketId: null, role, parentSessionId: "parent" },
      modelSelection: { providerId: "p", modelId: "m" },
    });
    expect(await f.context("s")).toMatchObject({ role, ticketId: null });
  });

  it("refuses an absent Session and corrupt durable input", async () => {
    const f = fixture();
    f.getSession.mockResolvedValueOnce(null);
    expect(await f.context("s")).toBeNull();
    f.getOrRecordSessionInput.mockResolvedValue({ kind: "prompt-resources", resources: [] });
    await expect(f.context("s")).rejects.toThrow("Recorded Agent Tool Surface");
    f.listEvents.mockResolvedValue([
      {
        payload: {
          kind: "session.input.recorded",
          input: { kind: "tool-surface", tools: ["read"] },
        },
      },
    ]);
    await expect(f.context("s")).rejects.toThrow("Recorded runtime brief");
  });
});
