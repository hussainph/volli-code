import { describe, expect, it } from "vite-plus/test";

import {
  APP_STATE_KEYS,
  APP_STATE_PLACEMENTS,
  CLOUD_PLACEMENT_OWNERS,
  CLOUD_PLACEMENTS,
  classifyAppStateKey,
  isAppStateKey,
  type AppStateKey,
  type AppStateKeyEntry,
} from "./app-state-keys";
import { CHAT_DRAFTS_APP_STATE_KEY, NEW_TICKET_DRAFT_APP_STATE_KEY } from "./blob";
import { LEGACY_BACKUP_APP_STATE_KEY } from "./legacy-import";
import { APPEARANCE_APP_STATE_KEY, THEME_APP_STATE_KEY } from "./theme/app-state";

const exact: Readonly<Record<string, AppStateKeyEntry>> = APP_STATE_KEYS.exact;
const prefixes: Readonly<Record<string, AppStateKeyEntry>> = APP_STATE_KEYS.prefixes;
const allEntries = [...Object.entries(exact), ...Object.entries(prefixes)];

describe("app_state key registry", () => {
  it("places every row in the closed vocabulary with an allowed owner and a reason", () => {
    expect(CLOUD_PLACEMENTS).toEqual(["client-local", "host", "workspace", "split"]);
    expect(APP_STATE_PLACEMENTS).toEqual([...CLOUD_PLACEMENTS, "retired"]);
    expect(CLOUD_PLACEMENT_OWNERS).not.toContain("VC-574");
    for (const [key, entry] of allEntries) {
      expect(key.length, key).toBeGreaterThan(0);
      expect(APP_STATE_PLACEMENTS, key).toContain(entry.placement);
      expect(CLOUD_PLACEMENT_OWNERS, key).toContain(entry.owner);
      expect(entry.reason.trim().length, key).toBeGreaterThan(0);
    }
  });

  it("names both halves of a split row, and only a split row has halves", () => {
    for (const [key, entry] of allEntries) {
      if (entry.placement === "split") {
        expect(["host", "workspace"], key).toContain(entry.split.scope);
        expect(entry.split.host.trim().length, key).toBeGreaterThan(0);
        expect(entry.split.client.trim().length, key).toBeGreaterThan(0);
      } else {
        expect(entry, key).not.toHaveProperty("split");
      }
    }
  });

  it("gives every workspace and split row an area owner, and every retired row none", () => {
    for (const [key, entry] of allEntries) {
      if (entry.placement === "workspace" || entry.placement === "split") {
        expect(entry.owner, key).not.toBe("stays");
      }
      if (entry.placement === "retired") expect(entry.owner, key).toBe("stays");
    }
  });

  it("never lets a prefix shadow an exact key or another prefix", () => {
    const prefixKeys = Object.keys(prefixes);
    for (const prefix of prefixKeys) {
      // A prefix ends at a separator, so `volli:a:` can never swallow `volli:ab`.
      expect(prefix.endsWith(":"), prefix).toBe(true);
      for (const key of Object.keys(exact)) expect(key.startsWith(prefix), key).toBe(false);
      for (const other of prefixKeys) {
        if (other !== prefix) expect(other.startsWith(prefix), other).toBe(false);
      }
    }
  });

  it("is frozen all the way down", () => {
    expect(Object.isFrozen(APP_STATE_KEYS)).toBe(true);
    expect(Object.isFrozen(APP_STATE_KEYS.exact)).toBe(true);
    expect(Object.isFrozen(APP_STATE_KEYS.prefixes)).toBe(true);
    for (const [key, entry] of allEntries) {
      expect(Object.isFrozen(entry), key).toBe(true);
      if (entry.placement === "split") expect(Object.isFrozen(entry.split), key).toBe(true);
    }
    expect(Object.isFrozen(CLOUD_PLACEMENTS)).toBe(true);
    expect(Object.isFrozen(APP_STATE_PLACEMENTS)).toBe(true);
    expect(Object.isFrozen(CLOUD_PLACEMENT_OWNERS)).toBe(true);
  });

  it("holds the VC-574 placements and owners", () => {
    const table = Object.fromEntries(
      allEntries.map(([key, entry]) => [key, `${entry.placement} ${entry.owner}`]),
    );
    expect(table).toEqual({
      theme: "client-local stays",
      appearance: "client-local stays",
      "first-paint": "client-local stays",
      "volli:ui": "client-local stays",
      "volli:workspace": "client-local stays",
      "volli:projects-ui": "client-local stays",
      "volli:chat-drafts": "client-local VC-567",
      "volli:new-ticket-draft": "client-local VC-567",
      "volli:automation-editor-draft": "client-local stays",
      "volli:update-allow-prerelease": "client-local stays",
      "volli:notification-preferences": "client-local VC-578",
      "volli:model-picker-view": "client-local VC-572",
      "volli:vc354-perf:": "client-local stays",
      "volli:experimental-flags": "split VC-577",
      "volli:installation-id": "host VC-572",
      "volli:agent-tools-removed": "host VC-572",
      "volli:follow-up-clean-close": "host stays",
      "volli:min-reader-version": "host stays",
      "volli:legacy-backup": "host VC-573",
      "volli:retention": "host VC-573",
      "volli:worktree-trim": "host VC-566",
      "volli:orphan-processes": "host VC-573",
      "volli:agent-observability": "host VC-573",
      "volli:decision-model": "host VC-572",
      "volli:model-access-default": "host VC-572",
      "volli:model-access-defaults": "host VC-572",
      "volli:model-access-hidden-models": "host VC-572",
      "volli:compaction-policy": "host VC-572",
      "volli:code-mode-policy": "host VC-572",
      "volli:automations-enabled": "host VC-569",
      "volli:automation-schedule-cursors": "host VC-569",
      theme_editor: "retired stays",
      "volli:agent-tools-consent": "retired stays",
      "volli:authority-reason-source": "retired stays",
      "volli:authority-shadow-review-enabled": "retired stays",
      "volli:protection-policy-migration:v1": "retired stays",
      "volli:protection-policy-rollout:v1": "retired stays",
      "volli:runtime-preferences:": "retired stays",
    });
  });

  it("registers the keys shared already names", () => {
    for (const key of [
      THEME_APP_STATE_KEY,
      APPEARANCE_APP_STATE_KEY,
      CHAT_DRAFTS_APP_STATE_KEY,
      NEW_TICKET_DRAFT_APP_STATE_KEY,
      LEGACY_BACKUP_APP_STATE_KEY,
    ] satisfies AppStateKey[]) {
      expect(isAppStateKey(key), key).toBe(true);
    }
    expect(classifyAppStateKey(CHAT_DRAFTS_APP_STATE_KEY)?.reason).toContain("attachment pins");
  });
});

