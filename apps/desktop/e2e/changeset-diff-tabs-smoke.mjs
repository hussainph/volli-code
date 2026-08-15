/**
 * Focused smoke for VC-109 Monaco Diff tabs (Change Set → Diff tab integration).
 *
 * Seeds a real ticket worktree with committed / staged / dirty / renamed /
 * deleted / untracked / binary changes, then asserts:
 *   1. Changes list renders each status honestly.
 *   2. Clicking a modified row opens ONE `diff:<relPath>` tab (not `file:`);
 *      re-click focuses, never duplicates.
 *   3. Monaco DiffEditor mounts (`data-monaco-diff-status="ready"` +
 *      `.monaco-diff-editor`) with visible original/modified content.
 *   4. Editing the modified side marks the Diff tab dirty.
 *   5. Opening the same path via Files shares the model (same edit + dirty).
 *   6. ⌘S clears dirty on both representations and writes disk.
 *   7. Filesystem Change Set refresh never auto-opens a tab.
 *   8. (cheap) Side-by-side presentation toggle flips layout without a new tab.
 *
 * Also captures shots under /tmp/vc109-shots/.
 *
 *   env -u ELECTRON_RUN_AS_NODE node apps/desktop/e2e/changeset-diff-tabs-smoke.mjs
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
  clickMonaco,
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
const SHOT_DIR = "/tmp/vc109-shots";
const EDIT_MARKER = "// VC109-DIFF-EDIT";
const TARGET = "src/edit-me.ts";

const { scratch, userDataDir, dbPath, cleanup } = await makeScratch("volli-changeset-diff-");
const { attempt, summarize } = createRunner();

const PROJECT = { id: "changeset-diff-proj", name: "Changeset Diff", prefix: "CD" };
const DEFAULT_HARNESS_ID = "claude-code";

async function git(cwd, args) {
  return execFileAsync("git", args, { cwd });
}

/** Persisted ticket tab strip for `ticketId` from workspace app state. */
async function readTicketTabs(page, ticketId) {
  return page.evaluate(async (tid) => {
    const boot = await window.api.data.bootstrap();
    if (!boot.ok) return null;
    const raw = boot.data.appState["volli:workspace"];
    if (typeof raw !== "string") return null;
    const parsed = JSON.parse(raw);
    for (const ui of Object.values(parsed?.state?.byProject ?? {})) {
      const tabs = ui?.ticketTabs?.[tid];
      if (tabs) return tabs;
    }
    return null;
  }, ticketId);
}

/** Current persisted File tabs are objects; accept legacy string entries too. */
function persistedFilesInclude(files, relPath) {
  return files.some((entry) =>
    typeof entry === "string" ? entry === relPath : entry?.relPath === relPath,
  );
}

async function readDiffMonaco(page) {
  return page.evaluate(() => {
    const host = document.querySelector("[data-monaco-diff-status]");
    if (!host) {
      return {
        hostCount: 0,
        status: null,
        dirty: null,
        saving: null,
        readOnly: null,
        role: null,
        ariaLabel: null,
        hasDiffEditor: false,
        lines: "",
        sideBySide: null,
      };
    }
    const diffEditor = host.querySelector(".monaco-diff-editor");
    // Prefer the modified pane's view-lines when present; fall back to all lines.
    const modifiedRoot =
      host.querySelector(".editor.modified .monaco-editor") ??
      host.querySelector(".monaco-editor.modified") ??
      [...host.querySelectorAll(".monaco-editor")].at(-1) ??
      null;
    const linesRoot = modifiedRoot ?? host;
    const lines = Array.from(linesRoot.querySelectorAll(".view-line"))
      .map((line) => (line.textContent ?? "").replace(/\u00a0/g, " "))
      .join("\n");
    const sideBySide =
      diffEditor?.classList.contains("side-by-side") ||
      getComputedStyle(diffEditor ?? host).getPropertyValue("--monaco-diff-side-by-side") === "true"
        ? true
        : diffEditor !== null
          ? diffEditor.classList.contains("side-by-side")
          : null;
    return {
      hostCount: document.querySelectorAll("[data-monaco-diff-status]").length,
      status: host.getAttribute("data-monaco-diff-status"),
      dirty: host.getAttribute("data-monaco-diff-dirty"),
      saving: host.getAttribute("data-monaco-diff-saving"),
      readOnly: host.getAttribute("data-monaco-diff-read-only"),
      role: host.getAttribute("role"),
      ariaLabel: host.getAttribute("aria-label"),
      presentation: host.getAttribute("data-monaco-diff-presentation"),
      hasDiffEditor: diffEditor !== null,
      lines,
      // Monaco toggles `.side-by-side` on the root when renderSideBySide is on.
      sideBySideClass: diffEditor?.classList.contains("side-by-side") ?? false,
      sideBySide,
    };
  });
}

