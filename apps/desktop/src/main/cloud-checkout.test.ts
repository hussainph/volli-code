import { describe, expect, it, vi } from "vite-plus/test";

import { OperationUnavailableError } from "@volli/shared";

import {
  CHECKOUTS_CLOUD_OFF,
  CHECKOUTS_NOT_CLOUD,
  checkFolder,
  createCloudCheckoutPort,
  folderPicker,
  localProjectConfirmation,
  type CloudCheckoutStore,
  type FolderChecks,
} from "./cloud-checkout";

const PROJECT = "00000000-0000-4000-8000-0000000000b1";
const REPO = "00000000-0000-4000-8000-0000000000b2";

/** A Mac whose folders are `/Users/dana` (home), its `code/app` and a file. */
const checks = (patch: Partial<FolderChecks> = {}): FolderChecks => ({
  realpath: async (path) => {
    if (path.includes("gone")) throw new Error("ENOENT");
    return path.replace("/linked", "/Users/dana/code/app");
  },
  isDirectory: async (path) => !path.endsWith(".txt"),
  writable: async (path) => !path.includes("locked"),
  home: () => "/Users/dana",
  ...patch,
});

function store(located: boolean | null = false) {
  return {
    checkouts: {
      located: vi.fn((_projectId: string) => located),
      site: vi.fn(async (projectId: string) => ({
        projectId,
        projectRepoId: REPO,
        projectName: "Volli",
      })),
      choose: vi.fn(async () => {}),
    },
  } satisfies CloudCheckoutStore;
}

const localProjectOptions = {
  localProjects: () => [] as { id: string; name: string; path: string }[],
  confirmLocalProject: async () => false,
};

describe("the checkouts port's gates", () => {
  it("refuses with the flag off and outside a Volli Cloud launch, before touching anything", async () => {
    const cloud = store();
    const pickFolder = vi.fn(async () => "/Users/dana/code/app");
    let enabled = false;
    const off = createCloudCheckoutPort({
      ...localProjectOptions,
      enabled: () => enabled,
      store: cloud,
      pickFolder,
    });
    expect(() => off.status(PROJECT)).toThrow(new OperationUnavailableError(CHECKOUTS_CLOUD_OFF));
    expect(() => off.chooseFolder(PROJECT)).toThrow(OperationUnavailableError);
    enabled = true;
    const local = createCloudCheckoutPort({
      ...localProjectOptions,
      enabled: () => true,
      store: null,
      pickFolder,
    });
    expect(() => local.status(PROJECT)).toThrow(CHECKOUTS_NOT_CLOUD);
    expect(() => local.chooseFolder(PROJECT)).toThrow(CHECKOUTS_NOT_CLOUD);
    expect(cloud.checkouts.located).not.toHaveBeenCalled();
    expect(cloud.checkouts.site).not.toHaveBeenCalled();
    expect(pickFolder).not.toHaveBeenCalled();
  });

  it("refuses an id that is not a Volli Cloud project id", () => {
    const port = createCloudCheckoutPort({
      ...localProjectOptions,
      enabled: () => true,
      store: store(),
      pickFolder: async () => null,
    });
    expect(() => port.status("not-an-id")).toThrow("That isn't a Volli Cloud project.");
    expect(() => port.chooseFolder("../etc")).toThrow("That isn't a Volli Cloud project.");
  });
});

describe("checkouts.status", () => {
  it("answers located, missing, or no runner, never a path", () => {
    for (const [located, state] of [
      [true, "located"],
      [false, "missing"],
      [null, "no_runner"],
    ] as const) {
      const cloud = store(located);
      const port = createCloudCheckoutPort({
        ...localProjectOptions,
        enabled: () => true,
        store: cloud,
        pickFolder: async () => null,
      });
      expect(port.status(PROJECT)).toEqual({ state });
      expect(cloud.checkouts.located).toHaveBeenCalledWith(PROJECT);
    }
  });
});

