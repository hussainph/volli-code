import { describe, expect, it } from "vite-plus/test";

import { DESKTOP_IPC_EXPOSURE, DESKTOP_IPC_PATHS } from "./desktop-ipc";
import { createSessionRouter } from "./index";

describe("the desktop's IPC exposure", () => {
  // The table is total over the routers at the type level; at runtime it names
  // exactly the procedures they publish, so nothing is served or withheld by a
  // path that does not exist.
  it("classifies every procedure the desktop's routers publish, and nothing else", () => {
    // oxlint-disable-next-line no-underscore-dangle -- tRPC's introspection door.
    const published = Object.keys(createSessionRouter()._def.procedures).toSorted();
    expect(Object.keys(DESKTOP_IPC_EXPOSURE).toSorted()).toEqual(published);
  });

  // Unchanged by VC-608: the window reaches what it reached before the bridge
  // became router-generic, and nothing more.
  it("serves the window exactly its Session, settings and Model Access procedures", () => {
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
