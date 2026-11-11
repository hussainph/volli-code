#!/usr/bin/env node
/**
 * Reproducible README motion capture. Build current main first, then:
 *
 *   node apps/desktop/e2e/volli-drive/readme-demo.mjs
 *
 * Requires ffmpeg and ffprobe on PATH. Launches only through volli-drive, with an empty
 * scratch profile, a local Git origin, and scripted loopback model replies.
 * Seeding is setup; the recorded ticket -> Chat -> Send -> Diffs path uses
 * real UI controls. CDP records only that instance's renderer, never a screen.
 * Raw frames, timing, guard and host evidence stay in .scratch/volli-drive/.
 * The only published artifact is .github/readme/demo.gif (1200px, <=8 MB).
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { createTicketViaBridge } from "../lib/agent-kit.mjs";
import { cardById, goToBoard, seedProjects } from "../lib/smoke-kit.mjs";
import {
  createRegistry,
  instanceLayout,
  makeScratchRepo,
  REPO,
  supervisorEnv,
} from "./lib/core.mjs";
import { request } from "./lib/protocol.mjs";

const exec = promisify(execFile);
const CODE = `import type { BoardColumn, Ticket } from "./types";

const columns: BoardColumn[] = [
  "backlog",
  "todo",
  "doing",
  "needs_review",
  "done",
];

export function indexByColumn(tickets: readonly Ticket[]) {
  const index = new Map<BoardColumn, Ticket[]>(
    columns.map((column) => [column, []]),
  );
  for (const ticket of tickets) {
    index.get(ticket.status)?.push(ticket);
  }
  return index;
}
`;
const PROMPT = "Add a typed column index for the board.";
const TITLE = "Index board columns";
const WARMUP = "Let's improve the board.";
const WARMUP_REPLY = "What should we change?";
const gitEnvironment = (layout) => ({
  ...supervisorEnv(process.env),
  HOME: layout.home,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: join(layout.home, ".gitconfig"),
});
const SUMMARY =
  "Added **src/board/columns.ts** — a typed index for all five board columns.\n\n- Keeps ticket order within each column\n- Includes empty columns\n- Leaves the input unchanged\n\nReady for review.";
const TICKETS = [
  ["backlog", "Search across chat history", "medium"],
  ["backlog", "Remember board zoom per project", "low"],
  ["backlog", "Show worktree disk usage", "low"],
  ["todo", "Index tickets by board column", "high"],
  ["todo", "Keyboard-only board triage", "medium"],
  ["todo", "Restore composer drafts", "medium"],
  ["doing", "Stream tool output into chats", "high"],
  ["doing", "Retry interrupted worktree setup", "medium"],
  ["needs_review", "Keep tabs open across restarts", "medium"],
  ["needs_review", "Warn before closing a busy chat", "high"],
  ["done", "Create a branch for each ticket", "high"],
  ["done", "Persist the ticket rail width", "low"],
  ["backlog", "Inline diffs in the file editor", "medium"],
  ["todo", "Show agent progress on cards", "medium"],
  ["doing", "Improve keyboard tab navigation", "medium"],
  ["doing", "Reconnect parked sessions", "high"],
  ["needs_review", "Confirm before archiving a worktree", "high"],
  ["needs_review", "Restore board filters on launch", "medium"],
  ["done", "Add project keyboard shortcuts", "medium"],
  ["done", "Search ticket titles from the command bar", "medium"],
];

// Same addressed View-menu command as docs-shots: no native focus needed.
const uiZoom = (app, command) =>
  app.evaluate(({ BrowserWindow }, cmd) => {
    BrowserWindow.getAllWindows()[0].webContents.send("volli:ui-zoom-command", cmd);
  }, command);

async function fitBoardColumns(page, app) {
  let steps = 1;
  await page.getByRole("button", { name: "Toggle navigation sidebar", exact: true }).click();
  await uiZoom(app, "out");
  await sleep(400);
  const overflow = () =>
    page.evaluate(() => {
      const scroller = Array.from(document.querySelectorAll("div.overflow-x-auto")).find(
        (el) => el.querySelector("article") !== null && el.getClientRects().length > 0,
      );
      if (!scroller) throw new Error("no visible board scroller");
      return scroller.scrollWidth - scroller.clientWidth;
    });
  if ((await overflow()) > 1) {
    await uiZoom(app, "out");
    steps += 1;
    await sleep(400);
  }
  assert.ok((await overflow()) <= 1, "all five board columns must fit without horizontal clipping");
  const columns = await page.locator("[data-board-column]:visible").evaluateAll((elements) =>
    elements.map((el) => {
      const rect = el.getBoundingClientRect();
      return {
        status: el.getAttribute("data-board-column"),
        visible: rect.left >= 0 && rect.right <= window.innerWidth + 1,
      };
    }),
  );
  assert.deepEqual(
    columns.map((column) => column.status),
    ["backlog", "todo", "doing", "needs_review", "done"],
  );
  assert.ok(columns.every((column) => column.visible));
  return steps;
}

/** Called only by the isolated supervisor's dedicated capture command. */
export async function captureReadmeDemo({ page, app, layout }) {
  const { dir } = await makeScratchRepo(layout.projectsDir, "voltaic");
  await mkdir(join(dir, "src/board"), { recursive: true });
  await writeFile(
    join(dir, "src/board/types.ts"),
    'export type BoardColumn = "backlog" | "todo" | "doing" | "needs_review" | "done";\nexport interface Ticket { id: string; title: string; status: BoardColumn }\n',
  );
  // Commit fixture source before any ticket worktree is created. No real remote.
  const gitEnv = gitEnvironment(layout);
  await writeFile(
    join(dir, "README.md"),
    "# voltaic\n\nA focused workspace for planning and shipping software.\n",
  );
  await exec("git", ["add", "."], { cwd: dir, env: gitEnv });
  await exec("git", ["commit", "-m", "Add board types"], { cwd: dir, env: gitEnv });
  await exec("git", ["push", "origin", "main"], { cwd: dir, env: gitEnv });
  await seedProjects(page, [
    { id: "readme-voltaic", name: "voltaic", prefix: "VLT", colorIndex: 2, path: dir },
  ]);
  const tickets = [];
  for (const [status, title, priority] of TICKETS) {
    tickets.push(await createTicketViaBridge(page, "voltaic", { status, title, priority }));
  }
  await page.evaluate(async (ticketId) => {
    const result = await window.api.tickets.update({
      ticketId,
      body: "Group tickets by status without re-scanning the board for every column.\n\n- Include all five columns, even when empty\n- Preserve ticket order\n- Keep the input immutable",
    });
    if (!result.ok) throw new Error(result.error);
  }, tickets[3].ticketId);
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].setContentSize(1440, 900);
  });
  // A logical viewport avoids work-area clamping on smaller displays. Both
  // screencast and the final flush still read only this isolated renderer.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.reload();
  await page.getByText("VLT-4", { exact: true }).waitFor();
  await page.evaluate(() => document.fonts.ready);
  // Prepare a real, short exchange and a Draft through the UI, before capture.
  // Reopening this existing chat never exposes the zero-history heatmap.
  await cardById(page, "VLT-4").dblclick();
  await page.getByRole("button", { name: "New chat", exact: true }).click();
  const draft = page.getByRole("textbox", { name: "Message", exact: true });
  await draft.fill(WARMUP);
  await draft.press("Enter");
  await page.getByText(WARMUP_REPLY, { exact: true }).waitFor();
  await page.getByText(TITLE, { exact: true }).first().waitFor();
  await draft.fill(PROMPT);
  await goToBoard(page);
  const boardZoomSteps = await fitBoardColumns(page, app);
  await sleep(500);

  const framesDir = join(layout.evidence, "readme-frames");
  await mkdir(framesDir);
  const cdp = await page.context().newCDPSession(page);
  const frames = [];
  const writes = [];
  const start = performance.now();
  const saveFrame = (data) => {
    const path = join(framesDir, `${String(frames.length).padStart(5, "0")}.png`);
    frames.push({ path, at: (performance.now() - start) / 1000 });
    writes.push(writeFile(path, data));
  };
  cdp.on("Page.screencastFrame", ({ data, sessionId }) => {
    saveFrame(Buffer.from(data, "base64"));
    void cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
  });
  // Start with an explicit board frame, even if a browser skips unchanged
  // frames on screencast startup. The rest is continuous renderer motion.
  saveFrame(await page.screenshot({ scale: "css" }));
  await cdp.send("Page.startScreencast", {
    format: "png",
    maxWidth: 1440,
    maxHeight: 900,
    everyNthFrame: 2,
  });
  try {
    await sleep(1600);
    await cardById(page, "VLT-4").dblclick();
    await page.getByRole("tab", { name: new RegExp(TITLE) }).click();
    await uiZoom(app, "reset");
    const composer = page.getByRole("textbox", { name: "Message", exact: true });
    await composer.waitFor();
    assert.equal(await composer.inputValue(), PROMPT);
    assert.equal(await page.locator('[data-slot="chat-empty-state"]:visible').count(), 0);
    await sleep(400);
    await composer.press("Enter");
    await page.getByRole("button", { name: "Working", exact: true }).click();
    await page.getByRole("tab", { name: /Diffs/ }).click();
    await page.getByTestId("ticket-changes-row").filter({ hasText: "columns.ts" }).waitFor();
    await page.getByText("Ready for review.", { exact: false }).waitFor({ timeout: 60_000 });
    await page.getByText(TITLE, { exact: true }).first().waitFor({ timeout: 5000 });
    await sleep(2000);
    await page.getByRole("button", { name: "Back", exact: true }).click();
    for (let step = 0; step < boardZoomSteps; step += 1) await uiZoom(app, "out");
    await page.getByRole("button", { name: "New ticket", exact: true }).waitFor();
    await sleep(200);
    // The user's own keyboard-drag path: Todo -> Doing -> Needs Review.
    const card = cardById(page, "VLT-4").locator("..");
    await card.focus();
    await card.press("Space");
    await sleep(200);
    await page.keyboard.press("ArrowRight");
    await sleep(250);
    await page.keyboard.press("ArrowRight");
    await sleep(250);
    await page.keyboard.press("Space");
    await page
      .locator('[data-board-column="needs_review"]')
      .getByText("VLT-4", { exact: true })
      .waitFor();
    saveFrame(await page.screenshot({ scale: "css" }));
    await sleep(1500);
  } finally {
    await cdp.send("Page.stopScreencast");
    await cdp.detach();
  }
  const duration = (performance.now() - start) / 1000;
  await Promise.all(writes);
  assert.ok(frames.length > 40, `not a motion capture: ${frames.length} frames`);
  // CDP emits changed frames only. Preserve real time between them, including
  // reading beats, rather than turning screenshots into a synthetic slideshow.
  const input = join(framesDir, "frames.txt");
  await writeFile(input, frameManifest(frames, duration));
  return { input, frames: frames.length, duration, ticketId: tickets[3].ticketId };
}