describe("checkouts.chooseFolder", () => {
  it("checks the project with Volli Cloud, then registers the canonical folder", async () => {
    const cloud = store();
    const pickFolder = vi.fn(async () => "/linked");
    const port = createCloudCheckoutPort({
      ...localProjectOptions,
      enabled: () => true,
      store: cloud,
      pickFolder,
      checks: checks(),
    });
    expect(await port.chooseFolder(PROJECT)).toEqual({ outcome: "chosen", projectRepoId: REPO });
    expect(cloud.checkouts.site).toHaveBeenCalledWith(PROJECT);
    expect(pickFolder).toHaveBeenCalledWith({ title: "Choose the folder for Volli" });
    expect(cloud.checkouts.choose).toHaveBeenCalledWith({
      projectId: PROJECT,
      projectRepoId: REPO,
      absPath: "/Users/dana/code/app",
    });
  });

  it.each([false, true])(
    "requires confirmation before sharing a local project's folder (confirmed: %s)",
    async (confirmed) => {
      const cloud = store();
      const confirmLocalProject = vi.fn(async () => confirmed);
      const port = createCloudCheckoutPort({
        ...localProjectOptions,
        enabled: () => true,
        store: cloud,
        pickFolder: async () => "/Users/dana/code/app",
        localProjects: () => [{ id: "local", name: "Local app", path: "/linked" }],
        confirmLocalProject,
        checks: checks(),
      });
      expect(await port.chooseFolder(PROJECT)).toEqual(
        confirmed ? { outcome: "chosen", projectRepoId: REPO } : { outcome: "cancelled" },
      );
      expect(confirmLocalProject).toHaveBeenCalledWith({
        localProjectName: "Local app",
        cloudProjectName: "Volli",
      });
      expect(cloud.checkouts.choose).toHaveBeenCalledTimes(confirmed ? 1 : 0);
    },
  );

  it("keeps the picker busy until the local-project confirmation is answered", async () => {
    const cloud = store();
    let answer!: (confirmed: boolean) => void;
    const confirmLocalProject = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          answer = resolve;
        }),
    );
    const port = createCloudCheckoutPort({
      ...localProjectOptions,
      enabled: () => true,
      store: cloud,
      pickFolder: async () => "/linked",
      localProjects: () => [{ id: "local", name: "Local app", path: "/Users/dana/code/app" }],
      confirmLocalProject,
      checks: checks(),
    });
    const pending = port.chooseFolder(PROJECT);
    await vi.waitFor(() => expect(confirmLocalProject).toHaveBeenCalledOnce());
    expect(cloud.checkouts.choose).not.toHaveBeenCalled();
    expect(port.chooseFolder(PROJECT)).toBe(pending);
    expect(() => port.chooseFolder(REPO)).toThrow("Another folder picker is already open.");
    answer(true);
    expect(await pending).toEqual({ outcome: "chosen", projectRepoId: REPO });
  });

  it("does not warn for an unrelated local folder or the same adopted project", async () => {
    const confirmLocalProject = vi.fn(async () => false);
    const port = createCloudCheckoutPort({
      ...localProjectOptions,
      enabled: () => true,
      store: store(),
      pickFolder: async () => "/linked",
      localProjects: () => [
        { id: "other", name: "Missing", path: "/gone" },
        { id: PROJECT, name: "Moved app", path: "/Users/dana/code/app" },
      ],
      confirmLocalProject,
      checks: checks(),
    });
    expect(await port.chooseFolder(PROJECT)).toEqual({ outcome: "chosen", projectRepoId: REPO });
    expect(confirmLocalProject).not.toHaveBeenCalled();
  });

  it("surfaces a failed confirmation and leaves the folder unlinked", async () => {
    const cloud = store();
    const port = createCloudCheckoutPort({
      ...localProjectOptions,
      enabled: () => true,
      store: cloud,
      pickFolder: async () => "/linked",
      localProjects: () => [{ id: "local", name: "Local app", path: "/linked" }],
      confirmLocalProject: async () => {
        throw new Error("Dialog unavailable");
      },
      checks: checks(),
    });
    await expect(port.chooseFolder(PROJECT)).rejects.toThrow("Dialog unavailable");
    expect(cloud.checkouts.choose).not.toHaveBeenCalled();
  });

  it("changes nothing when the person closes the picker", async () => {
    const cloud = store();
    const port = createCloudCheckoutPort({
      ...localProjectOptions,
      enabled: () => true,
      store: cloud,
      pickFolder: async () => null,
      checks: checks(),
    });
    expect(await port.chooseFolder(PROJECT)).toEqual({ outcome: "cancelled" });
    expect(cloud.checkouts.choose).not.toHaveBeenCalled();
  });

  it("shows no picker for a project Volli Cloud refuses", async () => {
    const cloud = store();
    cloud.checkouts.site.mockRejectedValueOnce(new Error("That project does not exist."));
    const pickFolder = vi.fn(async () => "/Users/dana/code/app");
    const port = createCloudCheckoutPort({
      ...localProjectOptions,
      enabled: () => true,
      store: cloud,
      pickFolder,
    });
    await expect(port.chooseFolder(PROJECT)).rejects.toThrow("That project does not exist.");
    expect(pickFolder).not.toHaveBeenCalled();
    expect(cloud.checkouts.choose).not.toHaveBeenCalled();
  });

  it("registers nothing for a folder that cannot be the checkout", async () => {
    for (const picked of ["/gone", "/Users/dana/notes.txt", "/Users/dana/locked"]) {
      const cloud = store();
      const port = createCloudCheckoutPort({
        ...localProjectOptions,
        enabled: () => true,
        store: cloud,
        pickFolder: async () => picked,
        checks: checks(),
      });
      await expect(port.chooseFolder(PROJECT)).rejects.toThrow(/Choose/);
      expect(cloud.checkouts.choose).not.toHaveBeenCalled();
    }
  });

  it("opens one picker at a time: the same project joins it, another is refused", async () => {
    const cloud = store();
    let answer!: (path: string | null) => void;
    const pickFolder = vi.fn(
      () =>
        new Promise<string | null>((resolve) => {
          answer = resolve;
        }),
    );
    const port = createCloudCheckoutPort({
      ...localProjectOptions,
      enabled: () => true,
      store: cloud,
      pickFolder,
      checks: checks(),
    });
    const first = port.chooseFolder(PROJECT);
    const second = port.chooseFolder(PROJECT);
    expect(second).toBe(first);
    expect(() => port.chooseFolder(REPO)).toThrow("Another folder picker is already open.");
    await vi.waitFor(() => expect(pickFolder).toHaveBeenCalledOnce());
    answer(null);
    expect(await first).toEqual({ outcome: "cancelled" });
    // Settled: the next ask opens a fresh picker.
    const third = port.chooseFolder(REPO);
    await vi.waitFor(() => expect(pickFolder).toHaveBeenCalledTimes(2));
    answer("/Users/dana/code/app");
    expect(await third).toEqual({ outcome: "chosen", projectRepoId: REPO });
  });
});

