/**
 * E2e proof of the Pi-backed native adapter attaching a real TICKET chat,
 * against the BUILT app. New ticket chats attach the `pi` manifest
 * (`apps/desktop/src/main/session-runtime/pi-adapter.ts`) instead of OpenCode —
 * see that file's module doc comment. Nothing about the MODEL is pinned there:
 * the adapter runs whatever the Session recorded, so the model under test is
 * this file's own {@link MODEL_PIN} and nothing else. There is no fake server
 * anywhere in this probe (the retired `session-chat-smoke.mjs` had one): Pi
 * runs in-process in Electron main and this smoke drives ONE real
 * turn against a real provider, billed to a ChatGPT subscription ($0
 * marginal — keep it to one short prompt, never loop turns speculatively).
 *
 * One thing makes a real Pi turn possible at all, and it is set up before the
 * app ever launches: **credentials**. This smoke isolates `HOME` into a
 * scratch dir (same posture as `VOLLI_WORKTREE_HOME_DIR` — never touch the
 * developer's real profile), and Pi's credential store reads
 * `$PI_CODING_AGENT_DIR` else `~/.pi/agent/auth.json` under that `HOME`
 * (`packages/agent-runtime/src/pi/models.ts`), so the real
 * `~/.pi/agent/auth.json` is copied into `<fakeHome>/.pi/agent/auth.json`
 * first — `smoke-kit.mjs`'s `ensurePiAuthInto`, which all three Pi smokes
 * share. It fails fast with a clear message if the real file is missing, never
 * reads the copy back or logs it, and shreds it on the way out however this
 * process dies — so a killed run leaves no live token behind.
 *
 * Deliberately NOT set up: OpenCode. There is no fake OpenCode server and no
 * binary override — a Pi Session no longer asks OpenCode anything.
 *
 * One more thing every structured Session now needs before it can even start:
 * an app-wide default model (`requireDefaultModel`, `structured-sessions.ts`,
 * called by both `ticket-sessions.ts` and `project-sessions.ts`). Nothing
 * bootstraps this on a fresh profile, so check 1 records one over the same
 * `modelAccess.setDefault` tRPC mutation Settings' "Default model" section
 * uses (`smoke-kit.mjs`'s `seedDefaultModel`) before the ticket chat is ever
 * created — and it records {@link MODEL_PIN}, not the catalog's first
 * available. The composer's Model pill (`composer-ui.tsx`) is offered to every
 * Session now regardless of Role — Ticket or Project — since
 * `chat-plane.tsx` dropped its old ticket/project "pinned" carve-out, and the
 * model it names is the one Pi actually runs: `attach` carries the Session's
 * durable selection in and `model.select` reaches Pi's own picker. Check 6
 * below proves the pill names the model this Session recorded rather than the
 * placeholder a Session with nothing selected would show.
 *
 * Run:
 *   pnpm run build
 *   node apps/desktop/e2e/pi-ticket-chat-smoke.mjs
 *
 * MANUALLY-RUN (needs a display, the built app, and a real `~/.pi/agent/auth.json`
 * with `openai-codex` credentials); NOT wired into `vp test`.
 */
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import { join } from "node:path";

import {
  activeTabLabel,
  assistantReplyTexts,
  assertBuiltRendererLoaded,
  cardById,
  CLOSE_APP_BOUNDED_MAX_MS,
  closeAppBounded,
  createDeadline,
  createRunner,
  ensurePiAuthInto,
  goToBoard,
  launch,
  makeGitRepo,
  makeScratch,
  openNewChatTab,
  readSeededProjects,
  seedDefaultModel,
  seedProjects,
  sleep,
  stopButton,
  summarizeTurnFrames,
  TICKET_TAB_STRIP,
  waitForSettledReply,
  waitUntil,
} from "./lib/smoke-kit.mjs";

const PROJECT = { id: "pi-ticket-chat-project", name: "Pi Ticket Chat", prefix: "PT" };
const SLEEP_COMMAND = "sleep 60";
const PROMPT_TEXT = `Run exactly \`${SLEEP_COMMAND}\` in the shell. After it finishes, include STEER_ACCEPTED.`;
const EXPECTED_REPLY = "STEER_ACCEPTED";
const QUEUE_RUN_ID = randomUUID().slice(0, 8);
const QUEUED_TEXT = {
  q1: `q1-${QUEUE_RUN_ID}: keep following the original instruction.`,
  q2: `q2-${QUEUE_RUN_ID}: edit-only probe; do not deliver.`,
};
const NORMAL_VIEWPORT = { width: 1280, height: 800 };
const NARROW_VIEWPORT = { width: 940, height: 720 };
const SLEEP_BARRIER_MS = 60_000;
const MIN_VISUAL_SLEEP_REMAINING_MS = 50_000;
const MIN_ACTIVE_SLEEP_REMAINING_MS = 40_000;
const MIN_PRECLICK_SLEEP_REMAINING_MS = 30_000;
const MIN_COMPLETED_SLEEP_MS = 55_000;
// 8s, up from 2s (#233): the q2 choreography snaps reads right after a
// viewport resize, and the composer has only grown since this budget was
// sized (#234's card family, #235's picker stack) — four straight failures,
// quiet machine included, all inside this slice while the UI in the failure
// screenshots was healthy. The 60s sleep barrier leaves ~50s of slack, so a
// wider read budget spends slack, not correctness: every barrier guard
// (MIN_*_SLEEP_REMAINING_MS) still holds unchanged.
const VULNERABLE_LOCATOR_TIMEOUT_MS = 8_000;
const NORMAL_LOCATOR_TIMEOUT_MS = 30_000;
const CLOSE_APP_SAFETY_MARGIN_MS = 2_000;
const Q2_CLOSE_RESERVE_MS = CLOSE_APP_BOUNDED_MAX_MS + CLOSE_APP_SAFETY_MARGIN_MS;
const Q1_TO_CLICK_BUDGET_MS = VULNERABLE_LOCATOR_TIMEOUT_MS * 4;
const PI_MARKER_TYPE = "volli.observation.v1";
const LIVE_RUNTIME_FRAME_KINDS = new Set([
  "attachment.opened",
  "attachment.native_referenced",
  "attachment.failed",
  "adapter.observed",
  "turn.started",
  "turn.completed",
  "turn.interrupted",
  "transcript.referenced",
]);
/**
 * The model this smoke actually tests, named rather than inherited.
 *
 * Unpinned, `seedDefaultModel` takes the first AVAILABLE model at its HIGHEST
 * reasoning level, which upstream's catalog ordering silently moved to
 * `openai-codex/gpt-5.3-codex-spark` at `xhigh` while this header still said
 * Luna — a smoke reporting on a model nobody chose. `low` because the subject
 * here is the adapter, the transcript and the durable Session, none of which
 * care how hard the model thought; a fixed low level also keeps one turn short
 * and its duration comparable between runs, which is what makes
 * `PI_TURN_BUDGET_MS` a ceiling instead of a lottery. An unavailable pin fails
 * check 1 loudly with what the live catalog does offer.
 */
