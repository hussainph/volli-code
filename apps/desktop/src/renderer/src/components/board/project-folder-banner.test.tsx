// @vitest-environment jsdom
/**
 * The recovery path a renamed project folder has (VC-430).
 *
 * The defect this covers is not a wrong pixel: a project whose folder moved
 * looks perfectly healthy on the board and fails at everything downstream —
 * empty file tree, Sessions that will not start, every git action erroring —
 * and not one of those failures says the true thing. What is asserted here is
 * that the board says it, and that the way out leads to a RELINK of the
 * existing project rather than to a second one.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { Project, ProjectFolderState } from "@volli/shared";

import { useProjectsStore } from "@renderer/stores/projects";

import { ProjectFolderBanner } from "./project-folder-banner";

const PROJECT: Project = {
  id: "p1",
  name: "Volli",
  path: "/Users/me/volli",
  ticketPrefix: "VC",
  colorIndex: 0,
  sortOrder: 0,
  createdAt: 0,
  updatedAt: 0,
};

let root: Root | null = null;
let container: HTMLElement | null = null;

/**
 * Every window call the banner and its dialog can make, scripted per test.
 *
 * `states` is answered in order and the LAST answer repeats, so a test can say
 * "missing, then present" and mean the two looks either side of a relink.
 */
function stubApi(
  states: readonly (ProjectFolderState | "error")[],
  pick: { canceled: true } | { canceled: false; path: string },
) {
  let call = 0;
  const checkFolder = vi.fn(async () => {
    const state = states[Math.min(call++, states.length - 1)];
    return state === "error"
      ? { ok: false as const, error: "Unknown project" }
      : { ok: true as const, path: PROJECT.path, state: state ?? "present" };
  });
  const pickFolder = vi.fn(async () => ({ ...pick, defaultName: "volli" }));
  const relink = vi.fn(async (input: { id: string; path: string }) => ({
    ok: true as const,
    project: { ...PROJECT, id: input.id, path: input.path },
    aftermath: {
      liveSessions: 0,
      worktrees: 0,
      worktreesRepaired: true,
      containerMoveNeeded: false,
      containerMoved: true,
    },
  }));
  Object.defineProperty(window, "api", {
    configurable: true,
    value: { projects: { checkFolder, pickFolder, relink } },
  });
  return { checkFolder, pickFolder, relink };
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  useProjectsStore.setState({ projects: [PROJECT], selectedProjectId: PROJECT.id });
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  useProjectsStore.setState({ projects: [], selectedProjectId: null });
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

async function renderBanner(): Promise<void> {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<ProjectFolderBanner projectId={PROJECT.id} />);
  });
}

function buttonLabelled(label: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll("button")].find((button) =>
    button.textContent?.includes(label),
  );
}

describe("ProjectFolderBanner", () => {
  it("stays out of the way while the folder is where the project says", async () => {
    stubApi(["present"], { canceled: true });
    await renderBanner();

    expect(container?.textContent).toBe("");
  });

  it("names the folder it cannot find and offers the one action that fixes it", async () => {
    stubApi(["missing"], { canceled: true });
    await renderBanner();

    expect(container?.textContent).toContain("This project's folder isn't where Volli left it.");
    // The path is the clue to where the person moved it, so it is on screen.
    expect(container?.textContent).toContain("/Users/me/volli");
    expect(buttonLabelled("Relink…")).toBeDefined();
  });

  // A path that now resolves to a FILE is the same recovery and a different
  // sentence: telling someone their folder is missing when they can see it
  // sitting there would send them looking for the wrong thing.
  it("says so when the registered path is a file rather than a folder", async () => {
    stubApi(["not-a-directory"], { canceled: true });
    await renderBanner();

    expect(container?.textContent).toContain("This project's path is a file, not a folder.");
    expect(buttonLabelled("Relink…")).toBeDefined();
  });

  // "We could not look" is not "it is not there". A failed check must not put a
  // fault on the board about a project that is probably fine.
  it("says nothing at all when the check could not run", async () => {
    stubApi(["error"], { canceled: true });
    await renderBanner();

    expect(container?.textContent).toBe("");
  });

  // The behaviour the whole ticket turns on: the chosen folder is saved onto
  // the SAME project id. Nothing here creates one.
  it("relinks the existing project to the folder chosen in the dialog", async () => {
    const api = stubApi(["missing"], { canceled: false, path: "/Users/me/code/volli" });
    await renderBanner();

    await act(async () => buttonLabelled("Relink…")?.click());
    await act(async () => buttonLabelled("Choose folder…")?.click());

    expect(api.relink).toHaveBeenCalledWith({ id: "p1", path: "/Users/me/code/volli" });
    expect(useProjectsStore.getState().projects).toEqual([
      { ...PROJECT, path: "/Users/me/code/volli" },
    ]);
  });

  // The banner has to GO, not merely ask again: the store replaces the row, the
  // path in the check's dependency list moves, the second look lands on the
  // folder that is now there, and the fault clears itself.
  it("clears itself once the relink has landed", async () => {
    const api = stubApi(["missing", "present"], { canceled: false, path: "/Users/me/code/volli" });
    await renderBanner();
    expect(container?.textContent).toContain("This project's folder isn't where Volli left it.");

    await act(async () => buttonLabelled("Relink…")?.click());
    await act(async () => buttonLabelled("Choose folder…")?.click());

    expect(api.checkFolder).toHaveBeenCalledTimes(2);
    expect(container?.textContent).toBe("");
  });

  // A folder is renamed in Finder or a terminal, which means it is renamed while
  // Volli is in the background. Without the look on the way back, the board a
  // person returns to is the one that still thinks everything is fine.
  it("looks again when the window comes back into focus", async () => {
    const api = stubApi(["present", "missing"], { canceled: true });
    await renderBanner();
    expect(container?.textContent).toBe("");

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });

    expect(api.checkFolder).toHaveBeenCalledTimes(2);
    expect(container?.textContent).toContain("This project's folder isn't where Volli left it.");
  });
});
