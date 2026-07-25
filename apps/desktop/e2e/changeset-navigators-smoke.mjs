/**
 * Focused smoke for the VC-108 Change Set navigators.
 *
 * Seeds a real ticket worktree with committed / staged / dirty / renamed /
 * deleted / untracked / binary changes — plus a path with a space and a
 * non-ASCII character — then asserts:
 *   1. The Changes flat list renders each status honestly.
 *   2. Clicking a row opens (or focuses) a file tab.
 *   3. A filesystem change refreshes rows WITHOUT opening a tab or moving focus.
 *   4. The Files navigator lists worktree entries and body refs.
 *
 * Also captures nav-* screenshots under /tmp/vc108-shots/.
 *
 *   env -u ELECTRON_RUN_AS_NODE node apps/desktop/e2e/changeset-navigators-smoke.mjs
 *
 * MANUALLY-RUN (needs a display + the built app); NOT wired into `vp test`.
 */
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

import { createTicketViaBridge } from "./lib/agent-kit.mjs";
import {
  assertProfileIsolated,
  createRunner,
  launch,
  makeGitRepo,
  makeScratch,
  readSeededProjects,
  seedProjects,
  sleep,
  waitUntil,
} from "./lib/smoke-kit.mjs";

const execFileAsync = promisify(execFile);
const SHOT_DIR = "/tmp/vc108-shots";

const { scratch, userDataDir, dbPath, cleanup } = await makeScratch("volli-changeset-nav-");
const { attempt, summarize } = createRunner();

const PROJECT = { id: "changeset-nav-proj", name: "Changeset Nav", prefix: "CN" };
const DEFAULT_HARNESS_ID = "claude-code";

async function git(cwd, args) {
  return execFileAsync("git", args, { cwd });
}

