import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rehearsalUiPlan, containCopiedPaths } from "../rehearsal-ui.mjs";
import Database from "better-sqlite3";
import { electronExtraEnv, supervisorEnv } from "./core.mjs";

test("a copied-profile UI check stays inside the existing harness and cannot change target", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "move-ui-plan-")));
  const copy = join(root, "profile");
  await mkdir(copy);
  const deployment = { name: "staging", convexUrl: "https://staging.convex.cloud" };
  await writeFile(
    `${copy}.rehearsal.json`,
    JSON.stringify({ profile: copy, target: deployment.convexUrl, uiReady: true }),
  );
  try {
    const { layout } = await rehearsalUiPlan(copy, deployment);
    assert.equal(layout.userDataDir, copy);
    assert.equal(layout.dbPath, join(copy, "volli.db"));
    await writeFile(
      `${copy}.rehearsal.json`,
      JSON.stringify({ profile: copy, target: deployment.convexUrl, uiReady: false }),
    );
    await assert.rejects(rehearsalUiPlan(copy, deployment));
    const alias = join(root, "alias");
    await symlink(root, alias);
    const aliasedCopy = join(alias, "profile");
    await writeFile(
      `${copy}.rehearsal.json`,
      JSON.stringify({ profile: aliasedCopy, target: deployment.convexUrl, uiReady: true }),
    );
    assert.equal((await rehearsalUiPlan(aliasedCopy, deployment)).layout.userDataDir, copy);
    // Real migrations, real FK restrictions (not hand-made table stand-ins).
    execFileSync(
      process.execPath,
      [
        "--experimental-transform-types",
        fileURLToPath(
          new URL(
            "../../../../../packages/host-core/scripts/migration-dry-run-fixture.mjs",
            import.meta.url,
          ),
        ),
        copy,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const db = new Database(layout.dbPath);
    db.pragma("foreign_keys = ON");
    db.exec(`UPDATE projects SET path='/owner/real-repo' WHERE id=(SELECT id FROM projects LIMIT 1);
      UPDATE tickets SET worktree_path='/owner/worktree';
      INSERT INTO project_checkout_paths VALUES ('repo','project','runner','/owner/checkout','main',1);
      INSERT INTO working_copy_paths (ticket_id,project_repo_id,runner_id,abs_path) VALUES ('ticket','repo','runner','/owner/worktree');
      INSERT INTO spawned_processes (id,session_id,kind,pid,started_at,cwd,command) VALUES ('spawn','session','shell',12345,1,'/owner/real-repo','test');
      INSERT INTO worktree_cleanup_commands VALUES ('cleanup','{}',1);
      INSERT INTO worktree_cleanup_facts VALUES ('fact','cleanup','test','{}',1);
      INSERT INTO worktree_cleanup_receipts VALUES ('receipt','cleanup','completed',NULL,NULL,1);
      INSERT INTO app_state VALUES ('volli:orphan-processes','{"enabled":true}',1);
      CREATE TRIGGER refuse_cleanup BEFORE DELETE ON worktree_cleanup_facts BEGIN SELECT RAISE(ABORT,'test atomic scrub'); END;`);
    db.close();
    await assert.rejects(containCopiedPaths(layout));
    const retry = new Database(layout.dbPath);
    assert.equal(
      retry.prepare("SELECT COUNT(*) FROM projects WHERE path='/owner/real-repo'").pluck().get(),
      1,
    );
    assert.equal(retry.prepare("SELECT COUNT(*) FROM worktree_cleanup_commands").pluck().get(), 1);
    retry.exec("DROP TRIGGER refuse_cleanup");
    retry.close();
    await containCopiedPaths(layout);
    const checked = new Database(layout.dbPath);
    try {
      assert.ok(
        checked
          .prepare("SELECT path FROM projects")
          .pluck()
          .get()
          .startsWith(`${root}/ui-projects-`),
      );
      assert.equal(
        checked
          .prepare("SELECT COUNT(*) FROM tickets WHERE worktree_path IS NOT NULL")
          .pluck()
          .get(),
        0,
      );
      for (const table of [
        "project_checkout_paths",
        "working_copy_paths",
        "spawned_processes",
        "worktree_cleanup_commands",
        "worktree_cleanup_facts",
        "worktree_cleanup_receipts",
      ])
        assert.equal(checked.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get(), 0);
      assert.equal(
        checked
          .prepare("SELECT COUNT(*) FROM app_state WHERE key='volli:orphan-processes'")
          .pluck()
          .get(),
        0,
      );
      assert.deepEqual(checked.pragma("foreign_key_check"), []);
    } finally {
      checked.close();
    }
    const env = {
      ...supervisorEnv({
        VOLLI_MOVE_TOKEN: "secret",
        VOLLI_MOVE_ADMIN_KEY: "secret",
        HOME: "/owner",
        SSH_AUTH_SOCK: "/owner/agent",
      }),
      ...electronExtraEnv(layout, { loginShell: "/bin/sh", path: "/usr/bin" }),
    };
    assert.equal(env.VOLLI_HARNESS, "1");
    assert.equal(env.VOLLI_HARNESS_SCRATCH, root);
    assert.equal(env.HOME, join(root, "home"));
    assert.equal(env.VOLLI_MOVE_TOKEN, undefined);
    assert.equal(env.VOLLI_MOVE_ADMIN_KEY, undefined);
    assert.equal(env.SSH_AUTH_SOCK, undefined);
    await assert.rejects(rehearsalUiPlan(copy, { ...deployment, name: "prod" }));
    await assert.rejects(
      rehearsalUiPlan(copy, { ...deployment, convexUrl: "https://another.convex.cloud" }),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
