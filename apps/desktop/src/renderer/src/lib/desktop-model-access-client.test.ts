import { describe, expect, it, vi } from "vite-plus/test";

import { openProjectModelAccess } from "./desktop-model-access-client";

describe("project-scoped Model Access", () => {
  it("opens the bundled login flow in the selected project's scratch scope", async () => {
    const openTerminal = vi.fn(async () => "terminal-model-access");

    await expect(openProjectModelAccess("project-1", openTerminal)).resolves.toBe(true);
    expect(openTerminal).toHaveBeenCalledWith({ kind: "scratch", projectId: "project-1" });
  });

  it("reports a refused terminal launch", async () => {
    const openTerminal = vi.fn(async () => null);

    await expect(openProjectModelAccess("project-1", openTerminal)).resolves.toBe(false);
  });
});
