// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { AppShell } from "./app-shell";
import { useUiStore } from "@renderer/stores/ui";

const state = vi.hoisted(() => ({ peek: true, reduced: false }));
vi.mock("@renderer/hooks/use-reduced-motion", () => ({ useReducedMotion: () => state.reduced }));
vi.mock("@renderer/hooks/use-fullscreen", () => ({ useFullScreen: () => false }));
vi.mock("@renderer/components/sidebar/edge-reveal", () => ({
  useEdgeReveal: () => ({ visible: state.peek, arming: false }),
  armRevealClock: () => {},
  CLOSE_MS: 110,
  OPEN_MS: 200,
  ZONE_TOP_DEAD_BAND: 24,
  ZONE_WIDTH: 8,
}));
vi.mock("@renderer/components/sidebar/sidebar-pour", () => ({ useSidebarPour: () => false }));
vi.mock("@renderer/components/browser/browser-plane-freeze", () => ({
  hasVisibleNativePlane: () => false,
}));
// Keep the real shell and sidebar primitives; unrelated pages and app-wide
// subscriptions do not participate in the native-plane exit lifetime.
vi.mock("@renderer/components/automations/armed-run-window", () => ({
  ArmedRunWindows: () => null,
}));
vi.mock("@renderer/components/chrome-bar", () => ({ ChromeBar: () => null }));
vi.mock("@renderer/components/hosts/host-island", () => ({ HostIsland: () => null }));
vi.mock("@renderer/components/harness/harness-trust-dialog", () => ({
  HarnessTrustDialog: () => null,
}));
vi.mock("@renderer/components/board/new-ticket-dialog", () => ({ NewTicketDialog: () => null }));
vi.mock("@renderer/components/pages/main-content", () => ({ MainContent: () => null }));
vi.mock("@renderer/components/rail/folder-claim-dialog", () => ({ FolderClaimDialog: () => null }));
vi.mock("@renderer/components/cloud-moves/cloud-moves", () => ({ CloudMovesRoot: () => null }));
vi.mock("@renderer/components/rail/project-rail", () => ({ ProjectRail: () => null }));
vi.mock("@renderer/components/sessions/session-detail-dialog", () => ({
  SessionDetailDialog: () => null,
}));
vi.mock("@renderer/components/sessions/session-team", () => ({ SessionShareDialog: () => null }));
vi.mock("@renderer/components/sidebar/primary-sidebar", () => ({ PrimarySidebar: () => null }));
vi.mock("@renderer/components/sidebar/sidebar-resize-handle", () => ({
  SidebarResizeHandle: () => null,
  LIVE_WIDTH_PROPERTY: "--sidebar-live-width",
}));
vi.mock("@renderer/components/ui/sonner", () => ({ Toaster: () => null }));
vi.mock("@renderer/components/update/update-install-dialog", () => ({
  UpdateInstallDialog: () => null,
}));
vi.mock("@renderer/hooks/use-browser-app-shortcuts", () => ({ useBrowserAppShortcuts: () => {} }));
vi.mock("@renderer/hooks/use-nav-history", () => ({ useNavHistory: () => {} }));
vi.mock("@renderer/hooks/use-new-ticket-shortcut", () => ({ useNewTicketShortcut: () => {} }));
vi.mock("@renderer/hooks/use-project-roots-sync", () => ({ useProjectRootsSync: () => {} }));
vi.mock("@renderer/hooks/use-project-shortcuts", () => ({ useProjectShortcuts: () => {} }));
vi.mock("@renderer/hooks/use-notification-target", () => ({
  useNotificationTargetReport: () => {},
}));
vi.mock("@renderer/hooks/use-startup-notices", () => ({
  useBootNotice: () => {},
  useCliLaunchNotice: () => {},
}));
vi.mock("@renderer/hooks/use-zoom-commands", () => ({ useZoomCommands: () => {} }));

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const overlay = () => host.querySelector<HTMLElement>("[data-native-plane-overlay]");
async function render() {
  await act(async () => root.render(<AppShell />));
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.peek = true;
  state.reduced = false;
  useUiStore.setState({ sidebarPinned: false, terminalFocusTarget: null });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("floating navigation native-plane exit", () => {
  it("keeps the Browser frozen until a moving panel's exit ends", async () => {
    await render();
    const panel = overlay()!;
    state.peek = false;
    await render();
    expect(overlay()).toBe(panel);
    await act(async () => panel.dispatchEvent(new Event("transitionend", { bubbles: true })));
    expect(overlay()).toBeNull();
  });

  it("releases the Browser immediately for reduced-motion exits", async () => {
    state.reduced = true;
    await render();
    expect(overlay()).not.toBeNull();
    state.peek = false;
    await render();
    expect(overlay()).toBeNull();
  });

  it("releases an in-flight exit when Motion is switched off", async () => {
    await render();
    state.peek = false;
    await render();
    expect(overlay()).not.toBeNull();
    state.reduced = true;
    await render();
    expect(overlay()).toBeNull();
  });
});
