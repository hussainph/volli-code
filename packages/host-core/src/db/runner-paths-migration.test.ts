import { describe, expect, it } from "vite-plus/test";

import { applyRunnerPathsMigration } from "./runner-paths-migration";
import { MIGRATIONS } from "./migrations";
import { RUNNER_DRAIN_MIGRATION } from "./runner-drain-migration";
import { readMinReaderVersion } from "./schema-compatibility";
import { insertProject } from "./projects-repo";
import { insertTicket } from "./tickets-repo";
import { openRawDb, openTestDb, testProject, testTicket } from "./test-helpers";

describe("runner path migration", () => {
  it("is expand-only, rerunnable and keeps frozen rows and reader floor intact", () => {
    const ctx = openTestDb();
    try {
      insertProject(ctx.db, testProject({ id: "project" }));
      insertTicket(ctx.db, testTicket("project", { id: "ticket" }));
      const before = {
        projects: ctx.db.prepare("SELECT * FROM projects").all(),
        tickets: ctx.db.prepare("SELECT * FROM tickets").all(),
        floor: readMinReaderVersion(ctx.db),
      };
      applyRunnerPathsMigration(ctx.db);
      applyRunnerPathsMigration(ctx.db);
      expect(MIGRATIONS.find(({ version }) => version === 66)?.raisesMinReader).toBeUndefined();
      expect({
        projects: ctx.db.prepare("SELECT * FROM projects").all(),
        tickets: ctx.db.prepare("SELECT * FROM tickets").all(),
        floor: readMinReaderVersion(ctx.db),
      }).toEqual(before);
      expect(before.floor).toBe(58);
      expect(ctx.db.pragma("table_info(job_journal)")).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: "owner_user_id", notnull: 0 })]),
      );
      for (const table of ["project_checkout_paths", "working_copy_paths", "cloud_shadow_rows"]) {
        expect(ctx.db.pragma(`foreign_key_list(${table})`)).toEqual([]);
      }
    } finally {
      ctx.cleanup();
    }
  });

  it("accepts cloud-only identities, enforces natural keys and isolates runners", () => {
    const ctx = openTestDb();
    try {
      ctx.db
        .prepare(
          "INSERT INTO project_checkout_paths (project_repo_id,project_id,runner_id,abs_path,kind,adopted_from_frozen) VALUES ('repo','project','runner','/main','main',0)",
        )
        .run();
      ctx.db
        .prepare(
          "INSERT INTO working_copy_paths (working_copy_id,ticket_id,project_repo_id,runner_id,abs_path,adopted_from_frozen) VALUES (NULL,'ticket','repo','runner','/copy',0)",
        )
        .run();
      expect(() =>
        ctx.db
          .prepare(
            "INSERT INTO working_copy_paths (working_copy_id,ticket_id,project_repo_id,runner_id,abs_path,adopted_from_frozen) VALUES (NULL,'ticket','repo','runner','/other',0)",
          )
          .run(),
      ).toThrow();
      ctx.db
        .prepare(
          "INSERT INTO working_copy_paths (working_copy_id,ticket_id,project_repo_id,runner_id,abs_path,adopted_from_frozen) VALUES (NULL,'ticket','repo','other-runner','/other',0)",
        )
        .run();
      ctx.db
        .prepare(
          "INSERT INTO cloud_shadow_rows (kind,id,owner_user_id) VALUES ('project','project','owner')",
        )
        .run();
      ctx.db
        .prepare(
          "INSERT INTO cloud_shadow_rows (kind,id,owner_user_id) VALUES ('ticket','ticket','owner')",
        )
        .run();
      expect(ctx.db.prepare("SELECT kind FROM working_copy_paths").all()).toEqual([
        { kind: "worktree" },
        { kind: "worktree" },
      ]);
      ctx.db
        .prepare(
          "INSERT INTO working_copy_paths (ticket_id,project_repo_id,runner_id,abs_path,kind) VALUES ('main-ticket','repo','runner','/main','main_checkout')",
        )
        .run();
      expect(() =>
        ctx.db
          .prepare(
            "INSERT INTO working_copy_paths (ticket_id,project_repo_id,runner_id,abs_path,kind) VALUES ('invalid','repo','runner','/invalid','invalid')",
          )
          .run(),
      ).toThrow();
      expect(ctx.db.pragma("foreign_key_check")).toEqual([]);
      expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM projects").get()).toEqual({ n: 0 });
    } finally {
      ctx.cleanup();
    }
  });

  it("probe-adds the default worktree kind without changing pre-existing path rows", () => {
    const db = openRawDb(":memory:");
    try {
      db.exec(RUNNER_DRAIN_MIGRATION);
      db.exec(`CREATE TABLE working_copy_paths (
        working_copy_id TEXT, ticket_id TEXT NOT NULL, project_repo_id TEXT NOT NULL,
        runner_id TEXT NOT NULL, abs_path TEXT NOT NULL,
        adopted_from_frozen INTEGER NOT NULL DEFAULT 0,
        branch TEXT, base_branch TEXT, head_sha TEXT,
        PRIMARY KEY (runner_id,ticket_id,project_repo_id)
      );`);
      db.prepare(
        "INSERT INTO working_copy_paths (ticket_id,project_repo_id,runner_id,abs_path,branch) VALUES ('ticket','repo','runner','/copy','volli/VC-1-original')",
      ).run();
      applyRunnerPathsMigration(db);
      applyRunnerPathsMigration(db);
      expect(db.prepare("SELECT abs_path,branch,kind FROM working_copy_paths").all()).toEqual([
        { abs_path: "/copy", branch: "volli/VC-1-original", kind: "worktree" },
      ]);
    } finally {
      db.close();
    }
  });
});