describe("classifyAppStateKey", () => {
  it("returns an exact row with how it matched", () => {
    expect(classifyAppStateKey("volli:retention")).toEqual({
      ...APP_STATE_KEYS.exact["volli:retention"],
      pattern: "volli:retention",
      match: "exact",
    });
  });

  it("returns a split row with both halves", () => {
    const flags = classifyAppStateKey("volli:experimental-flags");
    expect(flags?.placement).toBe("split");
    expect(flags?.split).toEqual(APP_STATE_KEYS.exact["volli:experimental-flags"].split);
  });

  it("matches a prefix row for any suffix", () => {
    for (const key of ["volli:vc354-perf:sidebar", "volli:vc354-perf:"]) {
      expect(classifyAppStateKey(key)).toEqual({
        ...APP_STATE_KEYS.prefixes["volli:vc354-perf:"],
        pattern: "volli:vc354-perf:",
        match: "prefix",
      });
    }
  });

  it("classifies retired rows as retired, exact and prefixed alike", () => {
    expect(classifyAppStateKey("theme_editor")).toMatchObject({
      placement: "retired",
      match: "exact",
    });
    expect(classifyAppStateKey("volli:runtime-preferences:opencode")).toMatchObject({
      placement: "retired",
      pattern: "volli:runtime-preferences:",
      match: "prefix",
    });
  });

  it("leaves unregistered keys, near misses and inherited names unclassified", () => {
    for (const key of [
      "",
      "volli:other",
      "volli:theme",
      "Theme",
      "volli:retention ",
      "volli:vc354-perf",
      "volli:runtime-preferences",
      "constructor",
      "__proto__",
      "toString",
    ]) {
      expect(classifyAppStateKey(key), key).toBeUndefined();
    }
  });
});

describe("isAppStateKey", () => {
  it("accepts live exact keys and live prefixed keys", () => {
    expect(isAppStateKey("theme")).toBe(true);
    expect(isAppStateKey("volli:automations-enabled")).toBe(true);
    expect(isAppStateKey("volli:vc354-perf:workspace")).toBe(true);
  });

  it("never accepts a retired row as live", () => {
    for (const [key, entry] of allEntries) {
      if (entry.placement === "retired") expect(isAppStateKey(key), key).toBe(false);
    }
    expect(isAppStateKey("volli:runtime-preferences:opencode")).toBe(false);
  });

  it("refuses unregistered keys", () => {
    expect(isAppStateKey("volli:other")).toBe(false);
    expect(isAppStateKey("constructor")).toBe(false);
  });

  it("narrows to the compile-time union", () => {
    const key: string = "volli:retention";
    if (!isAppStateKey(key)) throw new Error("expected a live key");
    const narrowed: AppStateKey = key;
    expect(narrowed).toBe("volli:retention");
  });
});

// Compile-time half: the union admits live keys and prefixes only.
const live: AppStateKey[] = ["theme", "volli:ui", "volli:vc354-perf:anything"];
// @ts-expect-error a retired exact key is not writable
const retiredExact: AppStateKey = "theme_editor";
// @ts-expect-error a retired prefix is not writable
const retiredPrefix: AppStateKey = "volli:runtime-preferences:opencode";
// @ts-expect-error an unregistered key is not writable
const unregistered: AppStateKey = "volli:other";
void [live, retiredExact, retiredPrefix, unregistered];
