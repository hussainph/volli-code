// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, it, vi } from "vite-plus/test";
import type { Project } from "@volli/shared";
import { WorktreesPane } from "./worktrees-pane";
import { TooltipProvider } from "@renderer/components/ui/tooltip";
const updateSetupCommand = vi.fn().mockResolvedValue(true);
const updateBaseBranch = vi.fn().mockResolvedValue(true);
beforeEach(() => {
  updateSetupCommand.mockClear();
  updateBaseBranch.mockClear();
});
vi.mock("@renderer/stores/projects", () => ({
  useProjectsStore: (select: (store: unknown) => unknown) =>
    select({ updateSetupCommand, updateBaseBranch }),
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
      expect(host.querySelector<HTMLButtonElement>("#project-base-branch")?.disabled).toBe(false);
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

it.each(["blur", "keyboard", "navigation"])(
  "commits setup edits on %s without silently discarding the draft",
  async (path) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("api", {
      worktree: { branches: vi.fn().mockResolvedValue({ ok: false, error: "offline" }) },
    });
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
      const field = host.querySelector<HTMLTextAreaElement>("#project-setup-command")!;
      await act(async () => {
        field.focus();
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
          field,
          "echo parity\npnpm build",
        );
        field.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(async () => {
        if (path === "blur") field.blur();
        else if (path === "keyboard")
          field.dispatchEvent(
            new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true }),
          );
        else root.render(null);
      });
      expect(updateSetupCommand).toHaveBeenCalledExactlyOnceWith(
        project.id,
        "echo parity\npnpm build",
      );
    } finally {
      await act(async () => root.unmount());
      host.remove();
      vi.unstubAllGlobals();
    }
  },
);

it("accepts a validated custom branch even when discovery fails", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("api", {
    worktree: { branches: vi.fn().mockResolvedValue({ ok: false, error: "offline" }) },
  });
  HTMLElement.prototype.scrollIntoView = vi.fn();
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
    const trigger = host.querySelector<HTMLButtonElement>("#project-base-branch")!;
    expect(trigger.disabled).toBe(false);
    await act(async () =>
      trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })),
    );
    const other = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (node) => node.textContent === "Other branch",
    )!;
    await act(async () => {
      other.focus();
      other.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    const field = host.querySelector<HTMLInputElement>('[aria-label="Custom branch"]')!;
    const enter = async (value: string) =>
      act(async () => {
        field.focus();
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
          field,
          value,
        );
        field.dispatchEvent(new Event("input", { bubbles: true }));
      });
    await enter("bad branch");
    await act(async () =>
      field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
    );
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Not a valid branch");
    expect(updateBaseBranch).not.toHaveBeenCalled();
    await enter("release/known-branch");
    await act(async () =>
      field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
    );
    expect(updateBaseBranch).toHaveBeenCalledWith(project.id, "release/known-branch");
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
