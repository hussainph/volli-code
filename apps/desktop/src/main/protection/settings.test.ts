import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { DEFAULT_AUTHORITY_POLICY } from "@volli/shared";

import { getAllAppState, getAppState, setAppState } from "../db/app-state-repo";
import { getProjectAuthorityPolicy, insertProject } from "../db/projects-repo";
import { openTestDb, testProject, type TestDb } from "../db/test-helpers";
import {
  migrateProtectionPolicies,
  PROTECTION_EXPERIMENT_KEY,
  PROTECTION_POLICY_MIGRATION_KEY,
  protectionExperimentEnabled,
  setProtectionExperimentEnabled,
} from "./settings";

let ctx: TestDb;

beforeEach(() => {
  ctx = openTestDb();
});

afterEach(() => {
  ctx.cleanup();
});

function project(id: string, raw: string | null): void {
  insertProject(ctx.db, testProject({ id }));
  ctx.db.prepare("UPDATE projects SET authority_policy = ? WHERE id = ?").run(raw, id);
}

function row(id: string) {
  return ctx.db
    .prepare<
      [string],
      { authority_policy: string | null; row_version: number; updated_at: number }
    >("SELECT authority_policy, row_version, updated_at FROM projects WHERE id = ?")
    .get(id);
}

function backup() {
  const raw = getAppState(ctx.db, PROTECTION_POLICY_MIGRATION_KEY);
  expect(raw).toBeDefined();
  return JSON.parse(raw!) as {
    completedAt: number;
    policies: { projectId: string; authorityPolicy: string }[];
  };
}

function enabledWithoutMigration(): void {
  setAppState(ctx.db, PROTECTION_EXPERIMENT_KEY, '{"enabled":true}', 1);
}

const hidden = {
  judgmentMode: "auto",
  classifierModel: "legacy-classifier",
  fallback: { consecutiveDenials: 1, sessionDenials: 2 },
  budgets: { delegationExceeded: "refuse" },
  // VC-45 fields are unknown on main: dropping only parsed fields misses them.
  containment: "off",
  writableRoots: ["/outside/workspace"],
  futureSetting: { enabled: true },
  actors: {
    user: { peek: "none", coordinationVerbs: [] },
    session: {
      peek: "project",
      coordinationVerbs: [],
      awaitable: [],
      awaitableSessions: [],
      writableRoots: ["/legacy"],
    },
    unauthenticated: { peek: "project", coordinationVerbs: ["ticket.move"] },
    unknownActor: { peek: "project" },
  },
};

