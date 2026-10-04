import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { insertProject } from "./db/projects-repo";
import { readSessionUnread, writeSessionUnread } from "./db/session-read-repo";
import { openTestDb, testProject, type TestDb } from "./db/test-helpers";
import type { AttentionDeliveryPort } from "./ports/attention";
import type { HostEventBus, HostEventMap } from "./ports/events";
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
    events: { publish: vi.fn<HostEventBus["publish"]>() },
    attention: {
      deliver: vi.fn<AttentionDeliveryPort["deliver"]>(() => ({ delivered: true })),
      focusedSessionIds: vi.fn(() => new Set<string>()),
    },
    listOpenNativeBindings: vi.fn(() => [{ attachmentId: "live-binding" }]),
    observeScheduledResume: vi.fn<HostSessionPorts["observeScheduledResume"]>(),
  } satisfies HostSessionPorts;
}

/** The `session-activity` notices published so far, in order. */
function activity(sinks: ReturnType<typeof ports>) {
  return sinks.events.publish.mock.calls.flatMap(([topic, payload]) =>
    topic === "session-activity" ? [payload as HostEventMap["session-activity"]] : [],
  );
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
  sinks.events.publish.mockImplementation((topic) => {
    if (topic === "session-activity") order.push("publish");
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
    expect(sinks.attention.focusedSessionIds).not.toHaveBeenCalled();
    expect(sinks.attention.deliver).not.toHaveBeenCalled();
    expect(sinks.events.publish).not.toHaveBeenCalled();
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
    expect(sinks.events.publish).toHaveBeenCalledWith(
      "session-activity",
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
    expect(sinks.attention.focusedSessionIds).toHaveBeenCalled();

    sinks.events.publish.mockClear();
    services.sessionReadWatch!.observeFocused(new Set([sessionId]));
    await vi.waitFor(() => expect(activity(sinks)).toHaveLength(1));
    expect(activity(sinks)[0]?.row.read).toBeUndefined();
    expect(readSessionUnread(ctx.db, sessionId)).toEqual({ unreadSince: null });
    expect(sinks.listOpenNativeBindings).toHaveBeenCalled();
    services.sessionReadWatch!.observeFocused(new Set([sessionId]));
    expect(activity(sinks)).toHaveLength(1);

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