const MODEL_PIN = {
  providerId: "openai-codex",
  modelId: "gpt-5.6-luna",
  reasoningLevel: "low",
};

const { scratch, userDataDir, dbPath, cleanup } = await makeScratch("pi-ticket-chat-smoke-");
// Isolates Pi's own credential/config lookups from the developer's real
// profile — the same posture VOLLI_WORKTREE_HOME_DIR takes for worktrees.
const fakeHome = join(scratch, "home");
const worktreesRoot = join(scratch, "worktree-home");
const { attempt, results, summarize } = createRunner();

const EVIDENCE_ROOT = process.argv[2] ?? join(os.tmpdir(), "volli-pi-ticket-chat-evidence");
const EVIDENCE_RUN = `${new Date().toISOString().replaceAll(":", "-")}-${QUEUE_RUN_ID}`;
const EVIDENCE_DIR = join(EVIDENCE_ROOT, EVIDENCE_RUN);
const PI_SESSION_DIR = join(userDataDir, "pi-sessions");

function messageBox(page) {
  return page.getByRole("textbox", { name: "Message", exact: true }).first();
}

function queuedMessageRows(page) {
  return page.getByRole("group", { name: /^Queued message:/ });
}

function queuedMessageRow(page, text) {
  return queuedMessageRows(page).filter({ hasText: text });
}

async function queuedMessageTexts(page) {
  return queuedMessageRows(page).evaluateAll((rows) =>
    rows.map((row) => {
      const textOnly = row.cloneNode(true);
      if (!(textOnly instanceof HTMLElement)) return "";
      for (const control of textOnly.querySelectorAll("button,[role=menu]")) control.remove();
      return textOnly.textContent?.trim() ?? "";
    }),
  );
}

async function waitForComposerState(
  page,
  expected,
  { value, focused = false, working = false, timeout = 5000, deadline } = {},
) {
  const boundedTimeout = deadline?.timeout("waiting for composer state", timeout) ?? timeout;
  return waitUntil(
    `queued messages to read ${JSON.stringify(expected)}`,
    async () => {
      const box = messageBox(page);
      const locatorOptions =
        deadline === undefined
          ? undefined
          : { timeout: deadline.timeout("checking composer state") };
      const [actual, input, hasFocus, stopCount] = await Promise.all([
        queuedMessageTexts(page),
        value === undefined ? Promise.resolve(value) : box.inputValue(locatorOptions),
        focused
          ? box.evaluate(
              (textarea) => document.activeElement === textarea,
              undefined,
              locatorOptions,
            )
          : Promise.resolve(true),
        working ? stopButton(page).count() : Promise.resolve(1),
      ]);
      const ordered =
        actual.length === expected.length &&
        actual.every((text, index) => text === expected[index]);
      return ordered && input === value && hasFocus && stopCount === 1 ? actual : false;
    },
    { timeout: boundedTimeout, interval: Math.min(50, boundedTimeout) },
  );
}

/**
 * One geometry snapshot is a lie often enough to have failed this smoke on a
 * quiet machine: the composer mount sits inside motion wrappers, and a read
 * taken right after `setViewportSize` can land mid-FLIP, when
 * `getBoundingClientRect` reports the transform's transient position as
 * off-viewport (`fits:false` with `overflow:0` — a box that is nowhere yet).
 * So the assertion is "the geometry SETTLES into fitting within the budget",
 * polled, with the last read thrown on timeout; the invariant itself is
 * unchanged.
 */
async function assertComposerGeometry(page, label, menu = null, { timeout } = {}) {
  const budget = timeout ?? NORMAL_LOCATOR_TIMEOUT_MS;
  const deadline = Date.now() + budget;
  let last = null;
  for (;;) {
    try {
      return await readComposerGeometryOnce(page, label, menu, {
        timeout: Math.max(250, deadline - Date.now()),
      });
    } catch (error) {
      last = error;
      if (Date.now() >= deadline) throw last;
      await sleep(120);
    }
  }
}

async function readComposerGeometryOnce(page, label, menu, { timeout } = {}) {
  const locatorOptions = timeout === undefined ? undefined : { timeout };
  const [composer, menuBox] = await Promise.all([
    messageBox(page).evaluate(
      (textarea) => {
        const shell = textarea.closest("form");
        if (!(shell instanceof HTMLElement)) return null;
        const rect = shell.getBoundingClientRect();
        const rows = Array.from(
          shell.querySelectorAll('[role="group"][aria-label^="Queued message:"]'),
        );
        return {
          fits:
            rect.width > 0 &&
            rect.height > 0 &&
            rect.left >= -1 &&
            rect.top >= -1 &&
            rect.right <= window.innerWidth + 1 &&
            rect.bottom <= window.innerHeight + 1,
          overflow: shell.scrollWidth - shell.clientWidth,
          rows: rows.map((row) => {
            const rowRect = row.getBoundingClientRect();
            return {
              fits:
                rowRect.width > 0 &&
                rowRect.left >= rect.left - 1 &&
                rowRect.right <= rect.right + 1,
              overflow: row.scrollWidth - row.clientWidth,
            };
          }),
        };
      },
      undefined,
      locatorOptions,
    ),
    menu ? menu.boundingBox(locatorOptions) : Promise.resolve(null),
  ]);
  const viewport = page.viewportSize();
  const menuFits =
    menuBox === null ||
    (viewport !== null &&
      menuBox.width > 0 &&
      menuBox.height > 0 &&
      menuBox.x >= -1 &&
      menuBox.y >= -1 &&
      menuBox.x + menuBox.width <= viewport.width + 1 &&
      menuBox.y + menuBox.height <= viewport.height + 1);
  const geometry = { composer, menuBox, menuFits };
  const ok =
    composer !== null &&
    composer.fits &&
    composer.overflow <= 1 &&
    composer.rows.every((row) => row.fits && row.overflow <= 1) &&
    menuFits;
  if (!ok) {
    throw new Error(`${label} geometry failed: ${JSON.stringify(geometry)}`);
  }
  return geometry;
}

async function queueWhileWorking(page, text, expectedOrder, { timeout = 5000, deadline } = {}) {
  if ((await stopButton(page).count()) === 0) {
    throw new Error(`turn settled before ${JSON.stringify(text)} could be queued`);
  }
  const textarea = messageBox(page);
  const actionTimeout = (label) => deadline?.timeout(label, timeout) ?? timeout;
  await textarea.fill(text, { timeout: actionTimeout("filling queued message") });
  await textarea.press("Enter", { timeout: actionTimeout("queueing message") });
  await waitForComposerState(page, expectedOrder, {
    value: "",
    working: true,
    timeout: actionTimeout("waiting for queued message"),
    deadline,
  });
}

