// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { MarkdownCommandDialog } from "./markdown-command-dialog";
import { openProjectSettingFile } from "../open-project-setting-file";
vi.mock("../open-project-setting-file", () => ({ openProjectSettingFile: vi.fn() }));
it("creates a real project markdown command and opens its returned path", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const create = vi.fn().mockResolvedValue({ ok: true, relPath: ".volli/commands/review.md" });
  vi.stubGlobal("api", { files: { create } });
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  const onCreated = vi.fn();
  try {
    await act(async () =>
      root.render(<MarkdownCommandDialog projectId="p1" onCreated={onCreated} />),
    );
    await act(async () => host.querySelector<HTMLButtonElement>("button")!.click());
    const input = document.querySelector<HTMLInputElement>("#markdown-command-name")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        input,
        "review",
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const save = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent === "Create and open",
    )!;
    await act(async () => save.click());
    expect(create).toHaveBeenCalledWith({ projectId: "p1", relPath: ".volli/commands/review.md" });
    expect(openProjectSettingFile).toHaveBeenCalledWith("p1", ".volli/commands/review.md");
    expect(onCreated).toHaveBeenCalledOnce();
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
