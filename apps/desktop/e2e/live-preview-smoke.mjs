/**
 * End-to-end smoke for Document Mode's markdown REVEAL rules — the behaviour a
 * PR #63 follow-up bug once broke (raw formatting delimiters — `##`, `**`, `~~`
 * — stayed visible until a click forced a decoration rebuild).
 *
 * The rule under test is engine-independent and is the reason the CodeMirror →
 * Monaco migration is a swap of renderers rather than of behaviour: a node's
 * formatting marks are collapsed until the selection TOUCHES the node, and a
 * blurred editor reveals nothing whatever its selection says (`reveal.ts`,
 * `markdown-projection.ts`). The two original root causes are still both
 * asserted:
 *   a. Reveal must respect FOCUS. A blurred editor still has a selection
 *      (initially line 1, column 1 — the heading's own line), so a focus-blind
 *      rule leaves the caret line's raw syntax revealed while "not editing".
 *      Clicking in and away moved the caret, which is why it "fixed itself".
 *   b. Reveal must converge for content the user has not interacted with. Under
 *      CodeMirror that meant lezer's incremental parse frontier; under Monaco it
 *      means a virtualized view line, rendered for the first time on scroll, has
 *      to arrive already carrying its decorations.
 *
 * HOW THIS IS ASSERTED (the trap this file exists to encode): Monaco has no
 * `Decoration.replace`. Document Mode collapses punctuation with an
 * `inlineClassName` whose CSS is `display:none`, so the characters are still in
 * the DOM and `textContent` still returns them. `!lineText.includes("##")`
 * therefore FAILS even when the reveal rule is working perfectly. Every check
 * below reads COMPUTED STYLE instead, and splits each line into the text a human
 * can see and the text that is collapsed — which is strictly stronger than the
 * old textContent assertions: it proves the mark exists AND is invisible, where
 * a missing decoration used to pass.
 *
 * Checks (against a seeded ticket body, never typing into the editor first):
 *   1. Blurred mount — the first line (`## First Heading`) shows NO raw `##`.
 *   2. Blurred mount — no `**`/`~~` delimiters visible anywhere in view.
 *   3. Caret reveal still works — clicking the heading line reveals its `##`.
 *   4. Blur re-collapses — clicking outside the editor (Doc tab) hides `##`
 *      again even though the selection still touches that line.
 *   5. Convergence on lazily-rendered content — wheel-scroll (no clicks) to a
 *      heading deep in a large body; it must render as a styled heading with its
 *      `##` collapsed, without any interaction beyond the scroll.
 *
 * This is a MANUALLY-RUN smoke (needs a display + the built app); it is NOT
 * wired into `vp test`.
 *
 *   Run:
 *     pnpm run build
 *     node apps/desktop/e2e/live-preview-smoke.mjs
 */
import { promises as fs } from "node:fs";

import {
  assertProfileIsolated,
  cardById,
  createRunner,
  launch,
  makeScratch,
  monacoEditor,
  readMonacoState,
  seedProjects,
  waitUntil,
} from "./lib/smoke-kit.mjs";

const { scratch, userDataDir, dbPath, cleanup } = await makeScratch("volli-live-preview-smoke-");
const { attempt, summarize } = createRunner();

const PROJECT_DIR = await fs.realpath(await fs.mkdtemp(`${scratch}/project-`));
const PROJECT = { id: "live-preview-project", name: "Live Preview Project", prefix: "VC" };
const DISPLAY_ID = `${PROJECT.prefix}-1`;

// The seeded body: formatting on the FIRST line (the default line-1 selection's
// line — root cause a), then a large filler so the tail heading is far outside
// the first rendered viewport (root cause b).
const FILLER = Array.from(
  { length: 400 },
  (_, i) => `Filler paragraph ${i} with some plain prose to pad the document out.`,
).join("\n\n");
const HEADING_TEXT = "First Heading";
const TAIL_HEADING = "Deep Tail Heading";
const EMPHASIS_LINE = "Intro **bold** and ~~struck~~ text.";
const BODY = [
  `## ${HEADING_TEXT}`,
  "",
  EMPHASIS_LINE,
  "",
  FILLER,
  "",
  `## ${TAIL_HEADING}`,
  "",
  "Tail line.",
].join("\n");

// ---- Document Mode DOM readers ---------------------------------------------

/**
 * Split one rendered document line into what is SEEN and what is COLLAPSED.
 *
 * Monaco renders a view line as leaf spans, one per decoration range, so a
 * collapsed delimiter is its own span carrying `volli-md-hidden`. Partitioning
 * the leaves by computed style is the only honest reading of "is this visible?"
 * — see the file header. Returns null when no rendered line contains `needle`
 * (a virtualized line that has not been rendered yet).
 *
 * @returns {Promise<{text:string, visible:string, collapsed:string,
 *                    classes:string[]}|null>}
 */
