// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MotionGlobalConfig } from "motion/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { suggestGlyphs, type Project } from "@volli/shared";
import type { ProjectCreateInput, ProjectCreateResult } from "../../../../ipc/contract";

import { toastError } from "@renderer/lib/toast";
import { useBoardStore } from "@renderer/stores/board";
import { useProjectsStore } from "@renderer/stores/projects";
import { useThemeStore } from "@renderer/stores/theme";
import { NewProjectDialog } from "./new-project-dialog";

vi.mock("@renderer/lib/toast", () => ({ toastError: vi.fn() }));

const initialProjects = useProjectsStore.getState();
const initialBoard = useBoardStore.getState();
const initialTheme = useThemeStore.getState();
const createProject = vi.fn<(input: ProjectCreateInput) => Promise<ProjectCreateResult>>();
const draft = { seed: "first-folder", path: "/work/moonshot", defaultName: "Moonshot" };
const existing: Project = {
  id: "existing",
  path: "/work/existing",
  name: "Existing",
  ticketPrefix: "EX",
  colorIndex: 0,
  sortOrder: 0,
  createdAt: 0,
  updatedAt: 0,
  workspaceIdentity: {
    choice: { kind: "glyph", name: "code" },
    surface: "etched",
    monogramStyle: "editorial",
  },
};
let host: HTMLDivElement;
let root: Root;
let finishCreate: ((result: ProjectCreateResult) => void) | undefined;

beforeEach(async () => {
  vi.clearAllMocks();
  finishCreate = undefined;
  createProject.mockResolvedValue({ ok: false, error: "disk unavailable" });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: false,
      media: query,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
    })),
  );
  vi.stubGlobal("api", {
    projects: { create: createProject },
    appState: { set: vi.fn().mockResolvedValue({ ok: true }) },
  });
  // Project selection paints the real app; that side effect is outside this dialog's seam.
  vi.spyOn(useThemeStore.getState(), "hydrate").mockResolvedValue(undefined);
  MotionGlobalConfig.skipAnimations = true;
  useProjectsStore.setState({
    ...initialProjects,
    projects: [existing],
    selectedProjectId: null,
    folderClaim: null,
    newProjectDraft: draft,
    creatingProject: false,
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<NewProjectDialog />));
});

afterEach(async () => {
  await act(async () => {
    finishCreate?.({ ok: false, error: "test cleanup" });
    await Promise.resolve();
    root.unmount();
  });
  host.remove();
  useProjectsStore.setState(initialProjects);
  useBoardStore.setState(initialBoard);
  useThemeStore.setState(initialTheme);
  MotionGlobalConfig.skipAnimations = false;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function nameInput(): HTMLInputElement {
  return document.querySelector<HTMLInputElement>('[aria-label="Project name"]')!;
}
function hero(): HTMLElement {
  return document.querySelector<HTMLElement>('.studio-mark[data-size="hero"]')!;
}
function button(label: string): HTMLButtonElement {
  const node = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) =>
      candidate.getAttribute("aria-label") === label || candidate.textContent?.trim() === label,
  );
  if (!node) throw new Error(`Missing button ${label}`);
  return node;
}
async function click(label: string) {
  await act(async () => button(label).click());
}
async function rename(value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      nameInput(),
      value,
    );
    nameInput().dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function escape() {
  await act(async () =>
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
  );
}

describe("NewProjectDialog integration", () => {
  it("shows the actual picked draft, deprioritizes used glyphs and cancels without creation", async () => {
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(draft.path);
    expect(nameInput().value).toBe(draft.defaultName);
    expect(hero().dataset.glyph).toBe(suggestGlyphs(draft.defaultName, ["code"])[0]);
    expect(
      [...document.querySelectorAll('[aria-label="Suggested glyphs"] button')].map((node) =>
        node.getAttribute("aria-label"),
      ),
    ).not.toContain("Choose suggested Code");
    expect(createProject).not.toHaveBeenCalled();
    await click("Cancel");
    expect(useProjectsStore.getState().newProjectDraft).toBeNull();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(createProject).not.toHaveBeenCalled();
  });

  it("keys the editor by draft seed: same draft preserves edits, a new folder resets them", async () => {
    await rename("My signature");
    await click("Stamp");
    await click("Another stamp");
    await click("Orchard");
    await act(async () =>
      useProjectsStore.setState({ newProjectDraft: { ...draft, defaultName: "Changed default" } }),
    );
    expect(nameInput().value).toBe("My signature");
    expect(hero().dataset.stampVariant).toBe("1");
    await act(async () =>
      useProjectsStore.setState({
        newProjectDraft: { seed: "second-folder", path: "/work/paper", defaultName: "Paper Trail" },
      }),
    );
    expect(nameInput().value).toBe("Paper Trail");
    expect(document.querySelector(".studio-folder-path")?.textContent).toBe("/work/paper");
    expect(hero().dataset.identityKind).toBe("glyph");
    expect(button("Inherited").getAttribute("aria-pressed")).toBe("true");
    await click("Stamp");
    expect(hero().dataset.stampVariant).toBe("0");
    expect(createProject).not.toHaveBeenCalled();
  });

  it("keeps busy creation non-dismissable, retains editor choices on store failure and retries the same payload", async () => {
    createProject.mockReturnValueOnce(
      new Promise((resolve) => {
        finishCreate = resolve;
      }),
    );
    await rename("  Paper Trail  ");
    await click("Stamp");
    await click("Another stamp");
    await click("Make it mine");
    expect(createProject).toHaveBeenCalledOnce();
    expect(useProjectsStore.getState().creatingProject).toBe(true);
    expect(button("Creating workspace…").disabled).toBe(true);
    expect(button("Cancel").disabled).toBe(true);
    expect(
      [...document.querySelectorAll("button")].some((node) => node.textContent === "Close"),
    ).toBe(false);
    await click("Creating workspace…");
    await click("Cancel");
    await escape();
    expect(useProjectsStore.getState().newProjectDraft).toEqual(draft);
    expect(createProject).toHaveBeenCalledOnce();
    await act(async () => finishCreate!({ ok: false, error: "disk unavailable" }));
    expect(toastError).toHaveBeenCalledExactlyOnceWith("Couldn't add project: disk unavailable");
    expect(useProjectsStore.getState().creatingProject).toBe(false);
    expect(useProjectsStore.getState().newProjectDraft).toEqual(draft);
    expect(nameInput().value).toBe("  Paper Trail  ");
    expect(hero().dataset.stampVariant).toBe("1");
    const payload = {
      path: draft.path,
      name: "Paper Trail",
      workspaceIdentity: {
        choice: { kind: "stamp", seed: draft.seed, variant: 1 },
        surface: "etched",
        monogramStyle: "editorial",
      },
      themeCanvas: null,
    } as const;
    expect(createProject).toHaveBeenLastCalledWith(payload);
    createProject.mockResolvedValueOnce({
      ok: true,
      created: true,
      project: { ...existing, ...payload, id: "created" },
    });
    await click("Make it mine");
    expect(createProject).toHaveBeenCalledTimes(2);
    expect(createProject).toHaveBeenLastCalledWith(payload);
    expect(useProjectsStore.getState().newProjectDraft).toBeNull();
    expect(useProjectsStore.getState().selectedProjectId).toBe("created");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});