async function armQueueMenuProbe(trigger, { timeout } = {}) {
  await trigger.evaluate(
    (triggerElement) => {
      const probe = {
        trigger: triggerElement,
        start: null,
        reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
      };
      const capture = (event) => {
        const target = event.target;
        const controlledId = triggerElement.getAttribute("aria-controls");
        if (
          !(target instanceof HTMLElement) ||
          controlledId === null ||
          target.id !== controlledId ||
          target.dataset.slot !== "dropdown-menu-content" ||
          target.getAttribute("role") !== "menu"
        ) {
          return;
        }
        const style = getComputedStyle(target);
        const names = style.animationName.split(",").map((name) => name.trim());
        const durations = style.animationDuration.split(",").map((token) => {
          const value = Number.parseFloat(token);
          return token.trim().endsWith("ms") ? value : value * 1000;
        });
        const animationIndex = names.indexOf(event.animationName);
        probe.start = {
          contentId: target.id,
          state: target.dataset.state ?? null,
          name: event.animationName,
          durationMs: durations[animationIndex] ?? null,
        };
      };
      const onAnimationStart = (event) => capture(event);
      document.addEventListener("animationstart", onAnimationStart, true);
      probe.stop = () => {
        document.removeEventListener("animationstart", onAnimationStart, true);
      };
      window.volliQueueMenuProbe = probe;
    },
    undefined,
    timeout === undefined ? undefined : { timeout },
  );
}

async function readQueueMenuProbe(page) {
  return page.evaluate(() => {
    const probe = window.volliQueueMenuProbe;
    return {
      controlledId: probe?.trigger?.getAttribute("aria-controls") ?? null,
      reducedMotion: probe?.reducedMotion ?? null,
      start: probe?.start ?? null,
    };
  });
}

async function stopQueueMenuProbe(page) {
  await page.evaluate(() => {
    window.volliQueueMenuProbe?.stop();
    delete window.volliQueueMenuProbe;
  });
}

/** Capture transient activity parts that `session.snapshot` cannot replay. */
async function installLiveActivityProbe(page, sessionId) {
  await page.evaluate(
    async ({ id, sleepCommand }) => {
      const probe = { subscriptionId: null, pending: [], latest: null, error: null, detach: null };
      const observe = (data) => {
        let parts = [];
        if (data?.kind === "overlay" && data.sessionId === id && data.delta?.op === "part.upsert") {
          parts = [data.delta.part];
        } else if (data?.sessionId === id && Array.isArray(data.transcript?.message?.parts)) {
          parts = data.transcript.message.parts;
        }
        for (const part of parts) {
          if (part?.type !== "dynamic-tool" || part.input?.command !== sleepCommand) continue;
          const descriptor = part.toolMetadata?.["volli.activity"] ?? null;
          probe.latest = {
            command: part.input.command,
            state: part.state ?? null,
            preliminary: part.preliminary === true,
            kind: descriptor?.kind ?? null,
            nativeToolName: descriptor?.nativeToolName ?? null,
            startedAt: descriptor?.startedAt ?? null,
            endedAt: descriptor?.endedAt ?? null,
          };
        }
      };
      const receive = (event) => {
        if (probe.subscriptionId === null) {
          probe.pending.push(event);
          return;
        }
        if (event.subscriptionId !== probe.subscriptionId) return;
        if (event.kind === "data") observe(event.data);
        else if (event.kind === "error") probe.error = event.error?.message ?? "stream failed";
      };
      probe.detach = window.api.sessionRpc.onEvent(receive);
      const reply = await window.api.sessionRpc.request({
        procedure: "session.subscribe",
        input: { sessionId: id, afterSequence: 0 },
      });
      if (!reply.ok || typeof reply.subscriptionId !== "string") {
        probe.detach();
        throw new Error(`activity probe subscription failed: ${JSON.stringify(reply)}`);
      }
      probe.subscriptionId = reply.subscriptionId;
      for (const event of probe.pending.splice(0)) receive(event);
      window.volliLiveActivityProbe = probe;
    },
    { id: sessionId, sleepCommand: SLEEP_COMMAND },
  );
}

async function readLiveSleepActivity(page) {
  return page.evaluate(() => {
    const probe = window.volliLiveActivityProbe;
    if (probe?.error) throw new Error(`activity probe stream failed: ${probe.error}`);
    return probe?.latest ?? null;
  });
}

function isInProgressSleepActivity(activity) {
  const inProgressState =
    activity?.state === "input-available" ||
    (activity?.state === "output-available" && activity.preliminary === true);
  return (
    inProgressState &&
    activity.command === SLEEP_COMMAND &&
    activity.kind === "run-command" &&
    activity.nativeToolName === "bash" &&
    Number.isFinite(activity.startedAt) &&
    activity.endedAt === null
  );
}

function sleepBarrierTiming(activity, observedAt = Date.now()) {
  const elapsedMs = observedAt - activity.startedAt;
  return { observedAt, elapsedMs, remainingMs: SLEEP_BARRIER_MS - elapsedMs };
}

/**
 * Read Pi's runtime-owned delivery record from this smoke's isolated profile.
 * The Session RPC deliberately strips the recovery locator and the durable
 * Receipt deliberately omits delivery mode; the JSONL `command-accepted`
 * marker is the existing authoritative observation of queue versus steer.
 */
async function readPiDeliveryMarker(commandId) {
  const paths = await fs.readdir(PI_SESSION_DIR, { recursive: true }).catch(() => []);
  for (const relativePath of paths) {
    if (typeof relativePath !== "string" || !relativePath.endsWith(".jsonl")) continue;
    const text = await fs.readFile(join(PI_SESSION_DIR, relativePath), "utf8");
    for (const line of text.split("\n")) {
      if (line.trim().length === 0) continue;
      const entry = JSON.parse(line);
      const marker = entry.customType === PI_MARKER_TYPE ? entry.data : null;
      if (marker?.kind !== "command-accepted" || marker.commandId !== commandId) continue;
      return {
        operation: marker.operation ?? null,
        delivery: marker.delivery ?? null,
        message: marker.message?.content ?? null,
      };
    }
  }
  return null;
}

function durableUserTextParts(frame) {
  return frame.transcript?.message?.role === "user"
    ? frame.transcript.message.parts.filter((part) => part.type === "text").map((part) => part.text)
    : [];
}

