// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { FontPicker } from "./font-picker";
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  HTMLElement.prototype.scrollIntoView = () => {};
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
async function open(onSelect = vi.fn().mockResolvedValue(true)) {
  await act(async () =>
    root.render(
      <FontPicker
        ariaLabel="Font family"
        buttonLabel="Ghostty"
        searchLabel="Search fonts"
        searchPlaceholder="Search fonts"
        empty="No fonts"
        families={["Menlo", "Monaco"]}
        activeValue="Monaco"
        onSelect={onSelect}
      />,
    ),
  );
  await act(async () => host.querySelector("button")!.click());
  return onSelect;
}
it("previews each installed family without bundling a font list", async () => {
  await open();
  const options = [...document.querySelectorAll<HTMLElement>("[cmdk-item]")];
  expect(options).toHaveLength(2);
  expect(options[0]!.querySelector<HTMLElement>("[style]")!.style.fontFamily).toContain("Menlo");
  expect(options[1]!.querySelector<HTMLElement>("[style]")!.style.fontFamily).toContain("Monaco");
});
it("filters installed fonts and closes only after a successful write", async () => {
  const save = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  await open(save);
  const search = document.querySelector<HTMLInputElement>("[cmdk-input]")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "men");
    search.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const item = document.querySelector<HTMLElement>("[cmdk-item]")!;
  expect(item.textContent).toContain("Menlo");
  await act(async () => item.click());
  expect(save).toHaveBeenCalledWith("Menlo");
  expect(document.querySelector("[cmdk-input]")).not.toBeNull();
  await act(async () => item.click());
  expect(document.querySelector("[cmdk-input]")).toBeNull();
});
