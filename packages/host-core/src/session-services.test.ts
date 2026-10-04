import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { insertProject } from "./db/projects-repo";
import { readSessionUnread, writeSessionUnread } from "./db/session-read-repo";
import { openTestDb, testProject, type TestDb } from "./db/test-helpers";
import {
  createHostSessionServices,
  type HostSessionPorts,
  type HostSessionServices,
} from "./session-services";

let ctx: TestDb;
let services: HostSessionServices;
afterEach(() => {
  services?.sessionActivityWatch?.stop();
  ctx?.cleanup();
});

function ports() {
  return {
    log: { error: vi.fn(), warn: vi.fn() },
    publishSessionActivity: vi.fn<HostSessionPorts["publishSessionActivity"]>(),
    publishDataChanged: vi.fn<HostSessionPorts["publishDataChanged"]>(),
    deliverNotification: vi.fn<HostSessionPorts["deliverNotification"]>(),
    focusedSessionIds: vi.fn(() => new Set<string>()),
    listOpenNativeBindings: vi.fn(() => [{ attachmentId: "live-binding" }]),
    observeScheduledResume: vi.fn<HostSessionPorts["observeScheduledResume"]>(),
  } satisfies HostSessionPorts;
}

async function seeded() {
  ctx = openTestDb();
  const project = testProject({ id: "project" });
  insertProject(ctx.db, project);
  const sinks = ports();
  services = createHostSessionServices(ctx.db, sinks);
  const engine = services.sessionEngine!;
  const order: string[] = [];
  services.sessionWakeBus!.subscribe(() => order.push("wake"));
  sinks.observeScheduledResume.mockImplementation(() => {
    order.push("observe");
  });
  sinks.publishSessionActivity.mockImplementation(() => {
    order.push("publish");
  });
  const created = await engine.createSession({
    commandId: "create-1",
    projectId: project.id,
    ticketId: null,
    role: "project",
    parentSessionId: null,
    title: "Plan the move",
    provenance: {
      source: { kind: "system", id: "test", detail: null },
      venue: { id: "local", kind: "local" },
    },
  });
  return { engine, sinks, order, sessionId: created.session.id };
}

describe("host Session composition", () => {
  it("returns no Session services for a degraded database without asking process ports", () => {
    const sinks = ports();
    services = createHostSessionServices(null, sinks);
    expect(Object.values(services)).toEqual([null, null, null, null, null, null]);
    expect(sinks.focusedSessionIds).not.toHaveBeenCalled();
    expect(sinks.deliverNotification).not.toHaveBeenCalled();
  });

  it("announces committed facts before folding and publishing, with one transaction writer", async () => {
    const { engine, sinks, order, sessionId } = await seeded();
    expect(order.length).toBeGreaterThan(0);
    expect(order.every((entry) => entry === "wake")).toBe(true);
    await services.sessionActivityWatch!.flush();
    expect(order.slice(-2)).toEqual(["observe", "publish"]);
    expect(sinks.observeScheduledResume).toHaveBeenCalledWith(
      expect.objectContaining({ session: expect.objectContaining({ id: sessionId }) }),
    );
    expect(sinks.publishSessionActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project",
        row: expect.objectContaining({
          kind: "chat",
          record: expect.objectContaining({ sessionId }),
        }),
      }),
    );
    const transaction = vi.spyOn(services.sessionLedger!, "transaction");
    await services.hostNoticeOutbox!.pending();
    await engine.getSession({ sessionId });
    expect(transaction).toHaveBeenCalledTimes(2);
  });

  it("marks unattended turn edges unread and republishes only when focus clears unread work", async () => {
    const { engine, sinks, sessionId } = await seeded();
    await services.sessionActivityWatch!.flush();
    const projection = (await engine.getSession({ sessionId }))!;
    services.sessionReadWatch!.observe({
      ...projection,
      lastTurnOutcome: "completed",
      lastActivityAt: 4000,
    });
    expect(readSessionUnread(ctx.db, sessionId)).toEqual({ unreadSince: 4000 });
    expect(sinks.focusedSessionIds).toHaveBeenCalled();

    sinks.publishSessionActivity.mockClear();
    services.sessionReadWatch!.observeFocused(new Set([sessionId]));
    await vi.waitFor(() => expect(sinks.publishSessionActivity).toHaveBeenCalledOnce());
    expect(sinks.publishSessionActivity.mock.calls[0]?.[0].row.read).toBeUndefined();
    expect(readSessionUnread(ctx.db, sessionId)).toEqual({ unreadSince: null });
    expect(sinks.listOpenNativeBindings).toHaveBeenCalled();
    services.sessionReadWatch!.observeFocused(new Set([sessionId]));
    expect(sinks.publishSessionActivity).toHaveBeenCalledOnce();

    writeSessionUnread(ctx.db, sessionId, 5000);
    const failure = new Error("read unavailable");
    vi.spyOn(engine, "getSession").mockRejectedValue(failure);
    services.sessionReadWatch!.observeFocused(new Set([sessionId]));
    await vi.waitFor(() =>
      expect(sinks.log.warn).toHaveBeenCalledWith(
        `[volli] could not publish the read row of ${sessionId}:`,
        failure,
      ),
    );
  });
});