function readDocumentLine(page, needle) {
  return page.evaluate((search) => {
    const plain = (value) => (value ?? "").replace(/\u00a0/g, " ");
    const line = Array.from(document.querySelectorAll(".view-line")).find((el) =>
      plain(el.textContent).includes(search),
    );
    if (!line) return null;
    // Monaco nests one wrapper span around the per-decoration leaves; only the
    // leaves hold text.
    const leaves = Array.from(line.querySelectorAll("span")).filter(
      (span) => span.children.length === 0,
    );
    const isCollapsed = (span) =>
      getComputedStyle(span).display === "none" || span.getBoundingClientRect().width === 0;
    const join = (spans) => plain(spans.map((span) => span.textContent ?? "").join(""));
    const classes = new Set();
    for (const el of line.querySelectorAll("[class]")) {
      for (const name of el.classList) if (name.startsWith("volli-md-")) classes.add(name);
    }
    return {
      text: plain(line.textContent),
      visible: join(leaves.filter((span) => !isCollapsed(span))),
      collapsed: join(leaves.filter(isCollapsed)),
      classes: Array.from(classes).sort(),
    };
  }, needle);
}

/**
 * The same partition across EVERY rendered line at once — what check 2 needs,
 * since "no delimiter visible anywhere" is a statement about the whole view.
 *
 * @returns {Promise<{visible:string, collapsed:string}>}
 */
function readDocumentView(page) {
  return page.evaluate(() => {
    const plain = (value) => (value ?? "").replace(/\u00a0/g, " ");
    const leaves = Array.from(document.querySelectorAll(".view-line span")).filter(
      (span) => span.children.length === 0,
    );
    const isCollapsed = (span) =>
      getComputedStyle(span).display === "none" || span.getBoundingClientRect().width === 0;
    const join = (spans) => plain(spans.map((span) => span.textContent ?? "").join(""));
    return {
      visible: join(leaves.filter((span) => !isCollapsed(span))),
      collapsed: join(leaves.filter(isCollapsed)),
    };
  });
}

const docTab = (page) => page.getByRole("tab", { name: DISPLAY_ID, exact: true });
const headingLine = (page) => page.locator(".view-line").filter({ hasText: HEADING_TEXT }).first();

// ---- main ------------------------------------------------------------------

