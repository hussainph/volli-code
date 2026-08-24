import { afterEach, describe, expect, it } from "vite-plus/test";
import { createDesktopSessionEngine } from "../session-control";
import { insertSession } from "../session-control/test-support";
import { testProject, testSession, testTicket, openTestDb } from "./test-helpers";
import type { TestDb } from "./test-helpers";
import { DEFAULT_AUTHORITY_POLICY } from "@volli/shared";
import {
  deleteProject,
  getProjectAuthorityPolicy,
  getProjectById,
  insertProject,
  updateProjectAuthorityPolicy,
  updateProjectSkillModes,
  updateProjectSessionDefaults,
} from "./projects-repo";
import { insertTicket } from "./tickets-repo";

let ctx: TestDb;

afterEach(() => {
  ctx.cleanup();
});

describe("deleteProject", () => {
  it("cascades durable Sessions and every ledger row without foreign-key violations", async () => {
    ctx = openTestDb();
    const project = testProject({ id: "project-1" });
    const ticket = testTicket(project.id, { id: "ticket-1" });
    const session = testSession(project.id, ticket.id, { id: "session-1" });
    insertProject(ctx.db, project);
    insertTicket(ctx.db, ticket);
    insertSession(ctx.db, session);
    await createDesktopSessionEngine(ctx.db).submit({
      commandId: "signal-session-1",
      sessionId: session.id,
      intent: { kind: "session.signal", signal: "blocked", reason: "Needs approval" },
      provenance: {
        source: { kind: "user", id: "test", detail: null },
        venue: { id: "local", kind: "local" },
      },
    });

    for (const table of [
      "projects",
      "tickets",
      "sessions",
      "session_attachments",
      "session_commands",
      "session_events",
      "session_command_receipts",
    ]) {
      const row = ctx.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
        count: number;
      };
      expect(row.count).toBeGreaterThan(0);
    }

    deleteProject(ctx.db, project.id);

    for (const table of [
      "projects",
      "tickets",
      "sessions",
      "session_attachments",
      "session_commands",
      "session_events",
      "session_command_receipts",
    ]) {
      expect(ctx.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
    }
    expect(ctx.db.pragma("foreign_key_check")).toEqual([]);
  });
});

describe("per-project agent configuration (migration 023)", () => {
  it("reads a fresh project as inheriting all three", () => {
    ctx = openTestDb();
    const project = testProject({ id: "p1" });
    insertProject(ctx.db, project);

    expect(getProjectById(ctx.db, "p1")).toMatchObject({
      skillModes: {},
      sessionHarness: null,
      sessionModel: null,
    });
  });

  it("round-trips a skill rule map", () => {
    ctx = openTestDb();
    insertProject(ctx.db, testProject({ id: "p1" }));

    const updated = updateProjectSkillModes(ctx.db, "p1", { tdd: "manual", mintlify: "off" }, 10);

    expect(updated?.skillModes).toEqual({ tdd: "manual", mintlify: "off" });
    expect(getProjectById(ctx.db, "p1")?.skillModes).toEqual({ tdd: "manual", mintlify: "off" });
  });

  it("stores an all-default rule map as inherit rather than an empty object", () => {
    ctx = openTestDb();
    insertProject(ctx.db, testProject({ id: "p1" }));
    updateProjectSkillModes(ctx.db, "p1", { tdd: "off" }, 10);

    updateProjectSkillModes(ctx.db, "p1", {}, 11);

    // A project that put everything back must read exactly like one that never
    // ruled on anything — the same rule every other nullable column here keeps.
    expect(ctx.db.prepare("SELECT skill_modes FROM projects WHERE id = 'p1'").get()).toEqual({
      skill_modes: null,
    });
  });

  it("round-trips the session harness and model, and clears them back to inherit", () => {
    ctx = openTestDb();
    insertProject(ctx.db, testProject({ id: "p1" }));
    const selection = {
      providerId: "anthropic",
      modelId: "claude-opus-4-6",
      reasoningLevel: "high" as const,
    };

    updateProjectSessionDefaults(ctx.db, "p1", { harness: "codex", model: selection }, 10);
    expect(getProjectById(ctx.db, "p1")).toMatchObject({
      sessionHarness: "codex",
      sessionModel: selection,
    });

    updateProjectSessionDefaults(ctx.db, "p1", { harness: null, model: null }, 11);
    expect(getProjectById(ctx.db, "p1")).toMatchObject({
      sessionHarness: null,
      sessionModel: null,
    });
  });

  it("inherits rather than throwing when a column was edited into nonsense outside the app", () => {
    ctx = openTestDb();
    insertProject(ctx.db, testProject({ id: "p1" }));

    // Valid JSON — so the CHECK passes — but not the shape either field means.
    ctx.db.prepare("UPDATE projects SET skill_modes = '\"tdd\"' WHERE id = 'p1'").run();
    ctx.db
      .prepare("UPDATE projects SET session_model = '{\"providerId\":5}' WHERE id = 'p1'")
      .run();

    // A project row is read at boot in a loop over every project, before there
    // is any UI to report a failure in — one bad row must not take the rail down.
    expect(getProjectById(ctx.db, "p1")).toMatchObject({
      skillModes: {},
      sessionModel: null,
    });
  });
});

