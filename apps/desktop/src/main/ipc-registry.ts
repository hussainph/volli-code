import { ipcMain } from "electron";
import type { WebContents } from "electron";
import { errorMessage } from "@volli/shared";
import type { IpcArgs, IpcResult, VolliInvokeContract } from "@volli/shared";

// The one guard→body→error envelope every DB-backed IPC surface registers
// through (issue #98). Callers pass a shared descriptor table (the derived
// channel catalog) plus one handler body per channel; the mapped types make a
// missing or extra handler a compile error, so a channel can no longer exist
// without a registered handler — the class of bug where a renderer `invoke()`
// hangs forever.

/** The runtime validators for a channel subset — structurally matches shared's descriptor tables. */
export type IpcDescriptorTable<Cs extends keyof VolliInvokeContract> = {
  readonly [C in Cs]: {
    guard: (args: unknown[]) => args is IpcArgs<C>;
    invalidError: string;
  };
};

/**
 * One handler body per channel — already-validated args in, the contract's
 * result out. The invoking `WebContents` rides along as a TRAILING parameter:
 * the rare sender-scoped handler (file-watch subscriptions) declares it, and
 * every other handler simply omits the trailing param it doesn't use.
 */
export type IpcHandlerTable<Cs extends keyof VolliInvokeContract> = {
  readonly [C in Cs]: (
    ...args: [...IpcArgs<C>, sender: WebContents]
  ) => IpcResult<C> | Promise<IpcResult<C>>;
};

/**
 * Registers every descriptor channel with the uniform envelope: guard rejects
 * → `{ ok: false }` with the descriptor's message; handler throw/rejection →
 * `{ ok: false, error }` (failures must cross IPC as data — `ipcMain.handle`
 * rejections serialize into useless strings). A sync handler's result is
 * returned synchronously: the envelope must never force async on the many
 * sync SQLite handlers (their tests dispatch synchronously too).
 */
export function registerGuardedIpcHandlers<Cs extends keyof VolliInvokeContract>(
  descriptors: IpcDescriptorTable<Cs>,
  handlers: IpcHandlerTable<Cs>,
): void {
  const register = <C extends Cs>(channel: C): void => {
    const { guard, invalidError } = descriptors[channel];
    const handler = handlers[channel];
    ipcMain.handle(channel, (event, ...args: unknown[]) => {
      if (!guard(args)) return { ok: false, error: invalidError };
      try {
        const outcome = handler(...args, event.sender);
        return outcome instanceof Promise
          ? outcome.catch((error: unknown) => ({ ok: false, error: errorMessage(error) }))
          : outcome;
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    });
  };
  for (const channel of Object.keys(descriptors) as Cs[]) register(channel);
}

/**
 * The degraded-DB path: when the main-process open+migrate failed, every
 * channel of the surface answers `{ ok: false, error }` — main never crashes
 * and `invoke()` never hangs; the renderer surfaces the failure itself.
 */
export function registerDegradedIpcHandlers(
  channels: readonly (keyof VolliInvokeContract)[],
  error: string,
): void {
  for (const channel of channels) {
    ipcMain.handle(channel, () => ({ ok: false, error }));
  }
}
