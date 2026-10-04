/** Desktop IPC door for the host file services. */
import { basename, dirname } from "node:path";
import type { WebContents } from "electron";
import { clientEventSink } from "./client-event-sink";
import { applySkillModes, errorMessage, projectCommandsDir, projectSkillsDir } from "@volli/shared";
import { FILE_CHANNELS, FILE_IPC } from "./ipc-descriptors";
import { searchFiles } from "@volli/host-core/file-search";
import { systemExternalAppGateway } from "./external-apps";
import type { ExternalAppGateway } from "./external-apps";
import type {
  ArtifactCreateInput,
  ArtifactCreateResult,
  DirPathInput,
  ExternalAppListResult,
  ExternalAppOpenFileInput,
  ExternalAppOpenWorktreeInput,
  FileIndexInput,
  FileIndexResult,
  FileIpcChannel,
  FileMutationResult,
  FilePathInput,
  FileReadResult,
  FileRenameInput,
  FileSearchInput,
  FileSearchResult,
  FileWriteInput,
  FileWriteResult,
  PromptTemplateCreateInput,
  PromptTemplateCreateResult,
  PromptTemplateIndexInput,
  PromptTemplateIndexResult,
  Result,
  RevealResult,
  WorktreeRevealInput,
} from "../ipc/contract";
import type { DbHandle } from "./data-ipc";
import { getProjectById } from "@volli/host-core/db/projects-repo";
import { registerDegradedIpcHandlers, registerGuardedIpcHandlers } from "./ipc-registry";
import type { IpcHandlerTable } from "./ipc-registry";
import { loadPromptTemplates, writePromptTemplate } from "@volli/host-core/prompt-templates";
import { loadSkills } from "@volli/host-core/skills";

import {
  buildFileIndex,
  readFile,
  writeFile,
  createFile,
  createDirectory,
  renameEntry,
  duplicateFile,
  createArtifact,
  resolveSafePath,
  resolveSafeDir,
  resolveProjectPath,
  resolveFileScope,
  resolveExternalFileTarget,
  resolveLiveWorktree,
  searchRoot,
  FileWatchManager,
  DirWatchManager,
} from "@volli/host-core/volli-fs";
import type { HostFileServices } from "@volli/host-core/file-services";
/** The live watch managers `registerFileIpcHandlers` owns — one per watch surface. */
export interface FileIpcWatchManagers {
  files: FileWatchManager;
  dirs: DirWatchManager;
}

/** What this surface needs that the db cannot tell it. */
export interface FileIpcOptions {
  /**
   * `<userData>/commands` — the global tier of the composer's `/` picker.
   * Injected rather than resolved here because `index.ts` is the one module
   * that may call `app.getPath("userData")`.
   */
  globalCommandsDir: string;
  /**
   * `<home>/.agents/skills` — the personal tier of the `/` picker's skills,
   * injected for `globalCommandsDir`'s reason: the home directory is resolved
   * once, in `index.ts`, and handed down rather than read here.
   */
  globalSkillsDir: string;
  /** Native app detection/launch, injectable so the IPC boundary stays testable without macOS. */
  externalApps?: ExternalAppGateway;
}

/**
 * Registers every file, directory, artifact, and external-app handler through
 * the shared guard→body→envelope registry (issue #98): `FILE_IPC` (@volli/shared)
 * supplies the descriptor table (validators + invalid-request messages) and
 * `registerGuardedIpcHandlers` applies guard → body → try/catch; this module
 * supplies only the handler bodies below. When the db failed to open, every
 * channel instead resolves with a typed `{ ok: false, error }`
 * (`registerDegradedIpcHandlers(FILE_CHANNELS, …)`) — same degraded-DB stance
 * as `registerDataIpcHandlers`. Returns both watch managers; watchers are
 * otherwise self-cleaning on window `destroyed`/explicit unwatch.
 */
