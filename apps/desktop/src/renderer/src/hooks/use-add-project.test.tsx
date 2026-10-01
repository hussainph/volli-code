// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { PickFolderResult } from "../../../ipc/contract";

import { toastError } from "@renderer/lib/toast";
import { useProjectsStore } from "@renderer/stores/projects";
import { useAddProject } from "./use-add-project";

vi.mock("@renderer/lib/toast", () => ({ toastError: vi.fn() }));

const initialProjects = useProjectsStore.getState();
const pickFolder = vi.fn<() => Promise<PickFolderResult>>();
const addProject = vi.fn<typeof initialProjects.addProject>();
const createProject = vi.fn();
const selectedFolder = {
  canceled: false,
  path: "/work/paper",
  defaultName: "Paper Trail",
} as const;
let host: HTMLDivElement;
let root: Root;
let pending: Promise<void>[];
let release: (() => void)[];

/** Every controlled promise is settled during cleanup, releasing the module-wide picker guard. */
function deferred<T>(fallback: T) {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  release.push(() => resolve(fallback));
  return { promise, resolve, reject };
}
function Door({ label }: { label: string }) {
  const add = useAddProject();
  return (
    <button
      onClick={() => {
        pending.push(add());
      }}
    >
      {label}
    </button>
  );
}
function start(label = "Rail plus"): Promise<void> {
  const node = [...host.querySelectorAll("button")].find((button) => button.textContent === label)!;
  act(() => node.click());
  return pending.at(-1)!;
}
async function settle(promise: Promise<void>) {
  await act(async () => promise);
}

