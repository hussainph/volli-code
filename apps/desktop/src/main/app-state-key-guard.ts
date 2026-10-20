import { app } from "electron";
import { isAppStateKey, type AppStateKey } from "@volli/shared";
import { hostLogger } from "@volli/host-core/log";

const log = hostLogger("app-state");

/**
 * Dynamic renderer input is the one unchecked writer boundary. Like the SQLite
 * ownership guard, diagnose bugs without changing packaged release behavior.
 * The assertion is intentionally permissive after logging in packaged builds;
 * static main/host callers still have to supply a registered AppStateKey.
 */
export function assertRendererAppStateKey(key: string): asserts key is AppStateKey {
  if (isAppStateKey(key)) return;
  if (app.isPackaged) log.warn("unregistered or retired app_state write", { appState: key });
  else throw new Error(`[volli] Unregistered or retired app_state write: ${key}`);
}