export function registerFileIpcHandlers(
  handle: DbHandle,
  options: FileIpcOptions,
  services: HostFileServices,
): FileIpcWatchManagers {
  const manager = services.files;
  const dirManager = services.dirs;

  if (!handle.ok) {
    registerDegradedIpcHandlers(FILE_CHANNELS, handle.error);
    return { files: manager, dirs: dirManager };
  }

  const db = handle.db;
  const externalApps = options.externalApps ?? systemExternalAppGateway;

  const handlers: IpcHandlerTable<FileIpcChannel> = {
    // Scope follows the surface that asked (VC-190): Home hands no ticketId and
    // gets Main; a Ticket workspace hands its own and gets that worktree —
    // through `resolveFileScope`, the same seam `volli:file-read` resolves
    // through, so quick-open can never offer a row the read then answers from
    // the other checkout.
    "volli:file-index": async (input: FileIndexInput): Promise<FileIndexResult> => {
      const scope = await resolveFileScope(db, input.projectId, input.ticketId);
      if (!scope.ok) return scope;
      const { files, truncated } = await buildFileIndex(scope.value.projectPath, {
        worktreeRoot: scope.value.worktreeRoot,
      });
      return { ok: true, files, truncated };
    },

    "volli:file-read": async (input: FilePathInput): Promise<FileReadResult> => {
      const scope = await resolveFileScope(db, input.projectId, input.ticketId);
      if (!scope.ok) return scope;
      return await readFile(scope.value.projectPath, scope.value.worktreeRoot, input.relPath);
    },

    // Find across files (plan §4.7), scoped by the SAME seam as the read above
    // — so the checkout that answered the search is the checkout the click on a
    // result reads from. `searchRoot` is the one difference: a search has no
    // relPath to route on, so `.volli/**`'s always-Main rule has nothing to
    // apply to, and a ticket searches its worktree whole (falling back to Main
    // when that worktree is gone, exactly as a read does).
    "volli:search": async (input: FileSearchInput): Promise<FileSearchResult> => {
      const scope = await resolveFileScope(db, input.projectId, input.ticketId);
      if (!scope.ok) return scope;
      const run = await searchFiles({ root: searchRoot(scope.value), query: input.query });
      if (!run.ok) return run;
      return { ok: true, ...run.value };
    },

    // `{ ok: true }` is a claim that the scan RAN: the gateway rejects when a
    // Launch Services lookup could not, and the shared envelope in
    // `ipc-registry.ts` turns that rejection into `{ ok: false, error }` for
    // Integrations to show with its Try again (VC-287). Catching here would
    // put the failure back into an empty menu.
    "volli:external-app-list": async (): Promise<ExternalAppListResult> => ({
      ok: true,
      apps: await externalApps.list(),
    }),

    "volli:external-app-open-file": async (input: ExternalAppOpenFileInput): Promise<Result> => {
      const scope = await resolveFileScope(db, input.projectId, input.ticketId);
      if (!scope.ok) return scope;
      const resolved = await resolveExternalFileTarget(scope.value, input.ticketId, input.relPath);
      if (!resolved.ok) return resolved;
      return await externalApps.open(input.appId, resolved.value.filePath);
    },

    "volli:external-app-open-worktree": async (
      input: ExternalAppOpenWorktreeInput,
    ): Promise<Result> => {
      const resolved = await resolveLiveWorktree(db, input.projectId, input.ticketId);
      if (!resolved.ok) return resolved;
      return await externalApps.open(input.appId, resolved.value.filePath);
    },

    "volli:worktree-reveal": async (input: WorktreeRevealInput): Promise<Result> => {
      const resolved = await resolveLiveWorktree(db, input.projectId, input.ticketId);
      if (!resolved.ok) return resolved;
      try {
        services.client.revealInFolder(resolved.value.filePath);
        return { ok: true };
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    },

    "volli:file-write": async (input: FileWriteInput): Promise<FileWriteResult> => {
      const scope = await resolveFileScope(db, input.projectId, input.ticketId);
      if (!scope.ok) return scope;
      return await writeFile(
        scope.value.projectPath,
        scope.value.worktreeRoot,
        input.relPath,
        input.content,
        input.expectedMtime,
      );
    },

    // The creation track (VC-191). Every one of the five resolves through
    // `resolveFileScope` — the same seam `volli:file-read` uses — so a Ticket
    // workspace creates, renames and trashes inside ITS worktree while Home
    // acts on the main checkout, and neither can act on a path the other's
    // navigator was showing.
    "volli:file-create": async (input: FilePathInput): Promise<FileMutationResult> => {
      const scope = await resolveFileScope(db, input.projectId, input.ticketId);
      if (!scope.ok) return scope;
      return await createFile(scope.value.projectPath, scope.value.worktreeRoot, input.relPath);
    },

    "volli:dir-create": async (input: FilePathInput): Promise<FileMutationResult> => {
      const scope = await resolveFileScope(db, input.projectId, input.ticketId);
      if (!scope.ok) return scope;
      return await createDirectory(
        scope.value.projectPath,
        scope.value.worktreeRoot,
        input.relPath,
      );
    },

    "volli:file-rename": async (input: FileRenameInput): Promise<FileMutationResult> => {
      const scope = await resolveFileScope(db, input.projectId, input.ticketId);
      if (!scope.ok) return scope;
      return await renameEntry(
        scope.value.projectPath,
        scope.value.worktreeRoot,
        input.relPath,
        input.toRelPath,
      );
    },

    "volli:file-duplicate": async (input: FilePathInput): Promise<FileMutationResult> => {
      const scope = await resolveFileScope(db, input.projectId, input.ticketId);
      if (!scope.ok) return scope;
      return await duplicateFile(scope.value.projectPath, scope.value.worktreeRoot, input.relPath);
    },

    "volli:file-delete": async (input: FilePathInput): Promise<Result> => {
      const scope = await resolveFileScope(db, input.projectId, input.ticketId);
      if (!scope.ok) return scope;
      return await services.trashEntry(
        scope.value.projectPath,
        scope.value.worktreeRoot,
        input.relPath,
      );
    },

    "volli:artifact-create": async (input: ArtifactCreateInput): Promise<ArtifactCreateResult> => {
      const project = resolveProjectPath(db, input.projectId);
      if (!project.ok) return project;
      return await createArtifact(project.projectPath, input.name);
    },

    "volli:file-reveal": async (input: FilePathInput): Promise<RevealResult> => {
      const scope = await resolveFileScope(db, input.projectId, input.ticketId);
      if (!scope.ok) return scope;
      const resolved = await resolveExternalFileTarget(scope.value, input.ticketId, input.relPath);
      if (!resolved.ok) return resolved;
      try {
        services.client.revealInFolder(resolved.value.filePath);
        return { ok: true };
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    },

    "volli:file-watch": async (input: FilePathInput, sender: WebContents): Promise<Result> => {
      const scope = await resolveFileScope(db, input.projectId, input.ticketId);
      if (!scope.ok) return scope;
      const resolved = await resolveSafePath(
        scope.value.projectPath,
        scope.value.worktreeRoot,
        input.relPath,
      );
      if (!resolved.ok) return resolved;
      const { source, filePath } = resolved.value;
      return manager.watch(
        clientEventSink(sender),
        input.projectId,
        input.ticketId ?? null,
        input.relPath,
        source,
        dirname(filePath),
        basename(filePath),
        scope.value.projectPath,
      );
    },

    // No try/catch previously guarded this handler either — `manager.unwatch`
    // is synchronous teardown (close/clearTimeout calls), not expected to
    // throw. Under the envelope a throw here now yields `{ ok: false }` rather
    // than an unhandled IPC rejection: a deliberate hardening, not a behavior
    // this handler relied on.
    "volli:file-unwatch": (input: FilePathInput, sender: WebContents): Result => {
      manager.unwatch(
        clientEventSink(sender),
        input.projectId,
        input.ticketId ?? null,
        input.relPath,
      );
      return { ok: true };
    },

    "volli:dir-watch": async (input: DirPathInput, sender: WebContents): Promise<Result> => {
      // Main-checkout-scoped on purpose (CONCEPT #54): no ticket lookup, so an
      // expanded tree row can never drift onto a worktree copy of the repo.
      const project = resolveProjectPath(db, input.projectId);
      if (!project.ok) return project;
      const resolved = await resolveSafeDir(project.projectPath, input.relPath);
      if (!resolved.ok) return resolved;
      return dirManager.watch(
        clientEventSink(sender),
        input.projectId,
        input.relPath,
        resolved.dirPath,
        project.projectPath,
      );
    },

    // Unwatch takes no path resolution at all: a collapsed row must be able to
    // drop its subscription even if the directory has since been deleted (which
    // is often exactly why it collapsed).
    "volli:dir-unwatch": (input: DirPathInput, sender: WebContents): Result => {
      dirManager.unwatch(clientEventSink(sender), input.projectId, input.relPath);
      return { ok: true };
    },

    // The `/` picker's supply — templates AND skills, one fetch. Project-keyed
    // like the file index and for the same reason: `.volli` is self-gitignored,
    // so keying a ticket session's commands to its worktree would hide exactly
    // the templates the project author wrote (see `projectCommandsDir`). The
    // three reads are independent, and any one tier that exists but cannot be
    // read is still an error the composer says out loud.
    /**
     * Creates one `/command` (VC-111). The scope picks which of the two
     * directories the reader already merges it lands in — so a project command
     * shadows a personal one of the same name exactly as it always has, and
     * the collision this refuses is only WITHIN the chosen directory.
     */
    "volli:prompt-template-create": async (
      input: PromptTemplateCreateInput,
    ): Promise<PromptTemplateCreateResult> => {
      const project = getProjectById(db, input.projectId);
      if (!project) return { ok: false, error: "Unknown project" };
      return writePromptTemplate({
        dir:
          input.scope === "project" ? projectCommandsDir(project.path) : options.globalCommandsDir,
        name: input.name,
        description: input.description,
        body: input.body,
      });
    },

    "volli:prompt-templates": async (
      input: PromptTemplateIndexInput,
    ): Promise<PromptTemplateIndexResult> => {
      const project = getProjectById(db, input.projectId);
      if (!project) return { ok: false, error: "Unknown project" };
      const [loaded, skills] = await Promise.all([
        loadPromptTemplates({
          projectCommandsDir: projectCommandsDir(project.path),
          globalCommandsDir: options.globalCommandsDir,
        }),
        loadSkills({
          projectSkillsDir: projectSkillsDir(project.path),
          globalSkillsDir: options.globalSkillsDir,
        }),
      ]);
      if (!loaded.ok) return loaded;
      if (!skills.ok) return skills;
      // A Settings write may land while the two directories are being read.
      // Resolve only against the row current after that wait, so no response
      // can expose the policy snapshot that merely supplied the stable path.
      const currentProject = getProjectById(db, input.projectId);
      if (!currentProject) return { ok: false, error: "Unknown project" };
      // The picker offers what this project actually has. A `manual` skill IS
      // still offered here — withholding it from the model's index is the
      // whole point of that mode, and it stays typable by name; only `off`
      // removes a row. The Skills pane asks for the UNRULED list instead
      // (`ruled: false`): it edits the rules, so a skill set to `off` must
      // stay on its screen to be turned back on.
      return {
        ok: true,
        templates: [...loaded.templates],
        skills:
          input.ruled === false
            ? [...skills.skills]
            : [...applySkillModes(skills.skills, currentProject.skillModes ?? {})],
      };
    },
  };

  registerGuardedIpcHandlers(FILE_IPC, handlers);

  return { files: manager, dirs: dirManager };
}
