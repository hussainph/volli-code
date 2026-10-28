/**
 * "Choose the folder for <project> on this Mac" (VC-895 N2-3): the handler
 * map's `checkouts.*` port in a Volli Cloud launch.
 *
 * A cloud project's Sessions start from its checkout, and the checkout's path
 * lives only in this runner's local registry (`@volli/host-core`'s cloud
 * product store). A project this Mac has never seen has none, so a Session
 * start refuses with "Choose the folder for <project> on this Mac". This port
 * is that one recovery:
 *
 * 1. Volli Cloud confirms the project through the runner's own query: the
 *    signed-in owner is a member, and which repository is its primary one.
 *    Nothing is shown for a project the backend refuses.
 * 2. The system folder picker. Closing it changes nothing.
 * 3. The folder is checked here (an existing directory this app can write,
 *    never the disk root or the home folder itself). If it belongs to a
 *    different local project, a native confirmation explains that using it
 *    does not move that project's tickets or history.
 * 4. The folder is stored in the local registry for this runner only, and its
 *    path-free checkout metadata (branch, head) queued for Volli Cloud.
 *
 * No answer carries the path. With the `cloud` flag off, or in a launch that
 * is not a Volli Cloud one, every call answers unavailable.
 *
 * No Electron import: desktop main hands in the dialog ({@link folderPicker}).
 */
import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute } from "node:path";

import {
  OperationUnavailableError,
  type CloudCheckoutChoice,
  type CloudCheckoutStatus,
} from "@volli/shared";
import { readId } from "@volli/shared/cloud";
import type { CloudCheckoutPort } from "@volli/host-core/handlers";

/** The cloud product store's checkout members this port drives (structural). */
export interface CloudCheckoutStore {
  readonly checkouts: {
    located(projectId: string): boolean | null;
    site(projectId: string): Promise<{
      projectId: string;
      projectRepoId: string;
      projectName: string;
    }>;
    choose(input: { projectId: string; projectRepoId: string; absPath: string }): Promise<void>;
  };
}

/** Shows the folder picker; the chosen folder, or `null` when the person closed it. */
export type FolderPicker = (request: { title: string }) => Promise<string | null>;

/** The subset of Electron's `OpenDialogOptions` the picker sets. */
export interface FolderDialogOptions {
  title: string;
  message: string;
  buttonLabel: string;
  properties: "openDirectory"[];
}

/**
 * A {@link FolderPicker} over Electron's `dialog.showOpenDialog`, parented to
 * whatever window main passes. Only an existing folder can be picked: the
 * checkout is the project's own, not a new empty directory.
 */
