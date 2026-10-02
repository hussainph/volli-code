import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { deleteAppState, setAppState } from "../db/app-state-repo";
import { DECISION_MODEL_APP_STATE_KEY } from "../decision/settings";
import { AUTHORITY_SHADOW_REVIEW_ENABLED_KEY } from "../../authority-review-preferences";
import { readAuthorityShadowReviewEnabled } from "./authority-shadow-review";

let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:");
  db.exec("CREATE TABLE app_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER)");
});
afterEach(() => db.close());

describe("paid authority shadow review opt-in", () => {
  it("defaults off independently of decision model and display settings", () => {
    setAppState(
      db,
      DECISION_MODEL_APP_STATE_KEY,
      JSON.stringify({
        kind: "cloud",
        providerId: "typesafe",
        modelId: "judge",
        optIn: { acceptedAt: 0, purposes: ["authority.judge"] },
      }),
      0,
    );
    setAppState(db, "volli:ui", JSON.stringify({ state: { authorityHintsVisible: true } }), 0);
    expect(readAuthorityShadowReviewEnabled(db)).toBe(false);
  });

  it.each(["false", '"true"', "1", "null", "{}", '{"state":{"enabled":true}}', "invalid", ""])(
    "stays off for a non-opt-in payload %j",
    (raw) => {
      setAppState(db, AUTHORITY_SHADOW_REVIEW_ENABLED_KEY, raw, 0);
      expect(readAuthorityShadowReviewEnabled(db)).toBe(false);
    },
  );

  it("reads each durable change live, and removing the preference restores off", () => {
    setAppState(db, AUTHORITY_SHADOW_REVIEW_ENABLED_KEY, JSON.stringify(true), 0);
    expect(readAuthorityShadowReviewEnabled(db)).toBe(true);
    setAppState(db, AUTHORITY_SHADOW_REVIEW_ENABLED_KEY, JSON.stringify(false), 1);
    expect(readAuthorityShadowReviewEnabled(db)).toBe(false);
    setAppState(db, AUTHORITY_SHADOW_REVIEW_ENABLED_KEY, JSON.stringify(true), 2);
    expect(readAuthorityShadowReviewEnabled(db)).toBe(true);
    deleteAppState(db, AUTHORITY_SHADOW_REVIEW_ENABLED_KEY);
    expect(readAuthorityShadowReviewEnabled(db)).toBe(false);
  });

  it("stays off when the settings store cannot be read", () => {
    db.exec("DROP TABLE app_state");
    expect(readAuthorityShadowReviewEnabled(db)).toBe(false);
  });
});