async function main() {
  const app = await launch({ dbPath, userDataDir });

  try {
    await assertProfileIsolated(app, userDataDir);

    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");

    // ---- seed: one project, one ticket with the probe body -----------------
    await seedProjects(page, [{ ...PROJECT, path: PROJECT_DIR }]);

    const seed = await page.evaluate(async (body) => {
      const boot = await window.api.data.bootstrap();
      if (!boot.ok) return { ok: false, error: `bootstrap: ${boot.error}` };
      const project = boot.data.projects[0];
      if (!project) return { ok: false, error: "no project after import" };
      const created = await window.api.tickets.create({
        projectId: project.id,
        status: "todo",
        title: "Live preview probe ticket",
        priority: "medium",
      });
      if (!created.ok) return { ok: false, error: `create: ${created.error}` };
      const updated = await window.api.tickets.update({ ticketId: created.ticket.id, body });
      if (updated && updated.ok === false) return { ok: false, error: `update: ${updated.error}` };
      return { ok: true };
    }, BODY);
    if (!seed.ok) throw new Error(`seed failed: ${seed.error}`);

    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    await waitUntil(
      "seeded card to render",
      async () => (await cardById(page, DISPLAY_ID).count()) === 1,
    );
    await cardById(page, DISPLAY_ID).dblclick();
    await waitUntil("detail view to open", async () => (await docTab(page).count()) === 1);
    // The Document Mode editor must genuinely boot — a `data-monaco-fallback`
    // <pre> would render the raw markdown and pass a naive "no ## visible" test
    // for entirely the wrong reason.
    await waitUntil(
      "Document Mode editor to boot with the seeded doc",
      async () => {
        const state = await readMonacoState(page);
        if (state.status !== "ready" || state.fallbacks !== 0 || !state.hasEditor) return null;
        return state.lines.includes(HEADING_TEXT) ? state : null;
      },
      { timeout: 20000 },
    );

    // ===================================================================
    // 1. BLURRED MOUNT: the first line's `##` must be collapsed even though
    //    the default selection (line 1) touches it.
    // ===================================================================
    await attempt(1, "Blurred mount: first-line heading shows no raw ##", async () => {
      const line = await waitUntil(
        "first heading to collapse",
        async () => {
          const current = await readDocumentLine(page, HEADING_TEXT);
          return current !== null && !current.visible.includes("#") ? current : null;
        },
        { timeout: 8000 },
      );
      // The mark must be PRESENT-and-invisible, not simply absent: a projection
      // that never ran also renders no `#`.
      const ok =
        line.visible.trim() === HEADING_TEXT &&
        line.collapsed.includes("##") &&
        line.classes.includes("volli-md-h2");
      return { ok, detail: `line=${JSON.stringify(line)}` };
    });

    // ===================================================================
    // 2. BLURRED MOUNT: no **/~~ delimiters visible anywhere in view.
    // ===================================================================
    await attempt(2, "Blurred mount: no **/~~ delimiters visible", async () => {
      const view = await waitUntil(
        "emphasis delimiters to collapse",
        async () => {
          const current = await readDocumentView(page);
          return !current.visible.includes("**") && !current.visible.includes("~~")
            ? current
            : null;
        },
        { timeout: 8000 },
      );
      const emphasis = await readDocumentLine(page, "bold");
      const ok =
        view.collapsed.includes("**") &&
        view.collapsed.includes("~~") &&
        emphasis !== null &&
        emphasis.visible.trim() === "Intro bold and struck text." &&
        emphasis.classes.includes("volli-md-strong") &&
        emphasis.classes.includes("volli-md-strike");
      return {
        ok,
        detail: `emphasisLine=${JSON.stringify(emphasis)} collapsedHasDelimiters=${view.collapsed.includes("**") && view.collapsed.includes("~~")}`,
      };
    });

    // ===================================================================
    // 3. CARET REVEAL: clicking the heading line reveals its ## marks.
    // ===================================================================
    await attempt(3, "Focused caret on the heading line reveals ##", async () => {
      await headingLine(page).click();
      const line = await waitUntil("heading marks to reveal", async () => {
        const current = await readDocumentLine(page, HEADING_TEXT);
        return current !== null && current.visible.includes("##") ? current : null;
      });
      const ok = line.visible.trim().startsWith("##") && line.collapsed.trim() === "";
      return { ok, detail: `line=${JSON.stringify(line)}` };
    });

    // ===================================================================
    // 4. BLUR RE-COLLAPSES: clicking outside the editor hides ## again,
    //    even though the selection still touches that line.
    // ===================================================================
    await attempt(4, "Blur (click outside editor) re-collapses the caret line", async () => {
      await docTab(page).click();
      const line = await waitUntil("heading marks to re-collapse on blur", async () => {
        const current = await readDocumentLine(page, HEADING_TEXT);
        return current !== null && !current.visible.includes("#") ? current : null;
      });
      const ok = line.visible.trim() === HEADING_TEXT && line.collapsed.includes("##");
      return { ok, detail: `line=${JSON.stringify(line)}` };
    });

    // ===================================================================
    // 5. CONVERGENCE ON LAZILY-RENDERED CONTENT: wheel-scroll (no clicks,
    //    no caret moves) to the deep tail heading; it must style as a
    //    heading with its ## collapsed, purely from render/projection.
    // ===================================================================
    await attempt(5, "Deep heading styles correctly after wheel-scroll only", async () => {
      // The Document Mode host grows to content height (the OUTER overflow-y
      // div scrolls), so clamp the pointer to the visible window — the editor
      // box's center is thousands of px below the viewport, where wheel events
      // land on nothing.
      const box = await monacoEditor(page).boundingBox();
      if (!box) throw new Error("no editor box");
      const viewport = page.viewportSize() ?? { height: 600 };
      const y = Math.min(box.y + box.height / 2, viewport.height - 100);
      await page.mouse.move(box.x + box.width / 2, Math.max(box.y + 10, y));
      const line = await waitUntil(
        "tail heading to render collapsed + styled",
        async () => {
          await page.mouse.wheel(0, 4000);
          const current = await readDocumentLine(page, TAIL_HEADING);
          if (current === null) return null;
          return !current.visible.includes("#") &&
            current.collapsed.includes("##") &&
            current.classes.includes("volli-md-h2")
            ? current
            : null;
        },
        { timeout: 20000, interval: 250 },
      );
      return { ok: line.visible.trim() === TAIL_HEADING, detail: `line=${JSON.stringify(line)}` };
    });
  } finally {
    await app.close().catch(() => {});
  }

  return summarize();
}

let code = 1;
try {
  code = await main();
} catch (error) {
  console.error("\nSMOKE ABORTED:", error?.stack ?? error);
  code = 1;
} finally {
  await cleanup();
}
process.exit(code);