async function readSessionEvidence(page, sessionId) {
  const response = await page.evaluate(async (id) => {
    return window.api.sessionRpc.request({
      procedure: "session.snapshot",
      input: { sessionId: id },
    });
  }, sessionId);
  if (!response.ok) return { ok: false, error: JSON.stringify(response) };
  const frames = response.data.frames ?? [];
  const commandFrame = frames.find(
    (frame) =>
      frame.event.payload.kind === "command.recorded" &&
      durableUserTextParts(frame).includes(QUEUED_TEXT.q1),
  );
  const commandId =
    commandFrame?.event.payload.kind === "command.recorded"
      ? commandFrame.event.payload.command.id
      : null;
  const receiptFrame = frames.find(
    (frame) =>
      frame.event.payload.kind === "command.receipt.recorded" &&
      frame.event.payload.receipt.commandId === commandId,
  );
  const receipt =
    receiptFrame?.event.payload.kind === "command.receipt.recorded"
      ? receiptFrame.event.payload.receipt
      : null;
  const forbiddenDurable = frames.some((frame) =>
    durableUserTextParts(frame).includes(QUEUED_TEXT.q2),
  );
  const turnSummary = summarizeTurnFrames(frames);
  const exactSleepParts = frames
    .flatMap((frame) => frame.transcript?.message?.parts ?? [])
    .filter((part) => part.type === "dynamic-tool" && part.input?.command === SLEEP_COMMAND);
  const sleepPart = exactSleepParts.find(
    (part) => part.state === "output-available" && part.preliminary !== true,
  );
  const descriptor = sleepPart?.toolMetadata?.["volli.activity"] ?? null;
  const startedAt = typeof descriptor?.startedAt === "number" ? descriptor.startedAt : null;
  const endedAt = typeof descriptor?.endedAt === "number" ? descriptor.endedAt : null;
  const sleepActivity =
    sleepPart === undefined
      ? null
      : {
          command: sleepPart.input.command,
          kind: descriptor?.kind ?? null,
          nativeToolName: descriptor?.nativeToolName ?? null,
          startedAt,
          endedAt,
          durationMs:
            startedAt !== null && endedAt !== null && endedAt >= startedAt
              ? endedAt - startedAt
              : null,
        };
  return {
    ok:
      commandId !== null &&
      receipt?.status === "accepted" &&
      receipt.result.kind === "message.submitted" &&
      !forbiddenDurable,
    commandId,
    turnSummary,
    throughSequence: response.data.throughSequence,
    projection: response.data.projection,
    frameSummaries: frames.map((frame) => ({
      sequence: frame.event.sequence,
      kind: frame.event.payload.kind,
      turnId: frame.event.payload.turnId ?? null,
    })),
    sleepActivity,
  };
}

/** The durable Session boundary must not contain q2 before q1 is admitted. */
async function hasDurableUserMessage(page, sessionId, text) {
  return page.evaluate(
    async ({ id, expected }) => {
      const response = await window.api.sessionRpc.request({
        procedure: "session.snapshot",
        input: { sessionId: id },
      });
      if (!response.ok) throw new Error(`Session snapshot failed: ${JSON.stringify(response)}`);
      return response.data.frames.some(
        (frame) =>
          frame.transcript?.message?.role === "user" &&
          frame.transcript.message.parts.some(
            (part) => part.type === "text" && part.text === expected,
          ),
      );
    },
    { id: sessionId, expected: text },
  );
}

async function captureFailureEvidence(page, mainOut, mainErr, label) {
  await fs.mkdir(EVIDENCE_DIR, { recursive: true }).catch(() => {});
  const slug = label.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  await page
    .screenshot({
      path: join(EVIDENCE_DIR, `pi-ticket-chat-${slug}.png`),
      fullPage: true,
      timeout: 3000,
    })
    .catch(() => {});
  await fs
    .writeFile(
      join(EVIDENCE_DIR, `pi-ticket-chat-${slug}.log`),
      [`=== ${label} ===`, mainOut.join(""), mainErr.join("")].join("\n\n"),
      "utf8",
    )
    .catch(() => {});
  console.log(`  evidence: ${join(EVIDENCE_DIR, `pi-ticket-chat-${slug}.png`)}`);
  console.log(`  evidence: ${join(EVIDENCE_DIR, `pi-ticket-chat-${slug}.log`)}`);
}

function closeOutcomeDetail(outcome) {
  return `${outcome.kind} (pid=${outcome.pid}, code=${outcome.exit.code}, signal=${outcome.exit.signal})`;
}

async function requireGracefulClose(app, label) {
  const outcome = await closeAppBounded(app);
  if (outcome.kind !== "graceful") {
    throw new Error(`${label} did not close gracefully: ${closeOutcomeDetail(outcome)}`);
  }
  return outcome;
}

/** Submits `text` and returns the moment it was sent — the turn clock's zero. */
async function submitPrompt(page, text) {
  const textarea = messageBox(page);
  await textarea.click();
  await textarea.fill(text);
  await page.keyboard.press("Enter");
  return Date.now();
}

/** User-role messages (`Message`'s `is-user` class), non-empty text only. */
async function userMessageTexts(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll(".is-user"))
      .map((el) => el.textContent?.trim() ?? "")
      .filter((text) => text.length > 0),
  );
}

/**
 * The absolute path of a directory named `<needle>-*` (or exactly `needle`)
 * anywhere under `root`, or null — mirrors the same helper in
 * worktree-smoke.mjs.
 */
async function findWorktreeDir(root, needle) {
  let entries;
  try {
    entries = await fs.readdir(root, { recursive: true, withFileTypes: true });
  } catch {
    return null;
  }
  const hit = entries.find(
    (e) => e.isDirectory() && (e.name === needle || e.name.startsWith(`${needle}-`)),
  );
  return hit ? join(hit.parentPath ?? hit.path, hit.name) : null;
}

