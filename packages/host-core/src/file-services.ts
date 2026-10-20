/** Host-owned file watch lifetimes and filesystem/client adapters (VC-557). */
import { DirWatchManager, FileWatchManager, trashEntry } from "./volli-fs";
import { clientCapabilities, type ClientCapabilityPort } from "./ports/client";
import { trashCapabilities, type TrashPort } from "./ports/trash";
import type { HostCorePorts } from "./index";

export interface HostFileServices {
  readonly files: FileWatchManager;
  readonly dirs: DirWatchManager;
  readonly client: ClientCapabilityPort;
  readonly trash: TrashPort;
  readonly trashEntry: (
    projectPath: string,
    worktreeRoot: string | null,
    relPath: string,
  ) => ReturnType<typeof trashEntry>;
}

export function createHostFileServices(
  ports: Pick<HostCorePorts, "client" | "trash">,
): HostFileServices {
  const trash = trashCapabilities(ports.trash);
  return {
    files: new FileWatchManager(),
    dirs: new DirWatchManager(),
    client: clientCapabilities(ports.client),
    trash,
    trashEntry: (projectPath, worktreeRoot, relPath) =>
      trashEntry(projectPath, worktreeRoot, relPath, trash),
  };
}
