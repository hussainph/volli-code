import { ipcMain } from "electron";
import type { WebContents } from "electron";
import type { SecretService } from "@volli/host-core/secrets/service";
import type { VolliInvokeContract } from "../../ipc/contract";

function record(raw: unknown): Record<string, unknown> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("Invalid input");
  return raw as Record<string, unknown>;
}
function text(raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0) throw new Error("Invalid input");
  return raw;
}

function failed() {
  return {
    ok: false,
    error: "Could not update the secret. Retry or choose Session storage.",
  };
}

/** Dedicated app-only door, with no generic Session resolution or CLI equivalent.
 * Never hand an exception from persistence back over IPC: OS/codec errors can
 * quote their input. In particular this envelope must never log args.
 */
export function registerSecretIpc(
  service: SecretService,
  trusted: (sender: WebContents) => boolean,
): void {
  const handle = (channel: keyof VolliInvokeContract, run: (...args: unknown[]) => unknown) => {
    ipcMain.handle(channel, (event, ...args: unknown[]) => {
      if (!trusted(event.sender) || event.senderFrame !== event.sender.mainFrame) {
        return { ok: false, error: "Credentials can only be changed in Volli." };
      }
      try {
        const result = run(...args);
        return result instanceof Promise ? result.catch(failed) : result;
      } catch {
        return failed();
      }
    });
  };
  handle("volli:secrets-list", (projectId) => {
    if (projectId !== undefined && typeof projectId !== "string")
      throw new Error("Invalid project");
    return service.list(projectId);
  });
  handle("volli:secret-submit", (raw) => {
    const input = record(raw);
    const scope = input["scope"];
    if (scope !== "session" && scope !== "project" && scope !== "always")
      throw new Error("Invalid scope");
    return service
      .submit(text(input["requestId"]), text(input["value"]), scope)
      .then(() => ({ ok: true }));
  });
  handle("volli:secret-decline", (id) => {
    return service.decline(text(id)).then(() => ({ ok: true }));
  });
  handle("volli:secret-revoke", (id) => {
    service.store.revoke(text(id));
    return { ok: true };
  });
  handle("volli:secret-replace", (raw) => {
    const input = record(raw);
    service.replace(text(input["id"]), text(input["value"]));
    return { ok: true };
  });
}
