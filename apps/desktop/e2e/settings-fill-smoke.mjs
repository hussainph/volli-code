/**
 * A filling table takes the leftover height, and never more than the viewport
 * (VC-111).
 *
 * WHY THIS EXISTS. `rows="fill"` is CSS, and it is a CHAIN of CSS: the shell's
 * column, the section, the section's row wrapper, the table root and the table's
 * scroll box all have to be flex boxes that may shrink. Break any single link
 * and one of two things happens, neither of which any unit test would catch:
 *
 *  - the table collapses to nothing, because a `flex-1` child of an
 *    auto-height parent has no free space to claim; or
 *  - the table grows to its content, pushing the page taller than the window
 *    and restoring the unbounded scroll the cap exists to prevent.
 *
 * So this measures the real thing in a real window: the box must be taller than
 * the fixed eight-row cap it replaced, must fit inside the viewport, and must
 * still fit after the window is made much shorter.
 *
 * MANUALLY RUN (needs a display + the built app); CI does not run it:
 *
 *   pnpm -w run build
 *   node apps/desktop/e2e/settings-fill-smoke.mjs
 */
import { promises as fs } from "node:fs";
import { join } from "node:path";

import {
  assertBuiltRendererLoaded,
  assertProfileIsolated,
  closeAppBounded,
  createRunner,
  launch,
  makeGitRepo,
  makeScratch,
  seedProjects,
} from "./lib/smoke-kit.mjs";

const { scratch, userDataDir, dbPath, cleanup } = await makeScratch("volli-settings-fill-");
const { must, summarize } = createRunner();

console.log("scratch:", scratch, "\n");

/** The scroll box of the table on screen, plus the window it has to fit in. */
async function measure(page) {
  return page.evaluate(() => {
    const table = document.querySelector("table");
    const box = table?.parentElement;
    if (!box) return null;
    return {
      boxHeight: Math.round(box.getBoundingClientRect().height),
      viewport: window.innerHeight,
      // A table that renders no rows would satisfy a height check trivially.
      bodyRows: table.querySelectorAll("tbody tr").length,
    };
  });
}

const openConfigure = async (page, category) => {
  await page.getByRole("button", { name: "Configure", exact: true }).first().click();
  await page.getByRole("navigation", { name: "Configure categories" }).waitFor();
  await page.getByRole("button", { name: category, exact: true }).click();
  await page.locator("table").first().waitFor();
};

const app = await launch({ userDataDir, dbPath });
const page = await app.firstWindow();

try {
  await assertBuiltRendererLoaded(page);
  await assertProfileIsolated(app, userDataDir);

  const repo = await makeGitRepo(scratch, "fill-project-");
  // Thirty real skills on disk. The pane reads the filesystem, and a table with
  // nothing in it renders an empty state rather than a `<table>` — which is
  // what an earlier version of this smoke measured, and why it measured nothing.
  for (let i = 0; i < 30; i += 1) {
    const slug = `fixture-skill-${String(i).padStart(2, "0")}`;
    const dir = join(repo, ".agents", "skills", slug);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      join(dir, "SKILL.md"),
      `---\nname: ${slug}\ndescription: Fixture number ${i}, long enough to occupy the description column.\n---\n\nBody.\n`,
    );
  }
  await seedProjects(page, [{ id: "fill-p1", name: "Fill Fixture", path: repo, prefix: "FF" }]);

  await must(1, "Configure → Skills: the table fills more than the old 8-row cap", async () => {
    await openConfigure(page, "Skills");
    const m = await measure(page);
    if (!m) return { ok: false, detail: "no table found" };
    // The old cap was 8 rows * 36px + 32px header = 320px.
    return {
      ok: m.boxHeight > 320 && m.bodyRows > 8,
      detail: `box=${m.boxHeight}px viewport=${m.viewport}px rows=${m.bodyRows}`,
    };
  });

  await must(2, "...and does not exceed the viewport", async () => {
    const m = await measure(page);
    return {
      ok: m.boxHeight <= m.viewport,
      detail: `box=${m.boxHeight}px vs viewport=${m.viewport}px`,
    };
  });

  await must(3, "the whole page fits too, so nothing hands back an unbounded scroll", async () => {
    const overflow = await page.evaluate(() => {
      const el = document.scrollingElement ?? document.documentElement;
      return el.scrollHeight - el.clientHeight;
    });
    return { ok: overflow <= 1, detail: `document overflow=${overflow}px` };
  });

  await must(4, "a much shorter window still keeps the table inside it", async () => {
    const before = await measure(page);
    await page.setViewportSize({ width: 1280, height: 520 });
    await page.waitForTimeout(400);
    const after = await measure(page);

    return {
      ok: after.boxHeight <= after.viewport && after.boxHeight < before.boxHeight,
      detail: `${before.boxHeight}px → ${after.boxHeight}px in a ${after.viewport}px window`,
    };
  });

  await must(5, "Settings → Models keeps its cap, because sections follow it", async () => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForTimeout(300);
    await page.getByRole("button", { name: "Settings", exact: true }).first().click();
    await page.getByRole("navigation", { name: "Settings categories" }).waitFor();
    await page.getByRole("button", { name: "Models", exact: true }).click();
    // Attached, not `waitFor()`'s default visibility: check 4 leaves the window
    // 520px tall and this asks for 1440x900 back, which a smaller runner
    // display clamps — the table is then laid out but scrolled out of view and
    // never becomes "visible". This measures a box height, not whether the
    // table is on screen.
    //
    // The Models catalog can also be legitimately EMPTY. DataTable renders
    // `<Empty>` and NO `<table>` when it has no items (kit/data-table.tsx), and
    // the catalog comes from the Pi runtime — a CI runner has none, so the pane
    // correctly shows "No models. Sign in to a provider below." and this waited
    // 30s for a table that was never going to exist.
    //
    // Both outcomes are asserted rather than skipped. With rows, the cap is
    // measured as before. Without rows there is no cap to measure, so the
    // assertion becomes the documented empty state — which still proves the
    // pane mounted and still fails if it renders neither.
    const modelsTable = page.locator("table").first();
    const modelsEmpty = page.getByText("No models. Sign in to a provider below.");
    await Promise.race([
      modelsTable.waitFor({ state: "attached", timeout: 30_000 }).catch(() => {}),
      modelsEmpty.waitFor({ state: "attached", timeout: 30_000 }).catch(() => {}),
    ]);

    if ((await modelsTable.count()) === 0) {
      const empty = (await modelsEmpty.count()) === 1;
      return {
        ok: empty,
        detail: empty
          ? "catalog empty (no Pi runtime) — empty state rendered; cap not measurable here"
          : "Models pane rendered neither a table nor its empty state",
      };
    }

    await modelsTable.scrollIntoViewIfNeeded().catch(() => {});
    const m = await measure(page);
    // 8 rows * 36 + 32 = 320. A little slack for sub-pixel layout.
    return { ok: m.boxHeight <= 340, detail: `box=${m.boxHeight}px (capped, not filling)` };
  });
} finally {
  await closeAppBounded(app);
  await cleanup();
}

summarize();
