// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { TitleReveal } from "@renderer/components/ui/title-reveal";
import { recordTitleChange, useAutomaticTitleChange } from "./title-change";

let root: Root;
let host: HTMLDivElement;
function Label({ title }: { title: string }) {
  const automatic = useAutomaticTitleChange("session", title);
  return <TitleReveal text={title} automatic={automatic} />;
}
async function render(title: string) {
  await act(async () => root.render(<Label title={title} />));
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  delete document.documentElement.dataset.motion;
  recordTitleChange("session", "", false);
  vi.unstubAllGlobals();
});

it("only reveals an exact automatic replacement, not manual or stream/CLI changes", async () => {
  await render("Chat");
  act(() => recordTitleChange("session", "Automatic title", true));
  await render("Automatic title");
  expect(host.querySelector(".title-reveal-word")).not.toBeNull();
  await render("Unattributed refinement");
  expect(host.querySelector(".title-reveal-word")).toBeNull();
  await render("Automatic title");
  expect(host.querySelector(".title-reveal-word")).toBeNull();
  act(() => recordTitleChange("session", "Manual rename", false));
  await render("Manual rename");
  expect(host.querySelector(".title-reveal-word")).toBeNull();
  expect(host.textContent).toBe("Manual rename");
});

it("cancels on live Motion-off, with no replay after restoring it", async () => {
  await render("Chat");
  act(() => recordTitleChange("session", "Automatic title", true));
  await render("Automatic title");
  expect(host.querySelector(".title-reveal-word")).not.toBeNull();
  act(() => {
    document.documentElement.dataset.motion = "off";
    window.dispatchEvent(new Event("volli-motion-change"));
  });
  expect(host.querySelector(".title-reveal-word")).toBeNull();
  act(() => {
    delete document.documentElement.dataset.motion;
    window.dispatchEvent(new Event("volli-motion-change"));
  });
  expect(host.querySelector(".title-reveal-word")).toBeNull();
});