describe("Protection policy cleanup", () => {
  it.each([undefined, "not json", "null", "[]", "{}", '{"enabled":"true"}', '{"enabled":false}'])(
    "is inert while the experiment is off (%s)",
    (flag) => {
      const raw = JSON.stringify({ enforcement: "observe", ...hidden });
      project("dormant", raw);
      if (flag !== undefined) setAppState(ctx.db, PROTECTION_EXPERIMENT_KEY, flag, 1);
      const before = row("dormant");
      const policy = getProjectAuthorityPolicy(ctx.db, "dormant");
      const state = getAllAppState(ctx.db);

      expect(protectionExperimentEnabled(ctx.db)).toBe(false);
      migrateProtectionPolicies(ctx.db, 10);
      expect(row("dormant")).toEqual(before);
      expect(getProjectAuthorityPolicy(ctx.db, "dormant")).toEqual(policy);
      expect(getAllAppState(ctx.db)).toEqual(state);
      expect(getAppState(ctx.db, PROTECTION_POLICY_MIGRATION_KEY)).toBeUndefined();
      setProtectionExperimentEnabled(ctx.db, false, 11);
      expect(row("dormant")).toEqual(before);
      expect(getAppState(ctx.db, PROTECTION_POLICY_MIGRATION_KEY)).toBeUndefined();
    },
  );

  it.each(["off", "observe"] as const)(
    "clears every hidden departure, preserving explicit %s and visible Session peek",
    (enforcement) => {
      project("dormant", JSON.stringify({ enforcement, ...hidden }));
      const before = row("dormant")!;
      setProtectionExperimentEnabled(ctx.db, true, 10);

      expect(protectionExperimentEnabled(ctx.db)).toBe(true);
      expect(row("dormant")).toEqual({
        authority_policy: JSON.stringify({ enforcement, actors: { session: { peek: "project" } } }),
        row_version: before.row_version + 1,
        updated_at: 10,
      });
      expect(getProjectAuthorityPolicy(ctx.db, "dormant")).toEqual({
        ...DEFAULT_AUTHORITY_POLICY,
        enforcement,
        actors: {
          ...DEFAULT_AUTHORITY_POLICY.actors,
          session: { ...DEFAULT_AUTHORITY_POLICY.actors.session, peek: "project" },
        },
      });
    },
  );

  it("backs up exact raw strings for all non-null policies, leaving enforcing rows untouched", () => {
    const enforce =
      '{ "enforcement" : "enforce", "containment":"required", "writableRoots":["/a"], "fallback":{"sessionDenials":1} }\n';
    const dormant = '{ "judgmentMode" : "auto", "judgmentMode" : "ask", "unknown": 5 }\n';
    project("enforce", enforce);
    project("dormant", dormant);
    project("inherit", null);
    const beforeEnforce = row("enforce");
    const beforeInherit = row("inherit");
    enabledWithoutMigration();
    migrateProtectionPolicies(ctx.db, 12);

    expect(row("enforce")).toEqual(beforeEnforce);
    expect(row("inherit")).toEqual(beforeInherit);
    expect(row("dormant")?.authority_policy).toBeNull();
    expect(backup()).toEqual({
      completedAt: 12,
      policies: [
        { projectId: "dormant", authorityPolicy: dormant },
        { projectId: "enforce", authorityPolicy: enforce },
      ],
    });
  });

  it.each(["none", "project"] as const)("preserves a visible peek-only %s departure", (peek) => {
    project("peek", JSON.stringify({ ...hidden, actors: { session: { peek } } }));
    setProtectionExperimentEnabled(ctx.db, true, 10);
    expect(row("peek")?.authority_policy).toBe(JSON.stringify({ actors: { session: { peek } } }));
    expect(getProjectAuthorityPolicy(ctx.db, "peek").enforcement).toBe(
      DEFAULT_AUTHORITY_POLICY.enforcement,
    );
  });

  it.each([
    "{}",
    "null",
    "[]",
    '"off"',
    '{"enforcement":"invalid","actors":{"session":{"peek":"invalid"}}}',
    JSON.stringify({ ...hidden, actors: { session: { peek: "own" } } }),
  ])("inherits defaults without pinning them (%s)", (raw) => {
    project("defaults", raw);
    setProtectionExperimentEnabled(ctx.db, true, 10);
    expect(row("defaults")?.authority_policy).toBeNull();
    expect(getProjectAuthorityPolicy(ctx.db, "defaults")).toEqual(DEFAULT_AUTHORITY_POLICY);
  });

  it("tolerates malformed JSON like the policy reader after backing it up", () => {
    ctx.db.pragma("ignore_check_constraints = ON");
    project("corrupt", "not json");
    ctx.db.pragma("ignore_check_constraints = OFF");
    setProtectionExperimentEnabled(ctx.db, true, 10);
    expect(row("corrupt")?.authority_policy).toBeNull();
    expect(backup().policies).toEqual([{ projectId: "corrupt", authorityPolicy: "not json" }]);
  });

  it("does not update an already canonical departure", () => {
    project("canonical", '{"enforcement":"observe"}');
    const before = row("canonical");
    setProtectionExperimentEnabled(ctx.db, true, 10);
    expect(row("canonical")).toEqual(before);
    expect(backup().policies).toHaveLength(1);
  });

  it("is idempotent across repeated calls, toggles, and later project edits", () => {
    project("dormant", JSON.stringify(hidden));
    setProtectionExperimentEnabled(ctx.db, true, 10);
    const state = getAppState(ctx.db, PROTECTION_POLICY_MIGRATION_KEY);
    const cleaned = row("dormant");
    migrateProtectionPolicies(ctx.db, 11);
    expect(row("dormant")).toEqual(cleaned);

    ctx.db
      .prepare("UPDATE projects SET authority_policy = ? WHERE id = ?")
      .run(JSON.stringify(hidden), "dormant");
    project("later", JSON.stringify(hidden));
    const edited = row("dormant");
    const later = row("later");
    setProtectionExperimentEnabled(ctx.db, false, 12);
    setProtectionExperimentEnabled(ctx.db, true, 13);
    migrateProtectionPolicies(ctx.db, 14);
    expect(row("dormant")).toEqual(edited);
    expect(row("later")).toEqual(later);
    expect(getAppState(ctx.db, PROTECTION_POLICY_MIGRATION_KEY)).toBe(state);
  });

  it("durably marks completion even when there are no policies", () => {
    project("inherit", null);
    setProtectionExperimentEnabled(ctx.db, true, 10);
    expect(backup()).toEqual({ completedAt: 10, policies: [] });
    project("later", JSON.stringify(hidden));
    const before = row("later");
    migrateProtectionPolicies(ctx.db, 11);
    expect(row("later")).toEqual(before);
    expect(backup()).toEqual({ completedAt: 10, policies: [] });
  });

  it.each(["absent", "off", "enabled"] as const)(
    "rolls back backup, all row updates, and any flag write on failure (previously %s)",
    (flag) => {
      project("a", JSON.stringify(hidden));
      project("z", JSON.stringify(hidden));
      if (flag === "off") setProtectionExperimentEnabled(ctx.db, false, 1);
      if (flag === "enabled") enabledWithoutMigration();
      const state = getAllAppState(ctx.db);
      const a = row("a");
      const z = row("z");
      ctx.db.exec(`CREATE TRIGGER fail_policy_cleanup BEFORE UPDATE OF authority_policy ON projects
        WHEN NEW.id = 'z' BEGIN SELECT RAISE(ABORT, 'disk full'); END`);

      expect(() => {
        if (flag === "enabled") migrateProtectionPolicies(ctx.db, 10);
        else setProtectionExperimentEnabled(ctx.db, true, 10);
      }).toThrow("disk full");
      expect(getAllAppState(ctx.db)).toEqual(state);
      expect(row("a")).toEqual(a);
      expect(row("z")).toEqual(z);
      expect(getAppState(ctx.db, PROTECTION_POLICY_MIGRATION_KEY)).toBeUndefined();

      ctx.db.exec("DROP TRIGGER fail_policy_cleanup");
      setProtectionExperimentEnabled(ctx.db, true, 11);
      expect(backup().completedAt).toBe(11);
      expect(backup().policies).toHaveLength(2);
    },
  );

  it("does not enable the experiment when its backup cannot be stored", () => {
    project("dormant", JSON.stringify(hidden));
    const before = row("dormant");
    ctx.db.exec(`CREATE TRIGGER fail_policy_backup BEFORE INSERT ON app_state
      WHEN NEW.key = '${PROTECTION_POLICY_MIGRATION_KEY}' BEGIN SELECT RAISE(ABORT, 'disk full'); END`);
    expect(() => setProtectionExperimentEnabled(ctx.db, true, 10)).toThrow("disk full");
    expect(getAllAppState(ctx.db)).toEqual({});
    expect(row("dormant")).toEqual(before);
    expect(protectionExperimentEnabled(ctx.db)).toBe(false);
  });
});