async function waitDiffReady(page, needle = null) {
  return waitUntil(
    needle ? `diff Monaco ready with ${JSON.stringify(needle)}` : "diff Monaco ready",
    async () => {
      const state = await readDiffMonaco(page);
      if (state.status !== "ready" || !state.hasDiffEditor) return null;
      if (needle !== null && !state.lines.includes(needle)) return null;
      return state;
    },
    { timeout: 20000 },
  );
}

/** Click the modified DiffEditor pane and type `text`, waiting for it to land. */
async function typeIntoDiffModified(page, text) {
  const host = page.locator('[data-monaco-diff-status="ready"]').first();
  await waitUntil("diff host ready for type", async () => (await host.count()) === 1);
  // Modified pane: last monaco-editor under the diff host (inline + side-by-side).
  const modified = host.locator(".monaco-editor").last();
  await modified.click();
  await page.keyboard.press("Meta+ArrowUp");
  await page.keyboard.press("Home");
  await page.keyboard.type(text);
  await page.keyboard.press("Enter");
  await waitUntil(`diff typed ${JSON.stringify(text)}`, async () => {
    const state = await readDiffMonaco(page);
    return state.lines.includes(text) ? state : null;
  });
}

async function readFileMonaco(page) {
  return page.evaluate(() => {
    const host = document.querySelector("[data-monaco-status]");
    if (!host) {
      return { hostCount: 0, status: null, dirty: null, lines: "", hasEditor: false };
    }
    const editor = host.querySelector(".monaco-editor");
    return {
      hostCount: document.querySelectorAll("[data-monaco-status]").length,
      status: host.getAttribute("data-monaco-status"),
      dirty: host.getAttribute("data-monaco-dirty"),
      lines: Array.from(editor?.querySelectorAll(".view-line") ?? [])
        .map((line) => (line.textContent ?? "").replace(/\u00a0/g, " "))
        .join("\n"),
      hasEditor: editor !== null,
    };
  });
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

    const projectPath = await makeGitRepo(scratch, "changeset-diff-");
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
      title: "Change Set Diff tab proof",
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

    // ---- Seed Change Set mix ------------------------------------------------
    await fs.writeFile(join(worktreeDir, "src", "committed.ts"), "export const c = 1;\n");
    await git(worktreeDir, ["add", "src/committed.ts"]);
    await git(worktreeDir, ["commit", "-q", "-m", "feat: committed change"]);

    await fs.writeFile(join(worktreeDir, "src", "staged.ts"), "export const s = 1;\n");
    await git(worktreeDir, ["add", "src/staged.ts"]);

    await fs.writeFile(join(worktreeDir, "src", "edit-me.ts"), "export const v = 2;\n");

    await git(worktreeDir, ["mv", "src/old-name.ts", "src/new-name.ts"]);
    await git(worktreeDir, ["rm", "-q", "src/gone.ts"]);

    await fs.mkdir(join(worktreeDir, "assets"), { recursive: true });
    await fs.writeFile(
      join(worktreeDir, "assets", "logo.png"),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]),
    );
    await git(worktreeDir, ["add", "assets/logo.png"]);

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

    // ---- 1. Changes list ----------------------------------------------------
    await attempt(1, "Changes flat list renders status mix", async () => {
      await aside.getByTestId("ticket-rail-tab-changes").click();
      await waitUntil(
        "changes panel",
        async () => (await aside.getByTestId("ticket-changes-list").count()) === 1,
        { timeout: 15000 },
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
      const hasRenameFrom = text.includes("old-name.ts") || text.includes("←");
      return {
        ok: missing.length === 0 && hasRenameFrom,
        detail: missing.length
          ? `missing: ${missing.join(", ")}`
          : hasRenameFrom
            ? "all statuses present"
            : "rename previous path missing",
      };
    });

    // ---- 2. Open ONE Diff tab; re-click focuses ------------------------------
    await attempt(2, "Changes row opens one Diff tab; re-click does not duplicate", async () => {
      const rowBtn = aside.locator(`[data-testid="ticket-changes-row"][data-path="${TARGET}"]`);
      await waitUntil("edit-me row", async () => (await rowBtn.count()) === 1);
      await rowBtn.click();

      const opened = await waitUntil(
        "diff:src/edit-me.ts active",
        async () => {
          const tabs = await readTicketTabs(page, ticketId);
          if (!tabs) return null;
          const one =
            (tabs.diffs?.filter((p) => p === TARGET).length ?? 0) === 1 &&
            tabs.active === `diff:${TARGET}` &&
            !persistedFilesInclude(tabs.files ?? [], TARGET);
          const ui =
            (await page.getByTestId("ticket-diff-presentation").count()) === 1 &&
            (await page.locator('[data-monaco-diff-status="ready"]').count()) === 1;
          return one && ui ? tabs : null;
        },
        { timeout: 20000 },
      );

      await rowBtn.click();
      const after = await waitUntil(
        "still exactly one diff tab after re-click",
        async () => {
          const tabs = await readTicketTabs(page, ticketId);
          if (!tabs) return null;
          const count = tabs.diffs?.filter((p) => p === TARGET).length ?? 0;
          return count === 1 && tabs.active === `diff:${TARGET}` ? tabs : null;
        },
        { timeout: 10000 },
      );

      return {
        ok: !!opened && !!after,
        detail: `active=${opened?.active} diffs=${JSON.stringify(opened?.diffs)} files=${JSON.stringify(opened?.files)}`,
      };
    });

    // ---- 3. Diff contents visible -------------------------------------------
    await attempt(3, "Monaco DiffEditor shows original and modified contents", async () => {
      const state = await waitDiffReady(page, "export const v = 2");
      // Diff panes: original (v = 1) and modified (v = 2). `readDiffMonaco` prefers
      // modified view-lines but may still surface both in inline mode.
      const hostText = await page.locator("[data-monaco-diff-status]").innerText();
      const blob = `${state.lines}\n${hostText}`;
      const hasOriginal = blob.includes("export const v = 1") || /\bv\s*=\s*1\b/.test(blob);
      const hasModified = blob.includes("export const v = 2") || /\bv\s*=\s*2\b/.test(blob);
      const ok =
        state.status === "ready" &&
        state.hasDiffEditor &&
        state.hostCount === 1 &&
        state.role === "group" &&
        state.ariaLabel === "edit-me.ts diff" &&
        hasModified &&
        hasOriginal;
      return {
        ok,
        detail: `status=${state.status} diffEditor=${state.hasDiffEditor} label=${JSON.stringify(state.ariaLabel)} original=${hasOriginal} modified=${hasModified} lines=${JSON.stringify(state.lines.slice(0, 120))}`,
      };
    });

    // ---- 4. Edit modified side → dirty --------------------------------------
    await attempt(4, "editing Diff modified side marks Diff tab dirty", async () => {
      await typeIntoDiffModified(page, EDIT_MARKER);

      const dirty = await waitUntil(
        "diff host + tab dirty",
        async () => {
          const monaco = await readDiffMonaco(page);
          const dirtyDot = await page.getByTestId("tab-dirty").count();
          if (monaco.dirty === "true" && monaco.lines.includes(EDIT_MARKER) && dirtyDot >= 1) {
            return monaco;
          }
          return null;
        },
        { timeout: 15000 },
      );

      return {
        ok: !!dirty,
        detail: `dirty=${dirty?.dirty} hasMarker=${dirty?.lines.includes(EDIT_MARKER)}`,
      };
    });

    // ---- 5. File tab shares model + dirty -----------------------------------
    await attempt(5, "Files open of same path shares model content and dirty", async () => {
      await aside.getByTestId("ticket-rail-tab-files").click();
      await waitUntil(
        "files list",
        async () => (await aside.getByTestId("ticket-files-list").count()) === 1,
        { timeout: 10000 },
      );

      // Enter src/ then open edit-me.ts
      const srcDir = aside.locator('[data-testid="ticket-files-row"][data-path="src"]');
      await waitUntil("src dir row", async () => (await srcDir.count()) === 1, { timeout: 10000 });
      await srcDir.click();
      const fileRow = aside.locator(`[data-testid="ticket-files-row"][data-path="${TARGET}"]`);
      await waitUntil("edit-me file row", async () => (await fileRow.count()) === 1, {
        timeout: 10000,
      });
      await fileRow.click();

      const shared = await waitUntil(
        "file tab active with shared dirty edit",
        async () => {
          const tabs = await readTicketTabs(page, ticketId);
          if (!tabs) return null;
          const fileOpen = persistedFilesInclude(tabs.files ?? [], TARGET);
          const diffStill = (tabs.diffs ?? []).includes(TARGET);
          const activeFile = tabs.active === `file:${TARGET}`;
          const monaco = await readFileMonaco(page);
          const dirtyDot = await page.getByTestId("tab-dirty").count();
          if (
            fileOpen &&
            diffStill &&
            activeFile &&
            monaco.status === "ready" &&
            monaco.dirty === "true" &&
            monaco.lines.includes(EDIT_MARKER) &&
            dirtyDot >= 1
          ) {
            return { tabs, monaco };
          }
          return null;
        },
        { timeout: 20000 },
      );

      return {
        ok: !!shared,
        detail: shared
          ? `active=${shared.tabs.active} files=${JSON.stringify(shared.tabs.files)} diffs=${JSON.stringify(shared.tabs.diffs)} dirty=${shared.monaco.dirty}`
          : "shared model not observed",
      };
    });

    // ---- 6. ⌘S clears dirty on both representations -------------------------
    await attempt(6, "Meta+s clears dirty on file and Diff tabs and writes disk", async () => {
      // File tab should still be active from step 5 — focus Monaco so ⌘S hits the
      // editor action (focus may still be on the Files list after the row click).
      const tabsNow = await readTicketTabs(page, ticketId);
      if (tabsNow?.active !== `file:${TARGET}`) {
        await aside.getByTestId("ticket-rail-tab-files").click();
        const fileRow = aside.locator(`[data-testid="ticket-files-row"][data-path="${TARGET}"]`);
        await waitUntil("reopen file row", async () => (await fileRow.count()) === 1);
        await fileRow.click();
        await waitUntil(
          "file tab active again",
          async () => (await readTicketTabs(page, ticketId))?.active === `file:${TARGET}`,
        );
      }

      await waitUntil(
        "file monaco ready before save",
        async () => {
          const monaco = await readFileMonaco(page);
          return monaco.status === "ready" && monaco.dirty === "true" ? monaco : null;
        },
        { timeout: 15000 },
      );
      await clickMonaco(page);
      await page.keyboard.press("Meta+s");

      const cleaned = await waitUntil(
        "file monaco clean after save",
        async () => {
          const monaco = await readFileMonaco(page);
          if (monaco.dirty === "false" && monaco.lines.includes(EDIT_MARKER)) return monaco;
          return null;
        },
        { timeout: 15000 },
      );

      const onDisk = await fs.readFile(join(worktreeDir, TARGET), "utf8");
      const diskOk = onDisk.includes(EDIT_MARKER);

      // Switch back to Diff tab — should also be clean with same content.
      await aside.getByTestId("ticket-rail-tab-changes").click();
      await waitUntil(
        "changes list after save",
        async () => (await aside.getByTestId("ticket-changes-list").count()) === 1,
      );
      const rowBtn = aside.locator(`[data-testid="ticket-changes-row"][data-path="${TARGET}"]`);
      await waitUntil("edit-me changes row", async () => (await rowBtn.count()) === 1);
      await rowBtn.click();

      const diffClean = await waitUntil(
        "diff tab clean with saved marker",
        async () => {
          const tabs = await readTicketTabs(page, ticketId);
          const monaco = await readDiffMonaco(page);
          if (
            tabs?.active === `diff:${TARGET}` &&
            monaco.status === "ready" &&
            monaco.dirty === "false" &&
            monaco.lines.includes(EDIT_MARKER)
          ) {
            return monaco;
          }
          return null;
        },
        { timeout: 20000 },
      );

      const dirtyDots = await page.getByTestId("tab-dirty").count();
      return {
        ok: !!cleaned && diskOk && !!diffClean && dirtyDots === 0,
        detail: `fileClean=${!!cleaned} diskOk=${diskOk} diffClean=${!!diffClean} dirtyDots=${dirtyDots} disk=${JSON.stringify(onDisk.slice(0, 80))}`,
      };
    });

    // ---- 7. Refresh never auto-opens tabs -----------------------------------
    await attempt(7, "filesystem Change Set refresh does not auto-open tabs", async () => {
      await aside.getByTestId("ticket-rail-tab-changes").click();
      await waitUntil(
        "changes list for refresh check",
        async () => (await aside.getByTestId("ticket-changes-list").count()) === 1,
      );
      const rowBtn = aside.locator(`[data-testid="ticket-changes-row"][data-path="${TARGET}"]`);
      await waitUntil("edit-me row for refresh", async () => (await rowBtn.count()) === 1);
      await rowBtn.focus();

      const tabsBefore = await readTicketTabs(page, ticketId);
      const tabLabelsBefore = await page.getByRole("tab").allTextContents();
      const activeBefore = await page.evaluate(() => {
        const active = document.querySelector('[role="tab"][aria-selected="true"]');
        return active?.getAttribute("aria-label") ?? active?.textContent ?? null;
      });

      await fs.writeFile(join(worktreeDir, "src", "fresh-untracked.ts"), "export const f = 1;\n");

      await waitUntil(
        "fresh-untracked appears in Changes",
        async () => {
          const text = await aside.getByTestId("ticket-changes-list").innerText();
          return text.includes("fresh-untracked.ts");
        },
        { timeout: 10000 },
      );

      const tabsAfter = await readTicketTabs(page, ticketId);
      const tabLabelsAfter = await page.getByRole("tab").allTextContents();
      const activeAfter = await page.evaluate(() => {
        const active = document.querySelector('[role="tab"][aria-selected="true"]');
        return active?.getAttribute("aria-label") ?? active?.textContent ?? null;
      });

      const sameDiffs =
        JSON.stringify(tabsBefore?.diffs ?? []) === JSON.stringify(tabsAfter?.diffs ?? []);
      const sameFiles =
        JSON.stringify(tabsBefore?.files ?? []) === JSON.stringify(tabsAfter?.files ?? []);
      const sameActive = tabsBefore?.active === tabsAfter?.active && activeBefore === activeAfter;
      const noFreshTab = !tabLabelsAfter.some(
        (t) =>
          t.includes("fresh-untracked") &&
          !tabLabelsBefore.some((b) => b.includes("fresh-untracked")),
      );

      return {
        ok: sameDiffs && sameFiles && sameActive && noFreshTab,
        detail: `diffs ${JSON.stringify(tabsBefore?.diffs)}→${JSON.stringify(tabsAfter?.diffs)}; files ${JSON.stringify(tabsBefore?.files)}→${JSON.stringify(tabsAfter?.files)}; active ${tabsBefore?.active}→${tabsAfter?.active}; labels ${tabLabelsBefore.length}→${tabLabelsAfter.length}`,
      };
    });

    // ---- 8. Side-by-side toggle (optional / cheap) --------------------------
    await attempt(8, "Side by side toggle updates DiffEditor layout in place", async () => {
      await aside.getByTestId("ticket-rail-tab-changes").click();
      const rowBtn = aside.locator(`[data-testid="ticket-changes-row"][data-path="${TARGET}"]`);
      await waitUntil("edit-me row for presentation", async () => (await rowBtn.count()) === 1);
      await rowBtn.click();
      await waitUntil(
        "diff tab active for presentation",
        async () => (await readTicketTabs(page, ticketId))?.active === `diff:${TARGET}`,
      );

      const presentation = page.getByTestId("ticket-diff-presentation");
      await waitUntil("presentation strip", async () => (await presentation.count()) === 1);

      const beforeTabs = await readTicketTabs(page, ticketId);
      const before = await readDiffMonaco(page);

      await presentation.getByRole("button", { name: "Side by side" }).click();
      const sided = await waitUntil(
        "side-by-side presentation applied",
        async () => {
          const state = await readDiffMonaco(page);
          const pressed =
            (await presentation
              .getByRole("button", { name: "Side by side" })
              .getAttribute("aria-pressed")) === "true";
          return state.presentation === "side-by-side" && state.sideBySideClass && pressed
            ? state
            : null;
        },
        { timeout: 10000 },
      );

      await presentation.getByRole("button", { name: "Inline" }).click();
      const inlined = await waitUntil(
        "inline presentation restored",
        async () => {
          const state = await readDiffMonaco(page);
          const pressed =
            (await presentation
              .getByRole("button", { name: "Inline" })
              .getAttribute("aria-pressed")) === "true";
          return state.presentation === "inline" && !state.sideBySideClass && pressed
            ? state
            : null;
        },
        { timeout: 10000 },
      );

      const afterTabs = await readTicketTabs(page, ticketId);
      const sameTab =
        beforeTabs?.active === afterTabs?.active &&
        JSON.stringify(beforeTabs?.diffs) === JSON.stringify(afterTabs?.diffs);

      return {
        ok: !!sided && !!inlined && sameTab && before.presentation === "inline",
        detail: `before=${before.presentation} sided=${sided?.presentation}/${sided?.sideBySideClass} inlined=${inlined?.presentation} sameTab=${sameTab} active=${afterTabs?.active}`,
      };
    });

    // ---- Screenshots --------------------------------------------------------
    await attempt("shot-diff", "screenshot diff-tab.png", async () => {
      await sleep(300);
      const path = join(SHOT_DIR, "diff-tab.png");
      await page.screenshot({ path, fullPage: false });
      const stat = await fs.stat(path);
      return { ok: stat.size > 1000, detail: path };
    });

    await attempt("shot-side", "screenshot diff-side-by-side.png", async () => {
      const presentation = page.getByTestId("ticket-diff-presentation");
      if ((await presentation.count()) === 1) {
        await presentation.getByRole("button", { name: "Side by side" }).click();
        await waitUntil(
          "side-by-side for shot",
          async () => {
            const state = await readDiffMonaco(page);
            return state.presentation === "side-by-side" && state.sideBySideClass ? state : null;
          },
          { timeout: 8000 },
        );
      }
      await sleep(300);
      const path = join(SHOT_DIR, "diff-side-by-side.png");
      await page.screenshot({ path, fullPage: false });
      const stat = await fs.stat(path);
      return { ok: stat.size > 1000, detail: path };
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