/** ffconcat repeats the last file so its preceding duration is honoured. */
export function frameManifest(frames, duration) {
  assert.ok(frames.length > 0, "capture has no frames");
  const concat = frames.flatMap((frame, index) => {
    assert.ok(!/[\n\r']/.test(frame.path), "unsafe frame path");
    const elapsed = (frames[index + 1]?.at ?? duration) - frame.at;
    assert.ok(Number.isFinite(elapsed) && elapsed >= 0, "invalid frame timing");
    return [`file '${frame.path}'`, "option framerate 1000", `duration ${elapsed.toFixed(6)}`];
  });
  concat.push(`file '${frames.at(-1).path}'`, "option framerate 1000");
  return `${concat.join("\n")}\n`;
}
const driveDemo = async (...args) =>
  (
    await exec(process.execPath, [join(REPO, "apps/desktop/e2e/volli-drive/cli.mjs"), ...args], {
      timeout: 180_000,
      maxBuffer: 4 * 1024 * 1024,
    })
  ).stdout;

async function main() {
  const scratch = join(REPO, ".scratch/readme-demo");
  await mkdir(scratch, { recursive: true });
  const script = join(scratch, "replies.json");
  await writeFile(
    script,
    JSON.stringify([
      { text: WARMUP_REPLY },
      {
        text: "I’ll check the board types, then add the column index.",
        delayMs: 700,
        chunkDelayMs: 200,
        toolCalls: [
          { name: "bash", arguments: { command: "ls src/board && cat src/board/types.ts" } },
        ],
      },
      {
        toolCalls: [{ name: "write", arguments: { path: "src/board/columns.ts", content: CODE } }],
        delayMs: 900,
        chunkDelayMs: 120,
      },
      { text: SUMMARY, delayMs: 600, chunkDelayMs: 300 },
    ]),
  );
  let id;
  try {
    ({ id } = JSON.parse(
      await driveDemo(
        "launch",
        "--fixture",
        "empty",
        "--model",
        "fake",
        "--fake-script",
        script,
        "--fake-tool-free-text",
        TITLE,
        "--no-build",
        "--json",
      ),
    ));
    console.log(`Capturing ${id}`);
    const entry = await createRegistry().get(id);
    const layout = instanceLayout(entry.scratch, entry.evidence);
    await driveDemo("doctor", id);
    const capture = await request(layout.driveSocket, "readme-demo", {}, { timeoutMs: 120_000 });
    console.log(JSON.stringify(capture));
    const proof = await driveDemo(
      "state",
      id,
      "sql",
      "SELECT ticket_number, status, worktree_path FROM tickets WHERE ticket_number=4",
    );
    const [{ worktree_path: worktree, status }] = JSON.parse(proof);
    assert.equal(status, "needs_review");
    assert.ok((await realpath(worktree)).startsWith(`${await realpath(layout.scratch)}/`));
    assert.equal(await readFile(join(worktree, "src/board/columns.ts"), "utf8"), CODE);
    const changed = await exec("git", ["status", "--short"], {
      cwd: worktree,
      env: gitEnvironment(layout),
    });
    assert.equal(changed.stdout.trim(), "?? src/board/columns.ts");
    await writeFile(join(layout.evidence, "readme-proof.txt"), `${proof}\n${changed.stdout}`);
    const out = join(REPO, ".github/readme/demo.gif");
    await mkdir(join(REPO, ".github/readme"), { recursive: true });
    await exec(
      "ffmpeg",
      [
        "-y",
        "-threads",
        process.env.VOLLI_CONCURRENCY_HINT ?? "1",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        capture.input,
        "-filter_complex_threads",
        "1",
        "-filter_complex",
        "fps=15,scale=1200:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle",
        "-loop",
        "0",
        // Bound the final repeated PNG; fps otherwise extrapolates one more
        // inter-frame interval at EOF, extending the last reading beat twice.
        "-t",
        String(capture.duration),
        out,
      ],
      { timeout: 120_000 },
    );
    const bytes = (await readFile(out)).byteLength;
    assert.ok(bytes <= 8_000_000, `GIF too large: ${bytes}`);
    const probe = JSON.parse(
      (
        await exec("ffprobe", [
          "-v",
          "error",
          "-show_entries",
          "stream=width,height,nb_frames",
          "-show_entries",
          "format=duration",
          "-of",
          "json",
          out,
        ])
      ).stdout,
    );
    const duration = Number(probe.format.duration);
    assert.equal(probe.streams[0].width, 1200);
    assert.equal(probe.streams[0].height, 750);
    assert.ok(duration >= 12 && duration <= 18, `GIF duration ${duration}s is outside 12–18s`);
    console.log(
      `${out}: ${bytes} bytes; ${duration.toFixed(2)}s; ${capture.frames} captured frames; ${probe.streams[0].nb_frames} GIF frames`,
    );
    console.log(await driveDemo("doctor", id));
  } finally {
    if (id) console.log(await driveDemo("stop", id));
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