beforeEach(() => {
  vi.clearAllMocks();
  pickFolder.mockResolvedValue({ canceled: true });
  addProject.mockResolvedValue(false);
  pending = [];
  release = [];
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("api", { projects: { pickFolder, create: createProject } });
  useProjectsStore.setState({
    ...initialProjects,
    projects: [],
    selectedProjectId: null,
    newProjectDraft: null,
    folderClaim: null,
    creatingProject: false,
    addProject,
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root.render(
      <>
        <Door label="Rail plus" />
        <Door label="Empty sidebar" />
      </>,
    ),
  );
});

afterEach(async () => {
  await act(async () => {
    for (const resolve of release) resolve();
    await Promise.allSettled(pending);
    root.unmount();
  });
  host.remove();
  useProjectsStore.setState(initialProjects);
  vi.unstubAllGlobals();
});

describe("useAddProject shared native-picker doors", () => {
  it("does nothing on native cancellation", async () => {
    await settle(start());
    expect(pickFolder).toHaveBeenCalledOnce();
    expect(addProject).not.toHaveBeenCalled();
    expect(createProject).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
  });

  it.each(["Rail plus", "Empty sidebar"])(
    "hands the picked folder from %s to store adjudication with onboarding enabled",
    async (door) => {
      pickFolder.mockResolvedValue(selectedFolder);
      await settle(start(door));
      expect(addProject).toHaveBeenCalledExactlyOnceWith({
        path: selectedFolder.path,
        defaultName: selectedFolder.defaultName,
        onboard: true,
      });
      expect(createProject).not.toHaveBeenCalled();
      expect(toastError).not.toHaveBeenCalled();
    },
  );

  it("actually opens a new-folder identity draft, not a project, through the real store action", async () => {
    act(() => useProjectsStore.setState({ addProject: initialProjects.addProject }));
    pickFolder.mockResolvedValue(selectedFolder);
    await settle(start());
    expect(useProjectsStore.getState().newProjectDraft).toEqual({
      path: selectedFolder.path,
      defaultName: selectedFolder.defaultName,
      seed: expect.any(String),
    });
    expect(useProjectsStore.getState().projects).toEqual([]);
    expect(useProjectsStore.getState().selectedProjectId).toBeNull();
    expect(createProject).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
  });

  it("toasts native-picker failures and releases the shared guard for retry", async () => {
    pickFolder.mockRejectedValueOnce(new Error("native picker unavailable"));
    await settle(start());
    expect(toastError).toHaveBeenCalledExactlyOnceWith(
      "Couldn't open folder picker: native picker unavailable",
    );
    expect(addProject).not.toHaveBeenCalled();
    await settle(start("Empty sidebar"));
    expect(pickFolder).toHaveBeenCalledTimes(2);
  });

  it("toasts rejected adjudication and releases the shared guard", async () => {
    pickFolder.mockResolvedValue(selectedFolder);
    addProject.mockRejectedValueOnce(new Error("folder inspection failed"));
    await settle(start());
    expect(toastError).toHaveBeenCalledExactlyOnceWith(
      "Couldn't open folder picker: folder inspection failed",
    );
    await settle(start("Empty sidebar"));
    expect(pickFolder).toHaveBeenCalledTimes(2);
    expect(addProject).toHaveBeenCalledTimes(2);
  });

  it("allows only one native picker across both instances and repeated activation", async () => {
    const picker = deferred<PickFolderResult>({ canceled: true });
    pickFolder.mockReturnValueOnce(picker.promise);
    const first = start();
    await settle(start("Empty sidebar"));
    await settle(start());
    expect(pickFolder).toHaveBeenCalledOnce();
    expect(addProject).not.toHaveBeenCalled();
    picker.resolve({ canceled: true });
    await settle(first);
    await settle(start("Empty sidebar"));
    expect(pickFolder).toHaveBeenCalledTimes(2);
  });

  it("holds the guard through async store adjudication, then respects the resulting draft", async () => {
    const adjudication = deferred(false);
    pickFolder.mockResolvedValue(selectedFolder);
    addProject.mockReturnValueOnce(adjudication.promise);
    const first = start();
    await act(async () => {
      await Promise.resolve();
    });
    expect(addProject).toHaveBeenCalledOnce();
    await settle(start("Empty sidebar"));
    expect(pickFolder).toHaveBeenCalledOnce();
    act(() => useProjectsStore.setState({ newProjectDraft: { ...selectedFolder, seed: "draft" } }));
    adjudication.resolve(false);
    await settle(first);
    await settle(start("Empty sidebar"));
    expect(pickFolder).toHaveBeenCalledOnce();
    act(() => useProjectsStore.getState().dismissNewProject());
    await settle(start("Empty sidebar"));
    expect(pickFolder).toHaveBeenCalledTimes(2);
  });

  it.each(["draft", "claim"] as const)(
    "does not reopen the native picker while a %s is present, including state changed after mount",
    async (kind) => {
      act(() =>
        useProjectsStore.setState(
          kind === "draft"
            ? {
                newProjectDraft: {
                  seed: "draft",
                  path: selectedFolder.path,
                  defaultName: selectedFolder.defaultName,
                },
              }
            : {
                folderClaim: {
                  path: selectedFolder.path,
                  defaultName: selectedFolder.defaultName,
                  candidates: [],
                  onboard: true,
                },
              },
        ),
      );
      await settle(start());
      await settle(start("Empty sidebar"));
      expect(pickFolder).not.toHaveBeenCalled();
      expect(addProject).not.toHaveBeenCalled();
      act(() => useProjectsStore.setState({ newProjectDraft: null, folderClaim: null }));
      await settle(start());
      expect(pickFolder).toHaveBeenCalledOnce();
    },
  );

  it("holds a pending pick even if the launching instance unmounts", async () => {
    const picker = deferred<PickFolderResult>({ canceled: true });
    pickFolder.mockReturnValueOnce(picker.promise);
    const first = start();
    act(() => root.render(<Door label="Empty sidebar" />));
    await settle(start("Empty sidebar"));
    expect(pickFolder).toHaveBeenCalledOnce();
    picker.resolve(selectedFolder);
    await settle(first);
    expect(addProject).toHaveBeenCalledOnce();
  });
});
