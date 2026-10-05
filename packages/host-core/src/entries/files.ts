/**
 * `@volli/host-core/files`: worktree files for clients: reads, writes, search, watches, blobs, prompt templates and skills.
 *
 * An explicit list: a name is public because a client imports it. Add one
 * here when a client needs it; host-core's own files import the module
 * itself, never this entry. See the cluster map in the package README.
 */
export { attachBlob, sessionLinkBudgetRefusal } from "../blob-attach";
export { collectUnlinkedBlobs } from "../blob-collect";
export { importBlob } from "../blob-import";
export { blobProtocolResponse } from "../blob-protocol";
export { blobsRoot, removeBlob } from "../blob-store";
export { searchFiles } from "../file-search";
export { createHostFileServices, type HostFileServices } from "../file-services";
export { loadPromptTemplates, writePromptTemplate } from "../prompt-templates";
export { loadSkills } from "../skills";
export {
  buildFileIndex,
  createArtifact,
  createDirectory,
  createFile,
  DirWatchManager,
  duplicateFile,
  FileWatchManager,
  readFile,
  renameEntry,
  resolveExternalFileTarget,
  resolveFileScope,
  resolveLiveWorktree,
  resolveProjectPath,
  resolveSafeDir,
  resolveSafePath,
  searchRoot,
  writeFile,
} from "../volli-fs";