describe("getProjectAuthorityPolicy", () => {
  it("governs a project that recorded nothing by the built-in defaults", () => {
    ctx = openTestDb();
    insertProject(ctx.db, testProject({ id: "p1" }));

    expect(getProjectAuthorityPolicy(ctx.db, "p1")).toEqual(DEFAULT_AUTHORITY_POLICY);
  });

  it("applies the project's departures and inherits the rest", () => {
    ctx = openTestDb();
    insertProject(ctx.db, testProject({ id: "p1" }));
    ctx.db
      .prepare("UPDATE projects SET authority_policy = ? WHERE id = 'p1'")
      .run(JSON.stringify({ enforcement: "enforce" }));

    const policy = getProjectAuthorityPolicy(ctx.db, "p1");
    expect(policy.enforcement).toBe("enforce");
    // Everything unsaid still comes from the defaults, which is what lets a
    // changed default reach every project that never disagreed with it.
    expect(policy.judgmentMode).toBe(DEFAULT_AUTHORITY_POLICY.judgmentMode);
    expect(policy.actors).toEqual(DEFAULT_AUTHORITY_POLICY.actors);
  });

  it("splices a project's extra coordination verb onto the defaults", () => {
    ctx = openTestDb();
    insertProject(ctx.db, testProject({ id: "p1" }));
    ctx.db
      .prepare("UPDATE projects SET authority_policy = ? WHERE id = 'p1'")
      .run(JSON.stringify({ actors: { session: { coordinationVerbs: ["$defaults", "x.y"] } } }));

    expect(getProjectAuthorityPolicy(ctx.db, "p1").actors.session.coordinationVerbs).toEqual([
      ...DEFAULT_AUTHORITY_POLICY.actors.session.coordinationVerbs,
      "x.y",
    ]);
  });

  it("inherits rather than throwing when the column was edited into nonsense", () => {
    ctx = openTestDb();
    insertProject(ctx.db, testProject({ id: "p1" }));
    // Valid JSON, so the CHECK passes; not the shape the document means.
    ctx.db.prepare("UPDATE projects SET authority_policy = '[1,2]' WHERE id = 'p1'").run();

    // This runs on the attach path, where a throw costs a Session its
    // attachment. Degrading to the defaults is the only honest answer.
    expect(getProjectAuthorityPolicy(ctx.db, "p1")).toEqual(DEFAULT_AUTHORITY_POLICY);
  });

  it("answers the defaults for a project that does not exist", () => {
    ctx = openTestDb();

    expect(getProjectAuthorityPolicy(ctx.db, "missing")).toEqual(DEFAULT_AUTHORITY_POLICY);
  });
});

/**
 * The write migration 025 was owed (VC-172). Every case here used to require
 * raw SQL, which is the whole reason the ticket exists.
 */