async function main() {
  const fakeHome = join(scratch, "home");
  await fs.mkdir(fakeHome, { recursive: true });
  await fs.mkdir(SHOT_DIR, { recursive: true });

  const app = await launch({
    dbPath,
    userDataDir,
    extraEnv: { VOLLI_WORKTREE_HOME_DIR: fakeHome },
  });

  try {
    await assertProfileIsolated(app, userDataDir);
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await sleep(800);

    const projectPath = await makeGitRepo(scratch, "changeset-nav-");
    // Seed files that later become deleted / renamed / modified in the worktree.
    await fs.mkdir(join(projectPath, "src"), { recursive: true });
    await fs.writeFile(join(projectPath, "src", "keep.ts"), "export const keep = 1;\n");
    await fs.writeFile(join(projectPath, "src", "old-name.ts"), "export const old = 1;\n");
    await fs.writeFile(join(projectPath, "src", "gone.ts"), "export const gone = 1;\n");
    await fs.writeFile(join(projectPath, "src", "edit-me.ts"), "export const v = 1;\n");
    await git(projectPath, ["add", "-A"]);
    await git(projectPath, ["commit", "-q", "-m", "seed files"]);

    await seedProjects(page, [{ ...PROJECT, path: projectPath }]);
    const { byName } = await readSeededProjects(page);
    const projectId = byName[PROJECT.name]?.id;
    if (!projectId) throw new Error("seeded project missing after import");

    async function ticketRow(ticketId) {
      const tickets = await page.evaluate(async (pid) => {
        const boot = await window.api.data.bootstrap();
        if (!boot.ok) return [];
        return boot.data.ticketsByProject?.[pid] ?? [];
      }, projectId);
      return tickets.find((t) => t.id === ticketId);
    }

    const { ticketId, displayId } = await createTicketViaBridge(page, PROJECT.name, {
      status: "todo",
      title: "Change Set navigator proof",
      priority: "medium",
    });
    await page.evaluate(
      async ({ tid }) => {
        const res = await window.api.tickets.update({
          ticketId: tid,
          body: "See @src/keep.ts for the referenced context path.",
        });
        if (!res.ok) throw new Error(res.error);
      },
      { tid: ticketId },
    );

    // Materialize the worktree via session ensure (same path as done-flow).
    const createResult = await page.evaluate(
      ({ workspaceId, cwd, tid, harnessId }) =>
        window.api.terminal.create({
          workspaceId,
          cwd,
          cols: 80,
          rows: 24,
          ticket: { ticketId: tid, kickoff: { harnessId, prompt: "smoke" } },
        }),
      {
        workspaceId: projectId,
        cwd: projectPath,
        tid: ticketId,
        harnessId: DEFAULT_HARNESS_ID,
      },
    );
    if (!createResult.ok) throw new Error(`terminal.create failed: ${createResult.error}`);

    const row = await waitUntil(
      "ticket row stamped with worktreePath",
      async () => {
        const r = await ticketRow(ticketId);
        return r?.worktreePath ? r : null;
      },
      { timeout: 30000 },
    );
    const worktreeDir = row.worktreePath;

    // ---- Build a realistic Change Set mix inside the live worktree ----------
    // Committed (relative to base): new file on a follow-up commit.
    await fs.writeFile(join(worktreeDir, "src", "committed.ts"), "export const c = 1;\n");
    await git(worktreeDir, ["add", "src/committed.ts"]);
    await git(worktreeDir, ["commit", "-q", "-m", "feat: committed change"]);

    // Staged.
    await fs.writeFile(join(worktreeDir, "src", "staged.ts"), "export const s = 1;\n");
    await git(worktreeDir, ["add", "src/staged.ts"]);

    // Dirty / unstaged modify.
    await fs.writeFile(join(worktreeDir, "src", "edit-me.ts"), "export const v = 2;\n");

    // Renamed.
    await git(worktreeDir, ["mv", "src/old-name.ts", "src/new-name.ts"]);

    // Deleted (staged).
    await git(worktreeDir, ["rm", "-q", "src/gone.ts"]);

    // Binary tracked addition — numstat emits -/- so the row shows "Binary".
    await fs.mkdir(join(worktreeDir, "assets"), { recursive: true });
    await fs.writeFile(
      join(worktreeDir, "assets", "logo.png"),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]),
    );
    await git(worktreeDir, ["add", "assets/logo.png"]);

    // Untracked + path with space + non-ASCII (nested; requires status -uall).
    await fs.mkdir(join(worktreeDir, "docs"), { recursive: true });
    await fs.writeFile(join(worktreeDir, "docs", "café notes.md"), "# café\n");

    // ---- Open ticket detail -------------------------------------------------
    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    await waitUntil("app surface", () =>
      page.evaluate(() => document.querySelector("[data-volli-surface]") !== null),
    );

    const card = page.locator("article").filter({
      has: page.locator("span.font-mono", { hasText: new RegExp(`^${displayId}$`) }),
    });
    await waitUntil("card", async () => (await card.count()) === 1);
    await card.dblclick();
    await waitUntil("detail", async () => (await page.getByRole("tablist").count()) >= 1);

    const aside = page.locator("aside");
    await waitUntil("rail visible", async () => (await aside.count()) === 1);

    // ---- 1. Changes list renders the mix ------------------------------------
    await attempt(
      1,
      "Changes flat list renders status mix including space/non-ASCII path",
      async () => {
        await aside.getByTestId("ticket-rail-mode-changes").click();
        await waitUntil(
          "changes panel",
          async () => (await aside.getByTestId("ticket-changes-list").count()) === 1,
          {
            timeout: 15000,
          },
        );

        const text = await aside.getByTestId("ticket-changes-list").innerText();
        const needed = [
          "committed.ts",
          "staged.ts",
          "edit-me.ts",
          "new-name.ts",
          "gone.ts",
          "café notes.md",
          "logo.png",
          "Binary",
        ];
        const missing = needed.filter((n) => !text.includes(n));
        // Rename prior path should surface.
        const hasRenameFrom = text.includes("old-name.ts") || text.includes("←");
        return {
          ok: missing.length === 0 && hasRenameFrom,
          detail: missing.length
            ? `missing: ${missing.join(", ")}`
            : hasRenameFrom
              ? "all statuses present"
              : "rename previous path missing",
        };
      },
    );

    // ---- 2. Click opens a file tab ------------------------------------------
    await attempt(2, "clicking a Changes row opens a file tab", async () => {
      const beforeTabs = await page.getByRole("tab").allTextContents();
      const rowBtn = aside.locator(
        '[data-testid="ticket-changes-row"][data-path="src/edit-me.ts"]',
      );
      await waitUntil("edit-me row", async () => (await rowBtn.count()) === 1);
      await rowBtn.click();
      await waitUntil(
        "file tab for edit-me.ts",
        async () => (await page.getByRole("tab", { name: "edit-me.ts" }).count()) === 1,
      );
      const afterTabs = await page.getByRole("tab").allTextContents();
      return {
        ok: afterTabs.some((t) => t.includes("edit-me.ts")),
        detail: `before=${beforeTabs.length} after=${afterTabs.length}`,
      };
    });

    // ---- 3. Refresh never opens a tab / steals focus ------------------------
    await attempt(3, "filesystem change refreshes rows without opening a tab", async () => {
      // Focus stays on the Changes list (decision #48) — leave keyboard on the row.
      const rowBtn = aside.locator(
        '[data-testid="ticket-changes-row"][data-path="src/edit-me.ts"]',
      );
      await rowBtn.focus();

      const tabsBefore = await page.getByRole("tab").allTextContents();
      const activeBefore = await page.evaluate(() => {
        const active = document.querySelector('[role="tab"][aria-selected="true"]');
        return active?.textContent ?? null;
      });
      const focusedBefore = await page.evaluate(
        () => document.activeElement?.getAttribute("data-path") ?? document.activeElement?.tagName,
      );

      // Touch the worktree — debounced onChanged (250ms) should refresh the list.
      await fs.writeFile(join(worktreeDir, "src", "fresh-untracked.ts"), "export const f = 1;\n");

      await waitUntil(
        "fresh-untracked appears in Changes",
        async () => {
          const text = await aside.getByTestId("ticket-changes-list").innerText();
          return text.includes("fresh-untracked.ts");
        },
        { timeout: 10000 },
      );

      const tabsAfter = await page.getByRole("tab").allTextContents();
      const activeAfter = await page.evaluate(() => {
        const active = document.querySelector('[role="tab"][aria-selected="true"]');
        return active?.textContent ?? null;
      });
      const focusedAfter = await page.evaluate(
        () => document.activeElement?.getAttribute("data-path") ?? document.activeElement?.tagName,
      );

      const sameTabCount = tabsBefore.length === tabsAfter.length;
      const sameActive = activeBefore === activeAfter;
      const noNewFileTab = !tabsAfter.some(
        (t) =>
          t.includes("fresh-untracked") && !tabsBefore.some((b) => b.includes("fresh-untracked")),
      );
      // Focus must not jump into the editor; list focus (or at least not monaco) is fine.
      const focusOk =
        focusedAfter === "src/edit-me.ts" ||
        focusedAfter === focusedBefore ||
        focusedAfter === "BUTTON";

      return {
        ok: sameTabCount && sameActive && noNewFileTab && focusOk,
        detail: `tabs ${tabsBefore.length}→${tabsAfter.length}; active ${activeBefore}→${activeAfter}; focus ${focusedBefore}→${focusedAfter}`,
      };
    });

    // ---- 4. Files navigator -------------------------------------------------
    await attempt(4, "Files navigator lists referenced context and worktree files", async () => {
      await aside.getByTestId("ticket-rail-mode-files").click();
      await waitUntil(
        "files list loaded",
        async () => {
          if ((await aside.getByTestId("ticket-files-loading").count()) === 1) return false;
          return (await aside.getByTestId("ticket-files-list").count()) === 1;
        },
        { timeout: 10000 },
      );
      await waitUntil(
        "worktree root listing",
        async () => {
          const text = await aside.getByTestId("ticket-files-list").innerText();
          return text.includes("README") || text.includes("src");
        },
        { timeout: 10000 },
      );
      const text = await aside.getByTestId("ticket-files-list").innerText();
      const hasRef = text.includes("keep.ts") || text.includes("Referenced");
      const hasWorktree =
        text.includes("Worktree") && (text.includes("src") || text.includes("README"));
      return { ok: hasRef && hasWorktree, detail: text.slice(0, 200) };
    });

    // ---- Screenshots --------------------------------------------------------
    await attempt("shot-changes", "screenshot nav-changes.png", async () => {
      await aside.getByTestId("ticket-rail-mode-changes").click();
      await waitUntil(
        "changes list",
        async () => (await aside.getByTestId("ticket-changes-list").count()) === 1,
      );
      await sleep(400);
      const path = join(SHOT_DIR, "nav-changes.png");
      await page.screenshot({ path, fullPage: false });
      const stat = await fs.stat(path);
      return { ok: stat.size > 1000, detail: path };
    });

    await attempt("shot-files", "screenshot nav-files.png", async () => {
      await aside.getByTestId("ticket-rail-mode-files").click();
      await waitUntil(
        "files list",
        async () => (await aside.getByTestId("ticket-files-list").count()) === 1,
      );
      await sleep(300);
      const path = join(SHOT_DIR, "nav-files.png");
      await page.screenshot({ path, fullPage: false });
      const stat = await fs.stat(path);
      return { ok: stat.size > 1000, detail: path };
    });

    await attempt("shot-mode", "screenshot nav-mode-strip-active.png", async () => {
      await aside.getByTestId("ticket-rail-mode-changes").click();
      await sleep(200);
      const path = join(SHOT_DIR, "nav-mode-strip-active.png");
      // Crop to the aside so the mode strip is readable.
      const box = await aside.boundingBox();
      await page.screenshot({
        path,
        clip: box ?? undefined,
      });
      const stat = await fs.stat(path);
      return { ok: stat.size > 500, detail: path };
    });
  } finally {
    await app.close().catch(() => {});
    await cleanup();
  }

  process.exit(summarize());
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
