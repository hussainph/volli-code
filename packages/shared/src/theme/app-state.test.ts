import { describe, expect, it } from "vite-plus/test";

import * as appState from "./app-state";
import { APPEARANCE_APP_STATE_KEY, THEME_APP_STATE_KEY } from "./app-state";

describe("theme app_state keys", () => {
  it("stores the authored canvas under the `theme` key", () => {
    expect(THEME_APP_STATE_KEY).toBe("theme");
  });

  it("stores the global appearance beside it", () => {
    expect(APPEARANCE_APP_STATE_KEY).toBe("appearance");
  });

  it("has no editor-theme key: the editor follows appearance, so there is nothing to store", () => {
    // VC-123 retired `theme_editor` along with the picker. The ROW may still
    // exist in an upgraded database; nothing reads it, which is the tolerant
    // read — an old id now means the same as no id.
    expect(appState).not.toHaveProperty("THEME_EDITOR_APP_STATE_KEY");
    expect(appState).not.toHaveProperty("parseGlobalEditorThemeId");
    expect(appState).not.toHaveProperty("serializeGlobalEditorThemeId");
  });
});
