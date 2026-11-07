// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { SettingsPanel, useSettingsShortcut } from "./settings-panel";
import { useUiStore } from "@renderer/stores/ui";
import { Popover, PopoverContent, PopoverTrigger } from "@renderer/components/ui/popover";

vi.mock("@renderer/components/pages/settings-page", () => ({
  SettingsPage: () => (
    <>
      <input type="search" aria-label="Search settings" />
      <Popover>
        <PopoverTrigger>Nested choice</PopoverTrigger>
        <PopoverContent>
          <button>Choice</button>
        </PopoverContent>
      </Popover>
    </>
  ),
}));
let root: Root;
let host: HTMLDivElement;
const outside = vi.fn();
function Host() {
  useSettingsShortcut();
  const open = useUiStore((s) => s.settingsOpen);
  return (
    <>
      <button onClick={() => useUiStore.getState().setSettingsOpen(true)}>Preferences</button>
      <button onClick={outside}>Underlying action</button>
      {open ? <SettingsPanel /> : null}
    </>
  );
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  useUiStore.setState({ settingsOpen: false });
  outside.mockClear();
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  await act(async () => root.render(<Host />));
});
afterEach(async () => {
  await act(async () => {
    root.unmount();
    await tick();
  });
  host.remove();
  useUiStore.setState({ settingsOpen: false });
  vi.unstubAllGlobals();
});
async function openPanel() {
  const button = host.querySelector<HTMLButtonElement>("button")!;
  button.focus();
  await act(async () => {
    button.click();
    await tick();
  });
  return button;
}
it("has no scrim or modal lock and restores focus on Escape", async () => {
  const opener = await openPanel();
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  expect(document.querySelector('[aria-modal="true"]')).toBeNull();
  expect(document.querySelector('[data-slot="dialog-overlay"]')).toBeNull();
  expect(document.activeElement?.getAttribute("aria-label")).toBe("Search settings");
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await tick();
  });
  expect(useUiStore.getState().settingsOpen).toBe(false);
  await vi.waitFor(() => expect(document.activeElement).toBe(opener));
});
it("dismisses on an outside pointer without eating its click or stealing its focus", async () => {
  await openPanel();
  const button = host.querySelectorAll<HTMLButtonElement>("button")[1];
  await act(async () => {
    button.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true }));
    button.focus();
    button.click();
    await tick();
  });
  expect(useUiStore.getState().settingsOpen).toBe(false);
  expect(outside).toHaveBeenCalledOnce();
  expect(document.activeElement).toBe(button);
});
it("toggles with Command-comma while the search field has focus", async () => {
  await act(async () => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: ",", metaKey: true, bubbles: true, cancelable: true }),
    );
    await tick();
  });
  expect(useUiStore.getState().settingsOpen).toBe(true);
  await act(async () => {
    document.activeElement?.dispatchEvent(
      new KeyboardEvent("keydown", { key: ",", metaKey: true, bubbles: true, cancelable: true }),
    );
    await tick();
  });
  expect(useUiStore.getState().settingsOpen).toBe(false);
});
it("keeps a nested portaled popover within preferences' interaction scope", async () => {
  await openPanel();
  await act(async () => {
    [...document.querySelectorAll<HTMLButtonElement>("button")]
      .find((b) => b.textContent === "Nested choice")!
      .click();
    await tick();
  });
  const choice = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.textContent === "Choice",
  )!;
  await act(async () => {
    choice.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    choice.click();
    await tick();
  });
  expect(useUiStore.getState().settingsOpen).toBe(true);
});
