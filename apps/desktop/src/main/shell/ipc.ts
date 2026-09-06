import type { BackgroundShellIdInput, Result, ShellIpcChannel } from "../../ipc/contract";
import { SHELL_IPC } from "../ipc-descriptors";
import { registerGuardedIpcHandlers, type IpcHandlerTable } from "../ipc-registry";
import type { BackgroundShellHost } from "./background-shell-host";

/**
 * Registers the renderer's three background shell doors against the one
 * host (VC-270): the list for hydration, the tail for an open output tab,
 * and the person's kill. Host IPC on `browser/ipc.ts`'s terms — shells are
 * live machine resources, and nothing here writes product history.
 *
 * The renderer sees every Session's shells and filters by Session itself,
 * as the Browser Tab registry is listed per project: the person driving the
 * app is not scoped, only the model is.
 */
export function registerBackgroundShellIpcHandlers(host: BackgroundShellHost): void {
  const handlers: IpcHandlerTable<ShellIpcChannel> = {
    "volli:shell-list": () => ({ ok: true, shells: host.listAll() }),
    "volli:shell-tail": (input: BackgroundShellIdInput) => {
      const tail = host.tailOf(input.shellId);
      if (tail === null) return { ok: false, error: "This background shell is gone." };
      return { ok: true, output: tail.output, shell: tail.shell };
    },
    "volli:shell-kill": async (input: BackgroundShellIdInput): Promise<Result> => {
      await host.killAny(input.shellId);
      return { ok: true };
    },
  };
  registerGuardedIpcHandlers(SHELL_IPC, handlers);
}
