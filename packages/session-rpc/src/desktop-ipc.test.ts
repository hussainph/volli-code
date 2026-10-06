import { describe, expect, it } from "vite-plus/test";

import { DESKTOP_IPC_EXPOSURE, DESKTOP_IPC_PATHS } from "./desktop-ipc";
import { createBoardRouter } from "./board-router";
import { createSessionRouter } from "./index";

describe("the desktop's IPC exposure", () => {
  // The table is total over the routers at the type level; at runtime it names
  // exactly the procedures they publish, so nothing is served or withheld by a
  // path that does not exist.
  it("classifies every procedure the desktop's routers publish, and nothing else", () => {
    // oxlint-disable-next-line no-underscore-dangle -- tRPC's introspection door.
    const published = [
      // oxlint-disable-next-line no-underscore-dangle -- as above.
      ...Object.keys(createSessionRouter()._def.procedures),
      // oxlint-disable-next-line no-underscore-dangle -- as above.
      ...Object.keys(createBoardRouter()._def.procedures),
    ].toSorted();
    expect(Object.keys(DESKTOP_IPC_EXPOSURE).toSorted()).toEqual(published);
  });

  // Unchanged by VC-608: the window reaches what it reached before the bridge
  // became router-generic, plus the board router VC-565 serves beside it.
  it("serves the window exactly its Session, settings, Model Access and board procedures", () => {
    expect(Object.isFrozen(DESKTOP_IPC_PATHS)).toBe(true);
    expect(DESKTOP_IPC_PATHS).toEqual([
      "settings.experiments",
      "settings.setExperiment",
      "modelAccess.inspect",
      "modelAccess.defaults",
      "modelAccess.setDefault",
      "modelAccess.hiddenModels",
      "modelAccess.setHiddenModels",
      "modelAccess.compactionPolicy",
      "modelAccess.setCompactionPolicy",
      "modelAccess.codeModePolicy",
      "modelAccess.setCodeModePolicy",
      "modelAccess.pickerView",
      "modelAccess.setPickerView",
      "sessions.create",
      "sessions.attach",
      "session.snapshot",
      "session.history",
      "session.projection",
      "session.subscribe",
      "session.command",
      "session.cancelQueued",
      "session.editQueued",
      "session.cancelInteraction",
      "session.reconcile",
      // The board (VC-565): what the window reads and writes with `cloud` on.
      "board.snapshot",
      "board.roster",
      "board.changes",
      "board.projectFolder",
      "board.ticketBody",
      "board.archivedTickets",
      "board.ticketEvents",
      "board.latestSignals",
      "board.statusEntries",
      "board.comments",
      "ticket.move",
      "board.updateProject",
      "board.setSkillModes",
      "board.setSessionDefaults",
      "board.createTicket",
      "board.moveTickets",
      "board.setPriority",
      "board.updateTicket",
      "board.setLabels",
      "board.archiveTicket",
      "board.unarchiveTicket",
      "board.deleteTicket",
      "board.createComment",
      "board.updateComment",
      "board.removeComment",
      "board.setLabelColor",
    ]);
  });

  // Lab diagnostics are development-only, and the host protocol's own
  // procedures are a network caller's: neither crosses into a production
  // renderer.
  it("withholds the lab's diagnostics and the WebSocket's own procedures", () => {
    expect(DESKTOP_IPC_PATHS.some((path) => path.startsWith("labDiagnostics."))).toBe(false);
    for (const path of ["protocol.welcome", "session.list", "session.show", "session.peek"]) {
      expect(DESKTOP_IPC_PATHS).not.toContain(path);
    }
  });
});
