/**
 * What a clicked alert actually does to this window (VC-295 rule 6, round 2).
 *
 * The surface is a port so the ORDER can be asserted: "select the Session
 * first, then reveal the item" is the whole of the rule, and a test that only
 * checked the destination would pass on an implementation that revealed a card
 * in a Session nobody had opened yet.
 */
import { describe, expect, it } from "vite-plus/test";
import type { NotificationTarget } from "@volli/shared";

import { activateNotificationTarget, type NotificationSurface } from "./notification-activation";
import type { TerminalSessionPlacement } from "./notification-target";

const CHAT_TARGET: NotificationTarget = {
  kind: "session",
  projectId: "p1",
  ticketId: "t1",
  sessionId: "s1",
  interactionId: "i1",
  attentionId: null,
};

const TERMINAL_PLACEMENT: TerminalSessionPlacement = {
  ownerId: "t1",
  tabId: "term-root",
  paneId: "term-pane",
  scope: { kind: "ticket", projectId: "p1", ticketId: "t1" },
};

function harness(
  options: {
    terminal?: TerminalSessionPlacement | null;
    items?: { interactionIds: readonly string[]; attentionIds: readonly string[] } | null;
  } = {},
) {
  const acts: string[] = [];
  const said: string[] = [];
  const surface: NotificationSurface = {
    terminalPlacement: () => options.terminal ?? null,
    selectProject: (projectId) => acts.push(`select:${projectId}`),
    openTicket: (projectId, ticketId) => acts.push(`ticket:${projectId}/${ticketId}`),
    openChatSession: (route) => acts.push(`chat:${route.kind}:${route.sessionId}:${route.tabId}`),
    openTerminal: (route) =>
      acts.push(`terminal:${route.kind}:${route.tabId}:${"paneId" in route ? route.paneId : ""}`),
    revealItem: (sessionId, item) =>
      acts.push(`reveal:${sessionId}:${item.interactionId ?? "-"}:${item.attentionId ?? "-"}`),
    openUpdate: () => acts.push("update"),
    sessionItems: async () => options.items ?? null,
    say: (message) => said.push(message),
  };
  return { surface, acts, said };
}

describe("activateNotificationTarget", () => {
  it("selects the project and the Session before revealing the item it named", async () => {
    const h = harness({ items: { interactionIds: ["i1"], attentionIds: [] } });

    await activateNotificationTarget(CHAT_TARGET, h.surface);

    expect(h.acts).toEqual(["select:p1", "chat:ticket-session:s1:chat:s1", "reveal:s1:i1:-"]);
    expect(h.said).toEqual([]);
  });

  it("opens a Board chat Session on Home", async () => {
    const h = harness({ items: { interactionIds: [], attentionIds: ["a1"] } });

    await activateNotificationTarget(
      { ...CHAT_TARGET, ticketId: null, interactionId: null, attentionId: "a1" },
      h.surface,
    );

    expect(h.acts).toEqual(["select:p1", "chat:project-session:s1:chat:s1", "reveal:s1:-:a1"]);
  });

  it("opens the terminal a harness alert is waiting in, and reveals nothing there", async () => {
    // A TUI's question lives in the pane, not in a durable Interaction: there
    // is no card to select, and the terminal itself is the reveal.
    const h = harness({ terminal: TERMINAL_PLACEMENT });

    await activateNotificationTarget(
      { ...CHAT_TARGET, sessionId: "term-pane", interactionId: null },
      h.surface,
    );

    expect(h.acts).toEqual(["select:p1", "terminal:ticket-terminal:term-root:term-pane"]);
    expect(h.said).toEqual([]);
  });

  it("opens a Board terminal on Home", async () => {
    const h = harness({
      terminal: {
        ownerId: "p1",
        tabId: "board-root",
        paneId: "board-root",
        scope: { kind: "project", projectId: "p1" },
      },
    });

    await activateNotificationTarget({ ...CHAT_TARGET, sessionId: "board-root" }, h.surface);

    expect(h.acts).toEqual(["select:p1", "terminal:project-terminal:board-root:board-root"]);
  });

  it("opens a ticket alert's ticket", async () => {
    const h = harness();

    await activateNotificationTarget(
      { kind: "ticket", projectId: "p1", ticketId: "t1" },
      h.surface,
    );

    expect(h.acts).toEqual(["select:p1", "ticket:p1/t1"]);
  });

  it("opens the existing update surface", async () => {
    const h = harness();

    await activateNotificationTarget({ kind: "update" }, h.surface);

    // No project selection: an update belongs to the app, not to a workspace.
    expect(h.acts).toEqual(["update"]);
  });

  it("opens the Session anyway when its question has been answered, and says why", async () => {
    // The stale case: nothing is replayed — the reveal is still requested so a
    // card that IS open wins the slot — and the person is told once why the
    // thing they were interrupted about is not there.
    const h = harness({ items: { interactionIds: ["i2"], attentionIds: [] } });

    await activateNotificationTarget(CHAT_TARGET, h.surface);

    expect(h.acts).toEqual(["select:p1", "chat:ticket-session:s1:chat:s1", "reveal:s1:i1:-"]);
    expect(h.said).toEqual(["That question was already answered."]);
  });

  it("says nothing about staleness when the Session never reported", async () => {
    // An unproven claim about somebody's own work is worse than no claim.
    const h = harness({ items: null });

    await activateNotificationTarget(CHAT_TARGET, h.surface);

    expect(h.said).toEqual([]);
  });

  it("asks nothing about items for an alert that named none", async () => {
    const h = harness({ items: { interactionIds: [], attentionIds: [] } });

    await activateNotificationTarget({ ...CHAT_TARGET, interactionId: null }, h.surface);

    expect(h.acts).toEqual(["select:p1", "chat:ticket-session:s1:chat:s1"]);
    expect(h.said).toEqual([]);
  });
});