export function folderPicker(
  showOpenDialog: (
    options: FolderDialogOptions,
  ) => Promise<{ canceled: boolean; filePaths: string[] }>,
): FolderPicker {
  return async ({ title }) => {
    const result = await showOpenDialog({
      title,
      message: title,
      buttonLabel: "Choose",
      properties: ["openDirectory"],
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  };
}

/** The native confirmation keeps local project names and paths off the wire. */
export function localProjectConfirmation(
  showMessageBox: (options: {
    type: "question";
    message: string;
    detail: string;
    buttons: string[];
    defaultId: number;
    cancelId: number;
    noLink: boolean;
  }) => Promise<{ response: number }>,
): (request: { localProjectName: string; cloudProjectName: string }) => Promise<boolean> {
  return async ({ localProjectName, cloudProjectName }) => {
    // TODO(VC-969): offer “Move to Volli Cloud” when the move flow is available.
    const { response } = await showMessageBox({
      type: "question",
      message: `This folder is already the local Volli project “${localProjectName}”.`,
      detail: `Using it for “${cloudProjectName}” will not move its local tickets or Session history to Volli Cloud. The two projects will share the folder, but keep separate histories.`,
      buttons: ["Cancel", "Use this folder anyway"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    return response === 1;
  };
}

export const CHECKOUTS_CLOUD_OFF = "Volli Cloud is off. Turn it on in Settings → Experimental.";
export const CHECKOUTS_NOT_CLOUD = "Project folders on this Mac belong to a Volli Cloud launch.";

/** The fs reads that check a picked folder; a test's to replace. */
export interface FolderChecks {
  realpath(path: string): Promise<string>;
  isDirectory(path: string): Promise<boolean>;
  writable(path: string): Promise<boolean>;
  home(): string;
}

const NODE_CHECKS: FolderChecks = {
  realpath: (path) => realpath(path),
  isDirectory: async (path) => (await stat(path)).isDirectory(),
  writable: (path) =>
    access(path, constants.R_OK | constants.W_OK).then(
      () => true,
      () => false,
    ),
  home: homedir,
};

/** The picked folder, canonical, or a sentence saying why it cannot be the checkout. */
export async function checkFolder(path: string, checks: FolderChecks = NODE_CHECKS) {
  if (!isAbsolute(path)) throw new Error("Choose a folder on this Mac.");
  let canonical: string;
  try {
    canonical = await checks.realpath(path);
  } catch {
    throw new Error("That folder no longer exists. Choose another.");
  }
  if (!(await checks.isDirectory(canonical))) throw new Error("Choose a folder, not a file.");
  if (dirname(canonical) === canonical)
    throw new Error("Choose the project's own folder, not the whole disk.");
  const home = await checks.realpath(checks.home()).catch(() => checks.home());
  if (canonical === home) throw new Error("Choose the project's own folder, not your home folder.");
  if (!(await checks.writable(canonical)))
    throw new Error("Volli can't write to that folder. Choose another.");
  return canonical;
}

/**
 * The `checkouts.*` port. `store` is the cloud product store, `null` in a
 * launch that is not a Volli Cloud one; `enabled` reads the `cloud` flag now.
 */
export function createCloudCheckoutPort(options: {
  enabled(): boolean;
  store: CloudCheckoutStore | null;
  pickFolder: FolderPicker;
  /** Visible local projects only, never cloud shadow identities. */
  localProjects(): readonly { id: string; name: string; path: string }[];
  confirmLocalProject(request: {
    localProjectName: string;
    cloudProjectName: string;
  }): Promise<boolean>;
  checks?: FolderChecks;
}): CloudCheckoutPort {
  const { store, pickFolder } = options;
  const checkouts = (projectId: string): CloudCheckoutStore["checkouts"] => {
    if (!options.enabled()) throw new OperationUnavailableError(CHECKOUTS_CLOUD_OFF);
    if (store === null) throw new OperationUnavailableError(CHECKOUTS_NOT_CLOUD);
    if (readId("project", projectId) === null) throw new Error("That isn't a Volli Cloud project.");
    return store.checkouts;
  };
  // One picker at a time: a second ask for the same project joins it.
  let picking: { projectId: string; choice: Promise<CloudCheckoutChoice> } | null = null;

  async function choose(projectId: string): Promise<CloudCheckoutChoice> {
    const cloud = checkouts(projectId);
    const site = await cloud.site(projectId);
    const picked = await pickFolder({ title: `Choose the folder for ${site.projectName}` });
    if (picked === null) return { outcome: "cancelled" };
    const checks = options.checks ?? NODE_CHECKS;
    const folder = await checkFolder(picked, checks);
    for (const project of options.localProjects()) {
      if (project.id === site.projectId) continue;
      const localPath = await checks.realpath(project.path).catch(() => project.path);
      if (localPath !== folder) continue;
      const confirmed = await options.confirmLocalProject({
        localProjectName: project.name,
        cloudProjectName: site.projectName,
      });
      if (!confirmed) return { outcome: "cancelled" };
      break;
    }
    // Registered under the project and repository Volli Cloud answered for.
    await cloud.choose({
      projectId: site.projectId,
      projectRepoId: site.projectRepoId,
      absPath: folder,
    });
    return { outcome: "chosen", projectRepoId: site.projectRepoId };
  }

  return {
    status(projectId): CloudCheckoutStatus {
      const located = checkouts(projectId).located(projectId);
      return { state: located === null ? "no_runner" : located ? "located" : "missing" };
    },
    chooseFolder(projectId) {
      checkouts(projectId);
      if (picking !== null) {
        if (picking.projectId === projectId) return picking.choice;
        throw new Error("Another folder picker is already open.");
      }
      const choice = choose(projectId).finally(() => {
        picking = null;
      });
      picking = { projectId, choice };
      return choice;
    },
  };
}
