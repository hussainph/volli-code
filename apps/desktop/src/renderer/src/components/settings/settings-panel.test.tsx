// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { SettingsPanel, useSettingsShortcut } from "./settings-panel";
import { setSettingsWindowOpener, useUiStore } from "@renderer/stores/ui";

vi.mock("@renderer/components/pages/settings-page", () => ({
  SettingsPage: () => <input type="search" aria-label="Search settings" />,
}));
vi.mock("@renderer/components/ui/sonner", () => ({ Toaster: () => null }));
vi.mock("@renderer/components/update/update-install-dialog", () => ({ UpdateInstallDialog: () => null }));
vi.mock("@renderer/components/cloud-moves/cloud-moves", () => ({ CloudMovesRoot: () => null }));
vi.mock("@renderer/components/hosts/hosts-chrome", () => ({ HostsChrome: () => null }));
vi.mock("@renderer/components/rail/folder-claim-dialog", () => ({ FolderClaimDialog: () => null }));
vi.mock("@renderer/hooks/use-overlay-scrollbars", () => ({ useOverlayScrollbars: () => {} }));
vi.mock("@renderer/hooks/use-zoom-commands", () => ({ useZoomCommands: () => {} }));
let root: Root;
let host: HTMLDivElement;
const open = vi.fn();
const ready = vi.fn(async () => ({ ok: true, navigation: null }));
function ShortcutHost() {
  useSettingsShortcut();
  return <button onClick={() => useUiStore.getState().setSettingsOpen(true)}>Settings</button>;
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.api = { settingsWindow: { ready } } as unknown as typeof window.api;
  useUiStore.setState({ settingsOpen: false });
  setSettingsWindowOpener(open);
  open.mockClear();
  ready.mockClear();
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  setSettingsWindowOpener(null);
  vi.unstubAllGlobals();
});
it("repeated Command-comma opens or raises Settings without blocking the workspace", async () => {
  await act(async () => root.render(<ShortcutHost />));
  await act(async () => {
    for (let i = 0; i < 2; i++) window.dispatchEvent(new KeyboardEvent("keydown", { key: ",", metaKey: true, cancelable: true }));
  });
  expect(open).toHaveBeenCalledTimes(2);
  expect(useUiStore.getState().settingsOpen).toBe(false);
});
it("routes pane and provider intents through the same native opener", () => {
  useUiStore.getState().setSettingsOpen(true, "models", "openai");
  useUiStore.getState().requestConfigureCategory("worktrees");
  useUiStore.getState().setSettingsOpen(false);
  expect(open.mock.calls).toEqual([[{ category: "models", signInProviderId: "openai" }], [{ configureCategory: "worktrees" }]]);
  expect(useUiStore.getState().configureCategory).toBeNull();
});
it("renders a window root without modal semantics or Escape dismissal", async () => {
  await act(async () => root.render(<SettingsPanel />));
  expect(host.querySelector('[data-settings-panel]')).not.toBeNull();
  expect(host.querySelector('[role="dialog"]')).toBeNull();
  expect(host.querySelector('[data-slot="dialog-overlay"]')).toBeNull();
  expect(document.activeElement?.getAttribute("aria-label")).toBe("Search settings");
  await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(host.querySelector('[data-settings-panel]')).not.toBeNull();
  expect(open).not.toHaveBeenCalled();
});