async function runQ2OverlayScenario(page, sessionId, visualSleep) {
  const deadline = createDeadline({
    label: "q2 overlay",
    expiresAt: visualSleep.startedAt + SLEEP_BARRIER_MS - Q2_CLOSE_RESERVE_MS,
    timeoutCeilingMs: VULNERABLE_LOCATOR_TIMEOUT_MS,
  });
  return deadline.run(async () => {
    const barrierTiming = sleepBarrierTiming(visualSleep);
    const [stopCount, queuedTexts] = await Promise.all([
      stopButton(page).count(),
      queuedMessageTexts(page),
    ]);
    if (
      barrierTiming.elapsedMs < 0 ||
      barrierTiming.remainingMs < MIN_VISUAL_SLEEP_REMAINING_MS ||
      stopCount !== 1 ||
      queuedTexts.length !== 0
    ) {
      throw new Error(
        `sleep barrier admission failed before q2: elapsed=${barrierTiming.elapsedMs}ms remaining=${barrierTiming.remainingMs}ms`,
      );
    }

    await queueWhileWorking(page, QUEUED_TEXT.q2, [QUEUED_TEXT.q2], {
      timeout: VULNERABLE_LOCATOR_TIMEOUT_MS,
      deadline,
    });
    await fs.mkdir(EVIDENCE_DIR, { recursive: true });
    await page.setViewportSize(NORMAL_VIEWPORT);
    await assertComposerGeometry(page, "normal viewport", null, {
      timeout: deadline.timeout("checking q2 normal geometry"),
    });
    const normalShot = join(EVIDENCE_DIR, "pi-ticket-chat-overlay-normal.png");
    await page.screenshot({
      path: normalShot,
      fullPage: false,
      timeout: deadline.timeout("capturing q2 normal screenshot"),
    });

    await page.setViewportSize(NARROW_VIEWPORT);
    const q2Row = queuedMessageRow(page, QUEUED_TEXT.q2);
    if ((await q2Row.count()) !== 1) throw new Error("q2 row is not uniquely addressable");
    const q2Actions = q2Row.getByRole("button", {
      name: `Queued message actions: ${QUEUED_TEXT.q2}`,
      exact: true,
    });
    await armQueueMenuProbe(q2Actions, {
      timeout: deadline.timeout("arming q2 menu probe"),
    });
    await q2Actions.click({ timeout: deadline.timeout("opening q2 actions") });
    const menuAnimationTimeout = deadline.timeout("waiting for q2 menu animation");
    const menuEvidence = await waitUntil(
      "the q2-controlled dropdown content to start its 150ms enter animation",
      async () => {
        const probe = await readQueueMenuProbe(page);
        const started =
          probe.start?.contentId === probe.controlledId &&
          probe.start.state === "open" &&
          probe.start.name === "enter" &&
          probe.start.durationMs === 150;
        return probe.reducedMotion === false && started ? probe : false;
      },
      {
        timeout: menuAnimationTimeout,
        interval: Math.min(25, menuAnimationTimeout),
      },
    );
    const menu = page
      .locator('[data-slot="dropdown-menu-content"]')
      .filter({ has: page.getByRole("menuitem", { name: "Edit message", exact: true }) });
    if (
      (await menu.count()) !== 1 ||
      (await menu.getAttribute("id", {
        timeout: deadline.timeout("checking q2 controlled menu"),
      })) !== menuEvidence.controlledId
    ) {
      throw new Error("q2 trigger did not control the inspected dropdown content");
    }
    await assertComposerGeometry(page, "narrow viewport", menu, {
      timeout: deadline.timeout("checking q2 narrow geometry"),
    });
    const narrowShot = join(EVIDENCE_DIR, "pi-ticket-chat-overlay-narrow.png");
    await page.screenshot({
      path: narrowShot,
      fullPage: false,
      timeout: deadline.timeout("capturing q2 narrow screenshot"),
    });

    await page.getByRole("menuitem", { name: "Edit message", exact: true }).click({
      timeout: deadline.timeout("editing q2"),
    });
    await stopQueueMenuProbe(page);
    await waitForComposerState(page, [], {
      value: QUEUED_TEXT.q2,
      focused: true,
      working: true,
      timeout: deadline.timeout("waiting for q2 edit"),
      deadline,
    });
    await queueWhileWorking(page, QUEUED_TEXT.q2, [QUEUED_TEXT.q2], {
      timeout: VULNERABLE_LOCATOR_TIMEOUT_MS,
      deadline,
    });
    const q2Remove = queuedMessageRow(page, QUEUED_TEXT.q2).getByRole("button", {
      name: `Remove queued message: ${QUEUED_TEXT.q2}`,
      exact: true,
    });
    await q2Remove.click({ timeout: deadline.timeout("removing q2") });
    await waitForComposerState(page, [], {
      focused: true,
      working: true,
      timeout: deadline.timeout("waiting for q2 removal"),
      deadline,
    });
    if (await hasDurableUserMessage(page, sessionId, QUEUED_TEXT.q2)) {
      throw new Error("q2 persisted in the Session before q1 admission");
    }
    return { barrierTiming, menuEvidence, normalShot, narrowShot };
  });
}

async function runQ1SteerScenario(page, barrierStartedAt) {
  const deadline = createDeadline({
    label: "q1 Steer",
    expiresAt: barrierStartedAt + SLEEP_BARRIER_MS - MIN_PRECLICK_SLEEP_REMAINING_MS,
    timeoutCeilingMs: VULNERABLE_LOCATOR_TIMEOUT_MS,
  });
  return deadline.run(async () => {
    if (Date.now() > deadline.expiresAt - Q1_TO_CLICK_BUDGET_MS) {
      throw new Error(`q1 admission missed its ${Q1_TO_CLICK_BUDGET_MS}ms pre-click reserve`);
    }
    const activeSleep = await readLiveSleepActivity(page);
    const barrierTiming = isInProgressSleepActivity(activeSleep)
      ? sleepBarrierTiming(activeSleep)
      : null;
    const [stopCount, queuedTexts] = await Promise.all([
      stopButton(page).count(),
      queuedMessageTexts(page),
    ]);
    if (
      barrierTiming === null ||
      activeSleep.startedAt !== barrierStartedAt ||
      barrierTiming.elapsedMs < 0 ||
      barrierTiming.remainingMs < MIN_ACTIVE_SLEEP_REMAINING_MS ||
      stopCount !== 1 ||
      queuedTexts.length !== 0
    ) {
      throw new Error(
        `sleep barrier admission failed before q1: timing=${JSON.stringify(barrierTiming)}`,
      );
    }

    await queueWhileWorking(page, QUEUED_TEXT.q1, [QUEUED_TEXT.q1], {
      timeout: VULNERABLE_LOCATOR_TIMEOUT_MS,
      deadline,
    });
    const q1Steer = queuedMessageRow(page, QUEUED_TEXT.q1).getByRole("button", {
      name: `Steer queued message: ${QUEUED_TEXT.q1}`,
      exact: true,
    });
    const [preClickStopCount, preClickQueue, preClickSteerCount] = await Promise.all([
      stopButton(page).count(),
      queuedMessageTexts(page),
      q1Steer.count(),
    ]);
    const preClickAt = Date.now();
    const preClickRemainingMs = barrierStartedAt + SLEEP_BARRIER_MS - preClickAt;
    if (
      preClickAt > deadline.expiresAt ||
      preClickStopCount !== 1 ||
      preClickSteerCount !== 1 ||
      preClickQueue.length !== 1 ||
      preClickQueue[0] !== QUEUED_TEXT.q1
    ) {
      throw new Error(
        `unsafe pre-click state: remaining=${preClickRemainingMs}ms stop=${preClickStopCount} steer=${preClickSteerCount} queue=${JSON.stringify(preClickQueue)}`,
      );
    }
    await q1Steer.click({ timeout: deadline.timeout("dispatching q1 Steer") });
    // Playwright resolves after it dispatched the click. Recording then is
    // conservative: the real dispatch cannot be later than this instant.
    const postClickAt = Date.now();
    const postClickRemainingMs = barrierStartedAt + SLEEP_BARRIER_MS - postClickAt;
    if (postClickRemainingMs < MIN_PRECLICK_SLEEP_REMAINING_MS) {
      throw new Error(`q1 Steer dispatched with only ${postClickRemainingMs}ms of sleep remaining`);
    }
    const immediatePeers = (await queuedMessageTexts(page)).filter(
      (text) => text !== QUEUED_TEXT.q1,
    );
    if (immediatePeers.length > 0) {
      throw new Error(`queued peer survived the steer click: ${JSON.stringify(immediatePeers)}`);
    }
    await waitForComposerState(page, [], {
      focused: true,
      working: true,
      timeout: deadline.timeout("confirming q1 Steer", 1500),
      deadline,
    });
    return {
      barrierStartedAt: activeSleep.startedAt,
      preClickRemainingMs,
      postClickRemainingMs,
    };
  });
}

