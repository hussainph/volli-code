import { describe, expect, it } from "vite-plus/test";
import { classifyAppStateKey, LEGACY_BACKUP_APP_STATE_KEY } from "@volli/shared";
import { AGENT_TOOLS_REMOVED_APP_STATE_KEY } from "./agent-tools-state";
import { INSTALLATION_ID_APP_STATE_KEY } from "./installation-id";
import { EXPERIMENTS_APP_STATE_KEY } from "./experiments";
import { NOTIFICATION_PREFERENCES_KEY } from "./notification-preferences";
import { UPDATE_ALLOW_PRERELEASE_APP_STATE_KEY } from "./auto-update";

describe("desktop and renderer app_state constants", () => {
  it.each([
    [AGENT_TOOLS_REMOVED_APP_STATE_KEY, "host"],
    [INSTALLATION_ID_APP_STATE_KEY, "host"],
    [EXPERIMENTS_APP_STATE_KEY, "split"],
    [NOTIFICATION_PREFERENCES_KEY, "client-local"],
    [UPDATE_ALLOW_PRERELEASE_APP_STATE_KEY, "client-local"],
    [LEGACY_BACKUP_APP_STATE_KEY, "host"],
  ])("%s remains classified as %s", (key, placement) => {
    expect(classifyAppStateKey(key)?.placement).toBe(placement);
  });
});
