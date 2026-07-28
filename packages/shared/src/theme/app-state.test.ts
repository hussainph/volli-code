import { describe, expect, it } from "vite-plus/test";

import {
  parseGlobalEditorThemeId,
  serializeGlobalEditorThemeId,
  THEME_APP_STATE_KEY,
  THEME_EDITOR_APP_STATE_KEY,
} from "./app-state";
import type { ShippedEditorThemeId } from "./editor-themes";

describe("theme app_state keys", () => {
  it("stores the authored canvas under the `theme` key", () => {
    expect(THEME_APP_STATE_KEY).toBe("theme");
  });

  it("stores the global editor theme id under a dedicated key", () => {
    expect(THEME_EDITOR_APP_STATE_KEY).toBe("theme_editor");
  });
});

describe("global editor theme id", () => {
  it("round-trips an id and treats absent/empty as derive-from-app", () => {
    expect(parseGlobalEditorThemeId(serializeGlobalEditorThemeId("nord"))).toBe("nord");
    expect(parseGlobalEditorThemeId(serializeGlobalEditorThemeId(null))).toBeNull();
    expect(parseGlobalEditorThemeId(undefined)).toBeNull();
    expect(parseGlobalEditorThemeId(null)).toBeNull();
    expect(parseGlobalEditorThemeId("")).toBeNull();
  });

  it("treats a non-catalog editor theme id as derive-from-app", () => {
    expect(parseGlobalEditorThemeId("volli-dark")).toBeNull();
    expect(parseGlobalEditorThemeId("not-a-theme")).toBeNull();
    expect(parseGlobalEditorThemeId("vs-dark")).toBeNull();
    expect(serializeGlobalEditorThemeId("volli-dark" as ShippedEditorThemeId)).toBe("");
    expect(serializeGlobalEditorThemeId("not-a-theme" as ShippedEditorThemeId)).toBe("");
  });
});
