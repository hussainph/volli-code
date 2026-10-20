/**
 * Every `app_state` key host-core names is registered in `@volli/shared`'s
 * registry with the placement VC-574 ruled for it. `setAppState` and friends
 * already refuse an unregistered key at compile time; this pins WHERE each
 * registered one belongs, so moving a key between placements is a reviewed
 * change here rather than a silent edit of the shared table.
 */
import {
  APPEARANCE_APP_STATE_KEY,
  type AppStateKey,
  type CloudPlacement,
  type CloudPlacementOwner,
  classifyAppStateKey,
  isAppStateKey,
  THEME_APP_STATE_KEY,
} from "@volli/shared";
import { describe, expect, it } from "vite-plus/test";

import { AUTOMATION_SCHEDULE_CURSORS_KEY } from "../automations/schedule-cursor";
import { AUTOMATIONS_ENABLED_KEY } from "../automations/enablement";
import { DECISION_MODEL_APP_STATE_KEY } from "../decision/settings";
import { AGENT_OBSERVABILITY_APP_STATE_KEY } from "../observability/settings";
import { AUTO_REAP_SETTINGS_KEY } from "../process/auto-reap-settings";
import {
  CODE_MODE_POLICY_APP_STATE_KEY,
  COMPACTION_POLICY_APP_STATE_KEY,
  MODEL_ACCESS_DEFAULT_APP_STATE_KEY,
  MODEL_ACCESS_DEFAULTS_APP_STATE_KEY,
  MODEL_ACCESS_HIDDEN_MODELS_APP_STATE_KEY,
  MODEL_PICKER_VIEW_APP_STATE_KEY,
} from "../session-runtime/model-access-preferences";
import { RETENTION_SETTINGS_KEY } from "../worktree/retention";
import { TRIM_SETTINGS_KEY } from "../worktree/trim-settings";
import { FOLLOW_UP_CLEAN_CLOSE_KEY } from "./session-follow-up-repo";
import { MIN_READER_VERSION_KEY } from "./schema-compatibility";
import { FIRST_PAINT_APP_STATE_KEY } from "./theme-repo";

const HOST_CORE_KEYS: ReadonlyArray<
  readonly [key: AppStateKey, placement: CloudPlacement, owner: CloudPlacementOwner]
> = [
  [THEME_APP_STATE_KEY, "client-local", "stays"],
  [APPEARANCE_APP_STATE_KEY, "client-local", "stays"],
  [FIRST_PAINT_APP_STATE_KEY, "client-local", "stays"],
  [MODEL_PICKER_VIEW_APP_STATE_KEY, "client-local", "VC-572"],
  [MIN_READER_VERSION_KEY, "host", "stays"],
  [FOLLOW_UP_CLEAN_CLOSE_KEY, "host", "stays"],
  [RETENTION_SETTINGS_KEY, "host", "VC-573"],
  [TRIM_SETTINGS_KEY, "host", "VC-566"],
  [AUTO_REAP_SETTINGS_KEY, "host", "VC-573"],
  [AGENT_OBSERVABILITY_APP_STATE_KEY, "host", "VC-573"],
  [DECISION_MODEL_APP_STATE_KEY, "host", "VC-572"],
  [MODEL_ACCESS_DEFAULT_APP_STATE_KEY, "host", "VC-572"],
  [MODEL_ACCESS_DEFAULTS_APP_STATE_KEY, "host", "VC-572"],
  [MODEL_ACCESS_HIDDEN_MODELS_APP_STATE_KEY, "host", "VC-572"],
  [COMPACTION_POLICY_APP_STATE_KEY, "host", "VC-572"],
  [CODE_MODE_POLICY_APP_STATE_KEY, "host", "VC-572"],
  [AUTOMATIONS_ENABLED_KEY, "host", "VC-569"],
  [AUTOMATION_SCHEDULE_CURSORS_KEY, "host", "VC-569"],
];

describe("host-core app_state keys", () => {
  it.each(HOST_CORE_KEYS)("registers %s as %s, moved by %s", (key, placement, owner) => {
    expect(isAppStateKey(key)).toBe(true);
    expect(classifyAppStateKey(key)).toMatchObject({ placement, owner, match: "exact" });
  });

  it("names each key once", () => {
    expect(new Set(HOST_CORE_KEYS.map(([key]) => key)).size).toBe(HOST_CORE_KEYS.length);
  });
});
