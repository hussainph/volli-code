/**
 * Focused packaged proof for VC-110 live Monaco reconciliation.
 *
 * Proves, through the built Electron app and real filesystem watchers:
 *   1. A clean open File model adopts an external write in place without
 *      losing focus/cursor/scroll, and the inspected Change row becomes Updated.
 *   2. No filesystem event opens or focuses a tab.
 *   3. Disjoint human/agent edits merge into one dirty registry model.
 *   4. File and Diff deliberately opened for the same path share that model.
 *   5. A local save echo stays quiet in ticket recency.
 *   6. Overlap keeps exact local and disk versions behind one accessible,
 *      non-modal, persistent affordance with consequence-labelled actions.
 *   7. Reopening Diff clears Updated and reproduces the same conflict result.
 *
 *   env -u ELECTRON_RUN_AS_NODE node apps/desktop/e2e/monaco-reconciliation-smoke.mjs
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
const TARGET = "src/reconcile.ts";
const PROJECT = { id: "reconciliation-proj", name: "Monaco Reconciliation", prefix: "MR" };
const DEFAULT_HARNESS_ID = "claude-code";
const { scratch, userDataDir, dbPath, cleanup } = await makeScratch("volli-reconciliation-");
const { attempt, summarize } = createRunner();

const baselineLines = Array.from({ length: 80 }, (_, index) => {
  if (index === 0) return 'export const overlap = "baseline";';
  if (index === 5) return "export const changeSet = 0;";
  if (index === 24) return 'export const cleanAgent = "baseline";';
  if (index === 29) return 'export const diskOnly = "baseline";';
  return `export const line${index + 1} = ${index + 1};`;
});
const BASE = `${baselineLines.join("\n")}\n`;
const initialLines = [...baselineLines];
initialLines[5] = "export const changeSet = 1;";
const INITIAL = `${initialLines.join("\n")}\n`;
const cleanLines = [...initialLines];
cleanLines[24] = 'export const cleanAgent = "adopted";';
const CLEAN_DISK = `${cleanLines.join("\n")}\n`;
const disjointLines = [...cleanLines];
disjointLines[29] = 'export const diskOnly = "agent";';
const DISJOINT_DISK = `${disjointLines.join("\n")}\n`;
const HUMAN_MERGED_LINE = 'export const overlap = "human merged";';
const HUMAN_CONFLICT_LINE = 'export const overlap = "human conflict";';
const AGENT_CONFLICT_LINE = 'export const overlap = "agent conflict";';

async function git(cwd, args) {
  return execFileAsync("git", args, { cwd });
}

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

function fileHost(page) {
  return page.locator('[data-monaco-status="ready"]').first();
}

async function readFileState(page) {
  return fileHost(page).evaluate((host) => {
    const editor = host.querySelector(".monaco-editor");
    const scroll = host.querySelector(".monaco-scrollable-element");
    const cursor = host.querySelector(".cursor");
    return {
      dirty: host.getAttribute("data-monaco-dirty"),
      stale: host.getAttribute("data-monaco-stale"),
      focused: host.contains(document.activeElement),
      scrollTop: scroll?.scrollTop ?? null,
      cursorTop: cursor instanceof HTMLElement ? cursor.style.top : null,
      cursorLeft: cursor instanceof HTMLElement ? cursor.style.left : null,
      lines: Array.from(editor?.querySelectorAll(".view-line") ?? [])
        .map((line) => (line.textContent ?? "").replace(/\u00a0/g, " "))
        .join("\n"),
    };
  });
}

async function waitFileText(page, needle, dirty = null) {
  return waitUntil(
    `File Monaco to contain ${JSON.stringify(needle)}`,
    async () => {
      const state = await readFileState(page);
      if (!state.lines.includes(needle)) return null;
      if (dirty !== null && state.dirty !== String(dirty)) return null;
      return state;
    },
    { timeout: 20000 },
  );
}

async function waitStableFileViewState(page, label) {
  let previous = null;
  let stablePolls = 0;
  return waitUntil(
    label,
    async () => {
      const state = await readFileState(page);
      const signature = JSON.stringify({
        focused: state.focused,
        scrollTop: state.scrollTop,
        cursorTop: state.cursorTop,
        cursorLeft: state.cursorLeft,
      });
      if (signature === previous) stablePolls += 1;
      else stablePolls = 0;
      previous = signature;
      return stablePolls >= 2 ? state : null;
    },
    { timeout: 5000, interval: 100 },
  );
}

async function replaceFirstLine(page, text) {
  const editor = fileHost(page).locator(".monaco-editor");
  await editor.click();
  await page.keyboard.press("Meta+ArrowUp");
  await page.keyboard.press("Home");
  await page.keyboard.press("Shift+End");
  await page.keyboard.type(text);
  await waitFileText(page, text, true);
}

async function findInFile(page, text) {
  await fileHost(page).locator(".monaco-editor").click();
  await page.keyboard.press("Meta+f");
  await page.keyboard.type(text);
  await page.keyboard.press("Enter");
  await page.keyboard.press("Escape");
  return waitFileText(page, text);
}

async function readDiffState(page) {
  return page.evaluate(() => {
    const host = document.querySelector('[data-monaco-diff-status="ready"]');
    const modified =
      host?.querySelector(".editor.modified .monaco-editor") ??
      [...(host?.querySelectorAll(".monaco-editor") ?? [])].at(-1) ??
      null;
    return {
      ready: host !== null,
      dirty: host?.getAttribute("data-monaco-diff-dirty") ?? null,
      lines: Array.from(modified?.querySelectorAll(".view-line") ?? [])
        .map((line) => (line.textContent ?? "").replace(/\u00a0/g, " "))
        .join("\n"),
    };
  });
}

async function findInDiff(page, text) {
  const host = page.locator('[data-monaco-diff-status="ready"]').first();
  const modified = host.locator(".monaco-editor").last();
  await modified.click();
  await page.keyboard.press("Meta+f");
  await page.keyboard.type(text);
  await page.keyboard.press("Enter");
  await page.keyboard.press("Escape");
  return waitUntil(
    `Diff Monaco to contain ${JSON.stringify(text)}`,
    async () => {
      const state = await readDiffState(page);
      return state.lines.includes(text) ? state : null;
    },
    { timeout: 15000 },
  );
}

async function openFileFromRail(aside) {
  await aside.getByTestId("ticket-rail-mode-files").click();
  await waitUntil(
    "Files list",
    async () => (await aside.getByTestId("ticket-files-list").count()) === 1,
  );
  const src = aside.locator('[data-testid="ticket-files-row"][data-path="src"]');
  if ((await src.count()) === 1) await src.click();
  const row = aside.locator(`[data-testid="ticket-files-row"][data-path="${TARGET}"]`);
  await waitUntil("reconcile.ts Files row", async () => (await row.count()) === 1);
  await row.click();
}

async function main() {
  const fakeHome = join(scratch, "home");
  await fs.mkdir(fakeHome, { recursive: true });
  const app = await launch({
    dbPath,
    userDataDir,
    extraEnv: { VOLLI_WORKTREE_HOME_DIR: fakeHome },
  });

  try {
    await assertProfileIsolated(app, userDataDir);
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await sleep(600);

    const projectPath = await makeGitRepo(scratch, "reconciliation-project-");
    await fs.mkdir(join(projectPath, "src"), { recursive: true });
    await fs.writeFile(join(projectPath, TARGET), BASE);
    await git(projectPath, ["add", "-A"]);
    await git(projectPath, ["commit", "-q", "-m", "seed reconciliation file"]);

    await seedProjects(page, [{ ...PROJECT, path: projectPath }]);
    const { byName } = await readSeededProjects(page);
    const projectId = byName[PROJECT.name]?.id;
    if (!projectId) throw new Error("seeded project missing after import");

    const { ticketId, displayId } = await createTicketViaBridge(page, PROJECT.name, {
      status: "todo",
      title: "Monaco reconciliation proof",
      priority: "medium",
    });
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

    const ticket = await waitUntil(
      "ticket worktree",
      async () => {
        const tickets = await page.evaluate(async (pid) => {
          const boot = await window.api.data.bootstrap();
          return boot.ok ? (boot.data.ticketsByProject?.[pid] ?? []) : [];
        }, projectId);
        const row = tickets.find((candidate) => candidate.id === ticketId);
        return row?.worktreePath ? row : null;
      },
      { timeout: 30000 },
    );
    const worktreeDir = ticket.worktreePath;
    const targetPath = join(worktreeDir, TARGET);
    await fs.writeFile(targetPath, INITIAL);

    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    const card = page.locator("article").filter({
      has: page.locator("span.font-mono", { hasText: new RegExp(`^${displayId}$`) }),
    });
    await waitUntil("ticket card", async () => (await card.count()) === 1);
    await card.dblclick();
    const aside = page.locator("aside");
    await waitUntil("ticket rail", async () => (await aside.count()) === 1);
    await openFileFromRail(aside);
    await waitFileText(page, "export const changeSet = 1;", false);

    await aside.getByTestId("ticket-rail-mode-changes").click();
    const changeRow = aside.locator(`[data-testid="ticket-changes-row"][data-path="${TARGET}"]`);
    await waitUntil("reconciliation Change row", async () => (await changeRow.count()) === 1);

    await attempt(
      1,
      "clean external update adopts in place and preserves editor view state",
      async () => {
        const editor = fileHost(page).locator(".monaco-editor");
        await editor.click();
        await page.keyboard.press("Meta+ArrowUp");
        for (let index = 0; index < 20; index += 1) await page.keyboard.press("ArrowDown");
        await page.keyboard.press("End");
        const before = await waitStableFileViewState(
          page,
          "cursor to settle before external write",
        );
        const tabsBefore = await readTicketTabs(page, ticketId);

        await sleep(20);
        await fs.writeFile(targetPath, CLEAN_DISK);
        await waitFileText(page, 'export const cleanAgent = "adopted";', false);
        const after = await waitStableFileViewState(page, "cursor to settle after external write");
        const tabsAfter = await readTicketTabs(page, ticketId);
        const updated = await waitUntil("Updated marker after inspected external write", async () =>
          (await changeRow.getByTestId("ticket-changes-updated").count()) === 1 ? true : null,
        );

        const sameTabs = JSON.stringify(tabsBefore) === JSON.stringify(tabsAfter);
        const stableView =
          before.focused &&
          after.focused &&
          before.scrollTop === after.scrollTop &&
          before.cursorTop === after.cursorTop &&
          before.cursorLeft === after.cursorLeft;
        return {
          ok: stableView && sameTabs && updated === true,
          detail: `focus=${before.focused}→${after.focused} scroll=${before.scrollTop}→${after.scrollTop} cursor=${before.cursorTop}/${before.cursorLeft}→${after.cursorTop}/${after.cursorLeft} tabsStable=${sameTabs}`,
        };
      },
    );

    await attempt(
      2,
      "deliberate Diff open clears Updated without duplicate or automatic tabs",
      async () => {
        await changeRow.click();
        const tabs = await waitUntil(
          "Diff tab deliberately active",
          async () => {
            const next = await readTicketTabs(page, ticketId);
            return next?.active === `diff:${TARGET}` ? next : null;
          },
          { timeout: 20000 },
        );
        await findInDiff(page, 'export const cleanAgent = "adopted";');
        const updatedCount = await changeRow.getByTestId("ticket-changes-updated").count();
        return {
          ok:
            updatedCount === 0 && (tabs.diffs?.filter((path) => path === TARGET).length ?? 0) === 1,
          detail: `active=${tabs.active} diffs=${JSON.stringify(tabs.diffs)} updated=${updatedCount}`,
        };
      },
    );

    await openFileFromRail(aside);
    await waitFileText(page, 'export const cleanAgent = "adopted";', false);
    await aside.getByTestId("ticket-rail-mode-changes").click();

    await attempt(
      3,
      "disjoint human and agent edits reconcile into one dirty File model",
      async () => {
        await replaceFirstLine(page, HUMAN_MERGED_LINE);
        await sleep(20);
        await fs.writeFile(targetPath, DISJOINT_DISK);
        await waitUntil(
          "dirty merged File model",
          async () => {
            const state = await readFileState(page);
            return state.dirty === "true" && state.stale === "false" ? state : null;
          },
          { timeout: 20000 },
        );
        const local = await findInFile(page, HUMAN_MERGED_LINE);
        const disk = await findInFile(page, 'export const diskOnly = "agent";');
        return {
          ok: local.dirty === "true" && disk.dirty === "true",
          detail: `local=${local.lines.includes(HUMAN_MERGED_LINE)} disk=${disk.lines.includes('diskOnly = "agent"')} dirty=${disk.dirty}`,
        };
      },
    );

    await attempt(
      4,
      "Diff deliberately opened for the path shares the merged dirty model",
      async () => {
        await changeRow.click();
        const local = await findInDiff(page, HUMAN_MERGED_LINE);
        const disk = await findInDiff(page, 'export const diskOnly = "agent";');
        return {
          ok: local.dirty === "true" && disk.dirty === "true",
          detail: `local=${local.lines.includes(HUMAN_MERGED_LINE)} disk=${disk.lines.includes('diskOnly = "agent"')} dirty=${disk.dirty}`,
        };
      },
    );

    await openFileFromRail(aside);
    await findInFile(page, HUMAN_MERGED_LINE);
    await aside.getByTestId("ticket-rail-mode-changes").click();

    await attempt(
      5,
      "known local-save echo advances baseline without marking Updated",
      async () => {
        await fileHost(page).locator(".monaco-editor").click();
        await page.keyboard.press("Meta+s");
        await waitUntil(
          "File model clean after save",
          async () => ((await readFileState(page)).dirty === "false" ? true : null),
          { timeout: 15000 },
        );
        await sleep(1200);
        const onDisk = await fs.readFile(targetPath, "utf8");
        const updatedCount = await changeRow.getByTestId("ticket-changes-updated").count();
        return {
          ok:
            onDisk.includes(HUMAN_MERGED_LINE) &&
            onDisk.includes('export const diskOnly = "agent";') &&
            updatedCount === 0,
          detail: `localOnDisk=${onDisk.includes(HUMAN_MERGED_LINE)} agentOnDisk=${onDisk.includes('diskOnly = "agent"')} updated=${updatedCount}`,
        };
      },
    );

    await attempt(
      6,
      "overlap preserves exact local and disk versions behind one non-modal affordance",
      async () => {
        await replaceFirstLine(page, HUMAN_CONFLICT_LINE);
        const diskLines = (await fs.readFile(targetPath, "utf8")).split("\n");
        diskLines[0] = AGENT_CONFLICT_LINE;
        const agentDisk = diskLines.join("\n");
        await sleep(20);
        await fs.writeFile(targetPath, agentDisk);

        const affordance = page.getByTestId("live-reconciliation-conflict");
        await waitUntil("conflict affordance", async () => (await affordance.count()) === 1, {
          timeout: 20000,
        });
        const local = await findInFile(page, HUMAN_CONFLICT_LINE);
        const exactDisk = await fs.readFile(targetPath, "utf8");
        await sleep(700);
        const stillVisible = (await affordance.count()) === 1;
        const dialogCount = await page.getByRole("dialog").count();
        const useDisk = await affordance
          .getByRole("button", { name: "Use disk and discard draft" })
          .count();
        const overwrite = await affordance
          .getByRole("button", { name: "Overwrite disk with draft" })
          .count();
        return {
          ok:
            local.lines.includes(HUMAN_CONFLICT_LINE) &&
            exactDisk === agentDisk &&
            stillVisible &&
            dialogCount === 0 &&
            useDisk === 1 &&
            overwrite === 1,
          detail: `localExact=${local.lines.includes(HUMAN_CONFLICT_LINE)} diskExact=${exactDisk === agentDisk} persistent=${stillVisible} dialogs=${dialogCount} actions=${useDisk}/${overwrite}`,
        };
      },
    );

    await attempt(
      7,
      "reopening Diff clears Updated and reproduces the shared conflict result",
      async () => {
        const updatedBefore = await waitUntil("Updated marker after overlap", async () =>
          (await changeRow.getByTestId("ticket-changes-updated").count()) === 1 ? true : null,
        );
        await changeRow.click();
        const local = await findInDiff(page, HUMAN_CONFLICT_LINE);
        const affordance = page.getByTestId("live-reconciliation-conflict");
        await waitUntil("Diff conflict affordance", async () => (await affordance.count()) === 1, {
          timeout: 15000,
        });
        const updatedAfter = await changeRow.getByTestId("ticket-changes-updated").count();
        return {
          ok: updatedBefore === true && local.dirty === "true" && updatedAfter === 0,
          detail: `updatedBefore=${updatedBefore} sharedLocal=${local.lines.includes(HUMAN_CONFLICT_LINE)} dirty=${local.dirty} updatedAfter=${updatedAfter}`,
        };
      },
    );
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