describe("updateProjectAuthorityPolicy", () => {
  it("records a departure and resolves it through the reader beside it", () => {
    ctx = openTestDb();
    insertProject(ctx.db, testProject({ id: "p1" }));

    const saved = updateProjectAuthorityPolicy(ctx.db, "p1", { enforcement: "enforce" }, 1000);

    // The row carries the DEPARTURE, unresolved — what the editing surface needs.
    expect(saved?.authorityPolicy).toEqual({ enforcement: "enforce" });
    // The attach path gets it resolved, with everything unsaid still inherited.
    const policy = getProjectAuthorityPolicy(ctx.db, "p1");
    expect(policy.enforcement).toBe("enforce");
    expect(policy.judgmentMode).toBe(DEFAULT_AUTHORITY_POLICY.judgmentMode);
    expect(policy.actors).toEqual(DEFAULT_AUTHORITY_POLICY.actors);
  });

  it("stores an empty override as NULL, indistinguishable from never having spoken", () => {
    ctx = openTestDb();
    insertProject(ctx.db, testProject({ id: "p1" }));
    updateProjectAuthorityPolicy(ctx.db, "p1", { enforcement: "enforce" }, 1000);

    updateProjectAuthorityPolicy(ctx.db, "p1", {}, 2000);

    // `updateProjectSkillModes`'s rule for this column. Two spellings of one
    // state is a difference something eventually depends on by accident.
    expect(ctx.db.prepare("SELECT authority_policy FROM projects WHERE id = 'p1'").get()).toEqual({
      authority_policy: null,
    });
    expect(getProjectById(ctx.db, "p1")?.authorityPolicy).toBeNull();
    expect(getProjectAuthorityPolicy(ctx.db, "p1")).toEqual(DEFAULT_AUTHORITY_POLICY);
  });

  it("clears every departure on null, returning the project to the defaults", () => {
    ctx = openTestDb();
    insertProject(ctx.db, testProject({ id: "p1" }));
    updateProjectAuthorityPolicy(ctx.db, "p1", { enforcement: "off" }, 1000);

    const cleared = updateProjectAuthorityPolicy(ctx.db, "p1", null, 2000);

    expect(cleared?.authorityPolicy).toBeNull();
    expect(getProjectAuthorityPolicy(ctx.db, "p1")).toEqual(DEFAULT_AUTHORITY_POLICY);
  });

  it("normalises rather than trusting, so an unknown key never reaches the column", () => {
    ctx = openTestDb();
    insertProject(ctx.db, testProject({ id: "p1" }));

    // The IPC handler validates and would have refused this. The repo still
    // does not store it: a caller that skipped the check must not be able to
    // park a key in the column for the reader to drop forever after.
    const saved = updateProjectAuthorityPolicy(
      ctx.db,
      "p1",
      { enforcement: "enforce", enforcment: "off" } as never,
      1000,
    );

    expect(saved?.authorityPolicy).toEqual({ enforcement: "enforce" });
  });

  it("survives the round trip that the $defaults splice depends on", () => {
    ctx = openTestDb();
    insertProject(ctx.db, testProject({ id: "p1" }));

    updateProjectAuthorityPolicy(
      ctx.db,
      "p1",
      { actors: { session: { coordinationVerbs: ["$defaults", "deploy.run"] } } },
      1000,
    );

    // The additive-inheritance design, finally exercisable without raw SQL.
    expect(getProjectAuthorityPolicy(ctx.db, "p1").actors.session.coordinationVerbs).toEqual([
      ...DEFAULT_AUTHORITY_POLICY.actors.session.coordinationVerbs,
      "deploy.run",
    ]);
  });

  it("bumps row_version so a concurrent reader sees the row changed", () => {
    ctx = openTestDb();
    insertProject(ctx.db, testProject({ id: "p1" }));
    const before = ctx.db.prepare("SELECT row_version FROM projects WHERE id = 'p1'").get() as {
      row_version: number;
    };

    updateProjectAuthorityPolicy(ctx.db, "p1", { enforcement: "enforce" }, 1000);

    const after = ctx.db
      .prepare("SELECT row_version, updated_at FROM projects WHERE id = 'p1'")
      .get() as { row_version: number; updated_at: number };
    expect(after.row_version).toBe(before.row_version + 1);
    expect(after.updated_at).toBe(1000);
  });

  it("answers undefined for a project that does not exist", () => {
    ctx = openTestDb();

    expect(updateProjectAuthorityPolicy(ctx.db, "missing", {}, 1000)).toBeUndefined();
  });
});
