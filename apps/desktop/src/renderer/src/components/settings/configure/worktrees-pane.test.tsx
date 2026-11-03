// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import type { Project } from "@volli/shared";
import { WorktreesPane } from "./worktrees-pane";
import { TooltipProvider } from "@renderer/components/ui/tooltip";
const updateSetupCommand = vi.fn().mockResolvedValue(true);
vi.mock("@renderer/stores/projects", () => ({
  useProjectsStore: (select: (store: unknown) => unknown) =>
    select({ updateSetupCommand, updateBaseBranch: vi.fn() }),
}));
const project: Project = {
  id: "p1",
  name: "Project",
  path: "/repo",
  ticketPrefix: "P",
  baseBranch: "trunk",
  setupCommand: "pnpm install",
  colorIndex: 0,
  sortOrder: 0,
  createdAt: 0,
  updatedAt: 0,
};
it("reads real refs, keeps the stored branch visible and explicitly saves the script", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const branches = vi.fn().mockResolvedValue({
    ok: true,
    branches: ["trunk", "feature"],
    current: "trunk",
    remotes: ["origin/main"],
    fetchedAt: null,
  });
  vi.stubGlobal("api", { worktree: { branches } });
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <TooltipProvider>
          <WorktreesPane project={project} />
        </TooltipProvider>,
      ),
    );
    expect(branches).toHaveBeenCalledWith("p1");
    expect(host.querySelector("#project-base-branch")!.textContent).toBe("trunk");
    const field = host.querySelector<HTMLTextAreaElement>("#project-setup-command")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
        field,
        "pnpm install\npnpm build",
      );
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(host.textContent).toContain("Unsaved");
    expect(updateSetupCommand).not.toHaveBeenCalled();
    await act(async () =>
      Array.from(host.querySelectorAll("button"))
        .find((b) => b.textContent === "Save command")!
        .click(),
    );
    expect(updateSetupCommand).toHaveBeenCalledWith("p1", "pnpm install\npnpm build");
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});

it.each(["refused", "rejected"])(
  "keeps a %s branch read on screen with a retry",
  async (failure) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const branches = vi.fn().mockResolvedValue({
      ok: true,
      branches: ["trunk", "feature"],
      current: "trunk",
      remotes: [],
      fetchedAt: null,
    });
    if (failure === "refused") branches.mockResolvedValueOnce({ ok: false, error: "Unavailable" });
    else branches.mockRejectedValueOnce(new Error("Unavailable"));
    vi.stubGlobal("api", { worktree: { branches } });
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    try {
      await act(async () =>
        root.render(
          <TooltipProvider>
            <WorktreesPane project={project} />
          </TooltipProvider>,
        ),
      );
      expect(host.querySelector('[role="status"]')?.textContent).toContain(
        "Couldn’t read branches",
      );
      expect(host.querySelector<HTMLButtonElement>("#project-base-branch")?.disabled).toBe(true);
      await act(async () =>
        Array.from(host.querySelectorAll("button"))
          .find((button) => button.textContent === "Retry branch read")!
          .click(),
      );
      expect(branches).toHaveBeenCalledTimes(2);
      expect(host.textContent).not.toContain("Couldn’t read branches");
      expect(host.querySelector<HTMLButtonElement>("#project-base-branch")?.disabled).toBe(false);
      expect(host.querySelector("#project-base-branch")?.textContent).toBe("trunk");
    } finally {
      await act(async () => root.unmount());
      host.remove();
      vi.unstubAllGlobals();
    }
  },
);
