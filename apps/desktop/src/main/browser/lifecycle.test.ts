import { describe, expect, it } from "vite-plus/test";

import type { TicketEvent, TicketEventPayload } from "@volli/shared";

import { closeHeadlessTabsOnTicketArchive } from "./lifecycle";
import type { TicketWake } from "../ticket-wake";

function wakeSeam() {
  const listeners = new Set<(wake: TicketWake) => void>();
  return {
    subscribe: (listener: (wake: TicketWake) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit: (ticketId: string, payload: TicketEventPayload) => {
      const wake = {
        event: { ticketId, payload } as TicketEvent,
        projectId: "project-1",
        cursor: "c1",
      };
      for (const listener of listeners) listener(wake);
    },
    get size() {
      return listeners.size;
    },
  };
}

describe("closeHeadlessTabsOnTicketArchive", () => {
  it("closes an archived Ticket's headless agent tabs, and nothing on any other event", () => {
    const closed: string[] = [];
    const host = {
      closeHeadlessForTicket: (ticketId: string) => {
        closed.push(ticketId);
        return [];
      },
    };
    const seam = wakeSeam();
    closeHeadlessTabsOnTicketArchive(host, seam.subscribe);

    seam.emit("VC-1", { kind: "created", status: "backlog", title: "One" });
    seam.emit("VC-1", { kind: "status_changed", from: "todo", to: "doing" });
    // Unarchiving is the nearest neighbour, and closing on it would take away
    // tabs a Ticket just got back.
    seam.emit("VC-1", { kind: "unarchived" });
    expect(closed).toEqual([]);

    seam.emit("VC-1", { kind: "archived" });
    seam.emit("VC-2", { kind: "archived" });

    // The archived Ticket's own id: a headless tab has no surface that could
    // show it, so a wrong id here leaks a live WebContentsView nobody can see.
    expect(closed).toEqual(["VC-1", "VC-2"]);
  });

  it("hands back the unsubscribe, so a second bootstrap does not double-close", () => {
    const closed: string[] = [];
    const seam = wakeSeam();
    const stop = closeHeadlessTabsOnTicketArchive(
      {
        closeHeadlessForTicket: (ticketId) => {
          closed.push(ticketId);
          return [];
        },
      },
      seam.subscribe,
    );

    stop();
    seam.emit("VC-1", { kind: "archived" });

    expect(closed).toEqual([]);
    expect(seam.size).toBe(0);
  });
});