async function main() {
  await ensurePiAuthInto(fakeHome);
  await fs.mkdir(fakeHome, { recursive: true });

  const app = await launch({
    dbPath,
    userDataDir,
    extraEnv: { HOME: fakeHome, VOLLI_WORKTREE_HOME_DIR: worktreesRoot },
  });
  const mainStdout = [];
  const mainStderr = [];
  const proc = app.process();
  proc.stdout?.on("data", (chunk) => mainStdout.push(chunk.toString()));
  proc.stderr?.on("data", (chunk) => mainStderr.push(chunk.toString()));
  const abortMainBeforeEvidence = async (page, label) => {
    const outcome = await closeAppBounded(app);
    await captureFailureEvidence(page, mainStdout, mainStderr, label);
    return outcome;
  };

  let chatTabLabel = null;
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    assertBuiltRendererLoaded(page);
    await sleep(1000);

    const projectPath = await makeGitRepo(scratch, "pi-ticket-chat-");
    await seedProjects(page, [{ ...PROJECT, path: projectPath }]);
    await goToBoard(page);
    const { byName } = await readSeededProjects(page);
    const projectId = byName[PROJECT.name]?.id;
    if (!projectId) throw new Error("seeded project missing after import");

    let defaultModel = null;
    await attempt(
      1,
      "seed the app default model — every Session, Ticket or Project, now requires one before it can start",
      async () => {
        defaultModel = await seedDefaultModel(page, MODEL_PIN);
        return { ok: defaultModel !== null, detail: JSON.stringify(defaultModel) };
      },
    );

    let displayId = null;
    let ticketId = null;
    await attempt(2, "seed a ticket through the preload bridge", async () => {
      const result = await page.evaluate((input) => window.api.tickets.create(input), {
        projectId,
        status: "todo",
        title: "Pi ticket chat smoke ticket",
        priority: "medium",
      });
      if (!result.ok) return { ok: false, detail: result.error };
      ticketId = result.ticket.id;
      displayId = `${PROJECT.prefix}-${result.ticket.ticketNumber}`;
      await page.reload();
      await page.waitForLoadState("domcontentloaded");
      await sleep(1000);
      await goToBoard(page);
      return { ok: (await cardById(page, displayId).count()) === 1, detail: displayId };
    });
    if (displayId === null) throw new Error("ticket seed failed — cannot continue");

    await attempt(3, "open the seeded ticket's detail", async () => {
      await cardById(page, displayId).dblclick();
      await waitUntil(
        "the ticket detail to open",
        async () => (await page.getByRole("tab", { name: displayId, exact: true }).count()) === 1,
      );
      return { ok: true };
    });

    let sessionId = null;
    await attempt(
      4,
      "the tab strip's own Chat control creates a chat tab (attaches Pi)",
      async () => {
        chatTabLabel = await openNewChatTab(page, TICKET_TAB_STRIP);
        sessionId = await waitUntil(
          "the ticket chat Session to enter the durable listing",
          async () => {
            const listed = await page.evaluate(
              (id) => window.api.sessions.listForTicket({ ticketId: id }),
              ticketId,
            );
            if (!listed.ok) throw new Error(listed.error);
            const chat = listed.sessions.find((row) => row.kind === "chat");
            return chat?.kind === "chat" ? chat.record.sessionId : false;
          },
        );
        return {
          ok: chatTabLabel !== null && sessionId !== null,
          detail: `tab=${chatTabLabel} session=${sessionId}`,
        };
      },
    );
    if (sessionId === null) throw new Error("chat Session seed failed — cannot continue");

    // Carried over from the retired session-chat-smoke.mjs: a chat on
    // a worktree ticket must attach against the materialized worktree, not
    // a directory that was never provisioned.
    await attempt(5, "creating the chat materialized the ticket's worktree", async () => {
      const worktreeDir = await waitUntil(
        "the ticket's worktree to appear on disk",
        async () => (await findWorktreeDir(worktreesRoot, displayId)) ?? false,
        { timeout: 20000 },
      ).catch(async (error) => {
        await abortMainBeforeEvidence(page, "worktree-absent");
        throw error;
      });
      const row = await page.evaluate(async (pid) => {
        const boot = await window.api.data.bootstrap();
        if (!boot.ok) return null;
        return (
          (boot.data.ticketsByProject?.[pid] ?? []).find((t) => t.worktreePath !== null) ?? null
        );
      }, projectId);
      return {
        ok: row !== null && row.worktreePath === worktreeDir,
        detail: `dir=${worktreeDir} stamped=${row?.worktreePath ?? "none"}`,
      };
    });
    if (!results.find((result) => result.n === 5)?.ok) {
      throw new Error("worktree check failed — cannot continue to the billed turn");
    }

    await attempt(
      6,
      "the composer is ready, its Model pill naming the recorded model (not the unselected placeholder)",
      async () => {
        const textarea = messageBox(page);
        await waitUntil("the composer to mount", async () => (await textarea.count()) > 0);
        await waitUntil(
          "the composer to become ready",
          async () => !(await textarea.isDisabled()),
          { timeout: 30000 },
        ).catch(async (error) => {
          await abortMainBeforeEvidence(page, "composer-inert");
          throw error;
        });
        // Every structured Session offers the Model Access pill now, Ticket
        // or Project alike (`chat-plane.tsx` dropped its old "pinned"
        // carve-out), so the picker existing is not the regression to watch
        // for. What has to hold is that it names the model THIS Session
        // recorded (check 1's seed) rather than the bare "Model" placeholder
        // a Session with nothing selected shows.
        const pill = page.getByRole("button", { name: defaultModel.label });
        const shown = await waitUntil(
          "the model pill to name the recorded model",
          async () => (await pill.count()) > 0,
        )
          .then(() => true)
          .catch(() => false);
        const placeholderShown =
          (await page.getByRole("button", { name: "Model", exact: true }).count()) > 0;
        return {
          ok: shown && !placeholderShown,
          detail: `label=${defaultModel.label} shown=${shown} placeholderShown=${placeholderShown}`,
        };
      },
    );
    if (!results.find((result) => result.n === 6)?.ok) {
      throw new Error("composer readiness check failed — cannot continue to the billed turn");
    }
    await installLiveActivityProbe(page, sessionId);

    let submittedAt = null;
    await attempt(
      7,
      "submitting the one real prompt starts a turn (streaming/working state appears)",
      async () => {
        // Every locator in the billing-sensitive interval now has a hard local
        // ceiling. `waitUntil` cannot bound a callback whose locator itself is
        // still waiting on Playwright's much longer default.
        page.setDefaultTimeout(VULNERABLE_LOCATOR_TIMEOUT_MS);
        try {
          submittedAt = await submitPrompt(page, PROMPT_TEXT);
          await waitUntil("the turn to start", async () => (await stopButton(page).count()) > 0, {
            timeout: 15000,
          });
          return { ok: true };
        } catch (error) {
          await abortMainBeforeEvidence(page, "turn-never-started");
          throw error;
        }
      },
    );
    if (!results.find((result) => result.n === 7)?.ok) {
      throw new Error("turn start check failed — app stopped before evidence");
    }

    let sleepBarrierStartedAt = null;
    await attempt(
      8,
      "q2 proves overlay behavior before an active sleep barrier admits q1's direct Steer",
      async () => {
        try {
          // The primitive has a motion-reduce escape hatch. Select the normal
          // branch explicitly, then let animationstart prove the
          // exact controlled content's 150 ms enter animation without racing a
          // post-completion getAnimations() sample.
          await page.emulateMedia({ reducedMotion: "no-preference" });
          const visualSleep = await waitUntil(
            `an in-progress ${SLEEP_COMMAND} activity before q2`,
            async () => {
              const activity = await readLiveSleepActivity(page);
              return isInProgressSleepActivity(activity) ? activity : false;
            },
            { timeout: 15000, interval: 100 },
          );
          // q2's aggregate watchdog reserves the full 6s close path plus 2s,
          // including operations such as viewport/protocol reads that have no
          // Playwright locator timeout of their own.
          const q2 = await runQ2OverlayScenario(page, sessionId, visualSleep);
          // q1 cannot enter this helper until q2 is absent in both the composer
          // and the durable snapshot. Its own aggregate watchdog covers every
          // admission read through the actual Steer click.
          const q1 = await runQ1SteerScenario(page, visualSleep.startedAt);
          sleepBarrierStartedAt = q1.barrierStartedAt;
          return {
            ok: true,
            detail:
              `visual=${QUEUED_TEXT.q2} barrierRemaining=${q2.barrierTiming.remainingMs}ms ` +
              `preClickRemaining=${q1.preClickRemainingMs}ms ` +
              `postClickRemaining=${q1.postClickRemainingMs}ms ` +
              `motion=${q2.menuEvidence.start?.name}/${q2.menuEvidence.start?.durationMs}ms ` +
              `shots=${q2.normalShot},${q2.narrowShot}`,
          };
        } catch (error) {
          // One fast census before anything slow (#233): four straight
          // failures said only "timeout", which cannot distinguish a missing
          // button from a hidden one from a hung renderer. Race-guarded,
          // because a renderer that cannot answer in 3s IS the diagnosis.
          const census = await Promise.race([
            page
              .evaluate((label) => {
                const rows = document.querySelectorAll(
                  '[role="group"][aria-label^="Queued message:"]',
                );
                const byAttr = document.querySelectorAll(`[aria-label=${JSON.stringify(label)}]`);
                const first = byAttr[0] ?? null;
                const rect = first?.getBoundingClientRect() ?? null;
                return {
                  rows: rows.length,
                  byAttr: byAttr.length,
                  display: first ? getComputedStyle(first).display : null,
                  visibility: first ? getComputedStyle(first).visibility : null,
                  rect: rect
                    ? {
                        x: Math.round(rect.x),
                        y: Math.round(rect.y),
                        w: rect.width,
                        h: rect.height,
                      }
                    : null,
                };
              }, `Queued message actions: ${QUEUED_TEXT.q2}`)
              .catch((censusError) => ({ censusError: String(censusError) })),
            sleep(3000).then(() => ({ censusError: "census hung >3s (renderer unresponsive)" })),
          ]);
          console.log(`  q2 failure census: ${JSON.stringify(census)}`);
          // This must be the first slow action after a manipulation failure.
          // A queued row cannot drain while screenshots/logs are collected.
          await abortMainBeforeEvidence(page, "composer-overlay-failed");
          throw error;
        }
      },
    );
    if (!results.find((result) => result.n === 8)?.ok) {
      // Never let a failed manipulation fall through into settlement: a row we
      // failed to delete could become a separately billed follow-up turn.
      throw new Error("composer overlay check failed — closing instead of risking a queued turn");
    }
    if (sleepBarrierStartedAt === null) {
      throw new Error("composer overlay check retained no active sleep barrier");
    }

    // One aggregate user turn, on ONE clock started at the keystroke above —
    // the tool loop may make more than one provider request, but no second
    // queued user turn may start. See `waitForSettledReply` and
    // `PI_TURN_BUDGET_MS` for the measured ceiling.
    let preCloseSession = null;
    await attempt(
      9,
      "one turn completes sleep 60, records q1 as steer, and replies with STEER_ACCEPTED",
      async () => {
        try {
          page.setDefaultTimeout(NORMAL_LOCATOR_TIMEOUT_MS);
          const settled = await waitForSettledReply(page, { since: submittedAt });
          // The first delivered message names the Session (`chat/client.ts`'s
          // `#autoTitle`), so the "Chat 1" captured at creation is no longer what
          // the tab is called. Re-read it, or the relaunch below looks for a tab
          // that stopped existing the moment the prompt landed.
          chatTabLabel = await activeTabLabel(page, TICKET_TAB_STRIP);
          const durable = await readSessionEvidence(page, sessionId);
          const marker = await waitUntil(
            "Pi's recovery sidecar to record q1's delivery mode",
            async () => (await readPiDeliveryMarker(durable.commandId)) ?? false,
            { timeout: 10000, interval: 100 },
          );
          const sleepActivity = durable.sleepActivity;
          const replyIncludesSentinel = settled.texts.some((text) => text.includes(EXPECTED_REPLY));
          const elapsedEnough = settled.elapsedMs >= MIN_COMPLETED_SLEEP_MS;
          preCloseSession = {
            throughSequence: durable.throughSequence,
            projection: durable.projection,
          };
          const steerRecorded =
            marker.operation === "message.submit" &&
            marker.delivery === "steer" &&
            marker.message === QUEUED_TEXT.q1;
          const proven =
            replyIncludesSentinel &&
            elapsedEnough &&
            sleepActivity?.command === SLEEP_COMMAND &&
            sleepActivity?.kind === "run-command" &&
            sleepActivity.nativeToolName === "bash" &&
            sleepActivity.startedAt === sleepBarrierStartedAt &&
            sleepActivity.endedAt !== null &&
            sleepActivity.durationMs !== null &&
            sleepActivity.durationMs >= MIN_COMPLETED_SLEEP_MS &&
            steerRecorded &&
            chatTabLabel !== null &&
            durable.ok &&
            durable.projection.liveExecutor?.id !== undefined &&
            durable.turnSummary.exactlyOneCompletedTurn;
          if (!proven) throw new Error("settled turn evidence did not satisfy the contract");
          return {
            ok: true,
            detail:
              `turn=${(settled.elapsedMs / 1000).toFixed(1)}s ` +
              `activity=${((sleepActivity?.durationMs ?? 0) / 1000).toFixed(1)}s ` +
              `delivery=${marker.delivery} replies=${settled.texts.length} ` +
              `sentinel=${replyIncludesSentinel} turn=${durable.turnSummary.startedIds[0]}`,
          };
        } catch (error) {
          await abortMainBeforeEvidence(page, "turn-evidence-failed");
          throw error;
        }
      },
    );
    if (!results.find((result) => result.n === 9)?.ok) {
      throw new Error("original turn check failed — preserving evidence without relaunching");
    }
    if (preCloseSession === null) throw new Error("pre-close Session snapshot was not retained");

    // ---- relaunch on the same profile, adopt (no live attach), and assert
    // the DURABLE transcript is what renders both sides of the exchange.
    await sleep(500);
    await requireGracefulClose(app, "pre-relaunch Electron main");

    const app2 = await launch({
      dbPath,
      userDataDir,
      extraEnv: { HOME: fakeHome, VOLLI_WORKTREE_HOME_DIR: worktreesRoot },
    });
    const relaunchStdout = [];
    const relaunchStderr = [];
    const proc2 = app2.process();
    proc2.stdout?.on("data", (chunk) => relaunchStdout.push(chunk.toString()));
    proc2.stderr?.on("data", (chunk) => relaunchStderr.push(chunk.toString()));
    const abortRelaunchBeforeEvidence = async (pageToCapture, label) => {
      const outcome = await closeAppBounded(app2);
      await captureFailureEvidence(pageToCapture, relaunchStdout, relaunchStderr, label);
      return outcome;
    };
    try {
      const page2 = await app2.firstWindow();
      await page2.waitForLoadState("domcontentloaded");
      assertBuiltRendererLoaded(page2);

      await attempt(
        10,
        "relaunch renders durable history without opening a live executor or adding runtime frames",
        async () => {
          try {
            const relaunchBeforeView = await waitUntil(
              "the relaunched Session projection to have no live executor",
              async () => {
                const evidence = await readSessionEvidence(page2, sessionId);
                return evidence.projection.liveExecutor == null ? evidence : false;
              },
              { timeout: 10000 },
            );
            const detailOpen = await waitUntil(
              "the ticket detail to reopen",
              async () =>
                (await page2.getByRole("tab", { name: displayId, exact: true }).count()) === 1,
              { timeout: 10000 },
            )
              .then(() => true)
              .catch(() => false);
            if (!detailOpen) {
              await cardById(page2, displayId)
                .dblclick()
                .catch(() => {});
            }
            const chatTab = page2.getByRole("tab", { name: chatTabLabel, exact: true });
            if ((await chatTab.count()) === 0) {
              await waitUntil(
                "the chat tab to be reachable",
                async () => (await chatTab.count()) > 0,
                { timeout: 10000 },
              );
            }
            await chatTab.click();
            // A durable q1 must reconcile its crash-safe held copy by identity,
            // while deleted q2 must remain absent from both the queue and box.
            await waitForComposerState(page2, [], { value: "", timeout: 10000 });
            const rendered = await waitUntil(
              "the durable original prompt, q1 steer, and reply sentinel to render without a live adapter",
              async () => {
                const userTexts = await userMessageTexts(page2);
                const assistantTexts = await assistantReplyTexts(page2);
                const originalShown = userTexts.some((text) => text.includes(PROMPT_TEXT));
                const q1Shown = userTexts.some((text) => text.includes(QUEUED_TEXT.q1));
                const forbiddenShown = [QUEUED_TEXT.q2].filter((text) =>
                  userTexts.some((renderedText) => renderedText.includes(text)),
                );
                const replyIncludesSentinel = assistantTexts.some((text) =>
                  text.includes(EXPECTED_REPLY),
                );
                return originalShown &&
                  q1Shown &&
                  forbiddenShown.length === 0 &&
                  replyIncludesSentinel
                  ? { userTexts, assistantTexts, forbiddenShown, replyIncludesSentinel }
                  : false;
              },
              { timeout: 10000 },
            ).catch(() => null);
            const durable = await readSessionEvidence(page2, sessionId);
            const newRuntimeFrames = durable.frameSummaries.filter(
              (frame) =>
                frame.sequence > preCloseSession.throughSequence &&
                LIVE_RUNTIME_FRAME_KINDS.has(frame.kind),
            );
            const beforeLiveExecutor = relaunchBeforeView.projection.liveExecutor ?? null;
            const afterLiveExecutor = durable.projection.liveExecutor ?? null;
            const proven =
              rendered !== null &&
              durable.ok &&
              relaunchBeforeView.throughSequence >= preCloseSession.throughSequence &&
              beforeLiveExecutor === null &&
              afterLiveExecutor === null &&
              newRuntimeFrames.length === 0 &&
              durable.turnSummary.exactlyOneCompletedTurn;
            if (!proven) throw new Error("relaunch evidence did not satisfy the contract");
            return {
              ok: true,
              detail:
                `user=${rendered.userTexts.length} assistant=${rendered.assistantTexts.length} ` +
                `sequence=${preCloseSession.throughSequence}->${durable.throughSequence} ` +
                `live=${JSON.stringify(beforeLiveExecutor)}->${JSON.stringify(afterLiveExecutor)} ` +
                `newRuntimeFrames=${newRuntimeFrames.length}`,
            };
          } catch (error) {
            await abortRelaunchBeforeEvidence(page2, "relaunch-evidence-mismatch");
            throw error;
          }
        },
      );
    } finally {
      const relaunchPassed = results.find((result) => result.n === 10)?.ok === true;
      if (relaunchPassed) await requireGracefulClose(app2, "relaunch Electron main");
      else await closeAppBounded(app2);
    }

    console.log(`\nEvidence dir: ${EVIDENCE_DIR}`);
  } finally {
    await closeAppBounded(app);
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
  await cleanup().catch(() => {});
}
process.exit(code);