describe("checkFolder", () => {
  it("answers the canonical folder", async () => {
    expect(await checkFolder("/linked", checks())).toBe("/Users/dana/code/app");
  });

  it("refuses a relative path, a missing folder, a file, the disk, home, and a read-only folder", async () => {
    await expect(checkFolder("code/app", checks())).rejects.toThrow("Choose a folder on this Mac.");
    await expect(checkFolder("/gone", checks())).rejects.toThrow("no longer exists");
    await expect(checkFolder("/a.txt", checks())).rejects.toThrow("not a file");
    await expect(checkFolder("/", checks())).rejects.toThrow("not the whole disk");
    await expect(checkFolder("/Users/dana", checks())).rejects.toThrow("not your home folder");
    await expect(checkFolder("/Users/dana/locked", checks())).rejects.toThrow("can't write");
  });

  it("compares with home as written when home itself cannot be resolved", async () => {
    const homeless = checks({
      realpath: async (path) => {
        if (path === "/Users/gone") throw new Error("ENOENT");
        return path;
      },
      home: () => "/Users/gone",
    });
    expect(await checkFolder("/Users/dana", homeless)).toBe("/Users/dana");
  });
});

describe("localProjectConfirmation", () => {
  it("explains that histories stay separate, defaults to cancel, and requires explicit consent", async () => {
    const show = vi.fn(async () => ({ response: 0 }));
    const confirm = localProjectConfirmation(show);
    const request = { localProjectName: "Local app", cloudProjectName: "Cloud app" };
    expect(await confirm(request)).toBe(false);
    expect(show).toHaveBeenCalledWith({
      type: "question",
      message: "This folder is already the local Volli project “Local app”.",
      detail:
        "Using it for “Cloud app” will not move its local tickets or Session history to Volli Cloud. The two projects will share the folder, but keep separate histories.",
      buttons: ["Cancel", "Use this folder anyway"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    show.mockResolvedValueOnce({ response: 1 });
    expect(await confirm(request)).toBe(true);
  });
});

describe("folderPicker", () => {
  it("asks for one existing folder, and answers null when closed", async () => {
    const show = vi.fn(async () => ({ canceled: false, filePaths: ["/Users/dana/code/app"] }));
    expect(await folderPicker(show)({ title: "Choose the folder for Volli" })).toBe(
      "/Users/dana/code/app",
    );
    expect(show).toHaveBeenCalledWith({
      title: "Choose the folder for Volli",
      message: "Choose the folder for Volli",
      buttonLabel: "Choose",
      properties: ["openDirectory"],
    });
    show.mockResolvedValueOnce({ canceled: true, filePaths: [] });
    expect(await folderPicker(show)({ title: "t" })).toBeNull();
    show.mockResolvedValueOnce({ canceled: false, filePaths: [] });
    expect(await folderPicker(show)({ title: "t" })).toBeNull();
  });
});
