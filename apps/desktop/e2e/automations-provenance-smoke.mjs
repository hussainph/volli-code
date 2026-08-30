/**
 * Provenance marks for Run-started Sessions (VC-131), driven through the REAL
 * packed app.
 *
 * VC-112's rule is that a Session a Run created must be distinguishable from
 * one a person started **everywhere a Session appears**, with exactly three
 * answers and no fourth. Two of those three are things the app must NOT draw,
 * and an absence is precisely what a unit test is worst at proving — so this
 * probe drives the resting case through the real bridge, the real stylesheet
 * and the real DOM.
 *
 * What it proves, in dependency order:
 *   1. A Session's provenance crosses the listing seam at all: `sessions.list`
 *      and `sessions.listForTicket` carry it on the ROW, beside `usage`.
 *   2. A Session a person opened reads as the resting case, and the rail it
 *      appears in draws no mark and no tooltip for it — the acceptance
 *      criterion "a resting rail gains no persistent visual weight".
 *   3. A ticketless Session (a Project Session) reads the same way, which is
 *      the branch that never consults the planner log at all.
 *   4. EVERY surface that draws a Session stays quiet for it, not just the
 *      rail: the Session's own header (the tab strip — `chat-plane.tsx` draws
 *      no other) and the app's global Session listing (the command palette).
 *      "Everywhere a Session appears" is a claim about all of them at once, so
 *      the probe walks all of them rather than the one that was written first.
 *   5. The board card's ring means LIVE, not finishing: `live` is a lit ring
 *      standing still, `working` is the one that travels, and both are the
 *      same colour so motion is the only thing that separates them.
 *   6. Reduced motion keeps the signifier and removes only the motion: the
 *      ring is still displayed, still lit, and no longer animating.
 *
 * WHAT IT DOES NOT DRIVE, and why. The bolt itself needs a Run; a Run's first
 * durable write is a Session, and `mint` resolves a model BEFORE it writes
 * anything — so with no default model the Run cannot get far enough to leave a
 * marked Session behind, and a default model means provider credentials and
 * spent tokens. This profile therefore has none, and the Run below lands on the
 * Session start's own `MODEL_REQUIRED` refusal, exactly as `automations-smoke`
 * and `automations-arming-smoke` already do for the same reason. The drawn bolt
 * and the named parent are pinned instead by the render tests against the same
 * components this app is running — `session-band-row.test.tsx` and
 * `ticket-sessions-panel-rows.test.tsx` for the two listings,
 * `ticket/ticket-tab-provenance.test.tsx` and
 * `home/home-tab-provenance.test.tsx` for the two headers,
 * `command-palette-model.test.ts` for the global list — and the derivation
 * behind them by `session-provenance-repo.test.ts`.
 *
 * What this probe uniquely owns is the ABSENCES, which are what those tests are
 * worst at: it walks the real app's whole document, on every surface at once,
 * and requires that nothing anywhere has drawn a mark for a Session a person
 * opened.
 *
 * No fixed sleeps: every wait is `waitUntil` on a signal the app produced.
 *
 * MANUALLY RUN (needs a display + the built app):
 *
 *   pnpm -w run build
 *   node apps/desktop/e2e/automations-provenance-smoke.mjs
 */
import {
  assertBuiltRendererLoaded,
  assertProfileIsolated,
  closeAppBounded,
  createRunner,
  HOME_TAB_STRIP,
  launch,
  makeGitRepo,
  makeScratch,
  seedProjects,
  startTerminalSession,
  tabStrip,
  waitUntil,
} from "./lib/smoke-kit.mjs";

const { scratch, userDataDir, dbPath, cleanup } = await makeScratch("volli-provenance-");
const { attempt, must, summarize } = createRunner();

console.log("scratch:", scratch, "\n");

/**
 * The ring's own computed facts, read off a probe element the real stylesheet
 * is applied to. The card that would wear it needs a live Run to light it, so
 * the rule is exercised where it is written rather than where it eventually
 * lands — `board-session-activity.test.ts` owns which word a card gets.
 */
async function ringFacts(page, activity) {
  return page.evaluate((state) => {
    const probe = document.createElement("span");
    probe.className = "session-ring";
    if (state !== null) probe.dataset.activity = state;
    // Inside a bordered box, as on a card: the rule inherits its radius and is
    // positioned against a containing block.
    const host = document.createElement("div");
    host.style.position = "relative";
    host.style.border = "1px solid";
    host.append(probe);
    document.body.append(host);
    const box = getComputedStyle(probe);
    const arc = getComputedStyle(probe, "::before");
    const facts = {
      // Whether the ring generates boxes at all. Its own `opacity` is
      // deliberately NOT read: the layer fades in through `@starting-style`, so
      // a synchronous read one statement after `append` always sees the start
      // value and would say nothing about the settled ring.
      display: box.display,
      animationName: arc.animationName,
      // The lit-but-still states paint the whole perimeter; the travelling one
      // carries a conic gradient with a single bright arc.
      background: arc.backgroundImage === "none" ? "solid" : "gradient",
      arcOpacity: arc.opacity,
    };
    host.remove();
    return facts;
  }, activity);
}

/**
 * The two facts every check below reads off a listing row — which Session, and
 * who started it. Shaped here rather than inside `page.evaluate`, so the two
 * doors are compared by one expression that lives in one place.
 */
function shape(listing) {
  if (!listing.ok) return [];
  return listing.sessions.map((row) => ({
    id: row.kind === "terminal" ? row.record.id : row.record.sessionId,
    provenance: row.provenance,
  }));
}

/**
 * Every provenance mark the whole document is currently drawing.
 *
 * Both halves of the feature, counted the way each is actually spelled: the
 * bolt announces itself with an accessible name that always begins "Started
 * by" (the Automation named, or not), and the `session` arm's whole mark is a
 * line inside a `title` — the tooltip a row or a tab already had.
 *
 * Document-wide on purpose. The rule under test is about ALL of the surfaces at
 * once, so a probe scoped to one of them would go green the day a second
 * surface started drawing a mark it should not.
 */
async function marksOnScreen(page) {
  return page.evaluate(() => ({
    bolts: document.querySelectorAll('[aria-label^="Started by"]').length,
    provenanceTooltips: [...document.querySelectorAll("[title]")].filter((node) => {
      const title = node.getAttribute("title") ?? "";
      return title.includes("Started by") || title.includes("Automation · ");
    }).length,
  }));
}

let app = null;
let exitCode = 1;
try {
  const repoDir = await makeGitRepo(scratch);
  app = await launch({ dbPath, userDataDir });
  const page = await app.firstWindow();
  page.on("pageerror", (error) => console.log("[pageerror]", String(error).slice(0, 400)));
  assertBuiltRendererLoaded(page);
  await assertProfileIsolated(app, userDataDir);
  await page.waitForSelector("[data-empty-projects-state]", { timeout: 30000 });
  await seedProjects(page, [{ id: "probe-project", name: "Probe", path: repoDir, prefix: "PRB" }]);

  const seeded = await page.evaluate(async () => {
    const boot = await window.api.data.bootstrap();
    if (!boot.ok) return { fail: `bootstrap: ${boot.error}` };
    const project = boot.data.projects[0];
    if (project === undefined) return { fail: "no project imported" };
    const ticket = await window.api.tickets.create({
      projectId: project.id,
      title: "Probe ticket",
      status: "doing",
      usesWorktree: false,
    });
    return ticket.ok
      ? { projectId: project.id, projectPath: project.path, ticketId: ticket.ticket.id }
      : { fail: ticket.error };
  });
  await must(0, "a project and a ticket exist to open Sessions on", async () => ({
    ok: seeded.fail === undefined,
    detail: seeded.fail ?? `ticket=${seeded.ticketId}`,
  }));

  // === 1. PROVENANCE CROSSES THE LISTING SEAM ==============================
  // A terminal Session, because it needs no model: the point here is the seam,
  // not the executor. Both doors are asked, because both build their rows
  // through `sessionListingRows` and a fetch that dropped the field on one of
  // them would leave one surface unable to draw a mark the other could.
  const opened = await page.evaluate(async ({ projectId, projectPath, ticketId }) => {
    const onTicket = await window.api.terminal.create({
      workspaceId: projectId,
      cwd: projectPath,
      cols: 80,
      rows: 24,
      ticket: { ticketId },
    });
    const onProject = await window.api.terminal.create({
      workspaceId: projectId,
      cwd: projectPath,
      cols: 80,
      rows: 24,
    });
    return {
      ticketSession: onTicket.ok ? onTicket.sessionId : null,
      projectSession: onProject.ok ? onProject.sessionId : null,
      error: onTicket.ok ? (onProject.ok ? null : onProject.error) : onTicket.error,
    };
  }, seeded);
  await must(1, "two Sessions open — one on the Ticket, one on the project", async () => ({
    ok: opened.ticketSession !== null && opened.projectSession !== null,
    detail: opened.error ?? `ticket=${opened.ticketSession} project=${opened.projectSession}`,
  }));

  const listed = await waitUntil("both listing doors return the Sessions", async () => {
    const seen = await page.evaluate(
      async ({ projectId, ticketId }) => ({
        all: await window.api.sessions.list({ projectId }),
        forTicket: await window.api.sessions.listForTicket({ ticketId }),
      }),
      seeded,
    );
    const shaped = { all: shape(seen.all), forTicket: shape(seen.forTicket) };
    return shaped.all.length === 2 ? shaped : null;
  });

  await attempt(2, "every listing row carries who started its Session", async () => {
    const missing = listed.all.filter((row) => row.provenance === undefined);
    return {
      ok: missing.length === 0 && listed.forTicket.every((row) => row.provenance !== undefined),
      detail: `project rows=${listed.all.length} ticket rows=${listed.forTicket.length} missing=${missing.length}`,
    };
  });

  // === 2 & 3. THE RESTING CASE, BOTH WAYS IN ===============================
  await attempt(3, "a Session a person opened reads as the resting case", async () => {
    const ticketRow = listed.all.find((row) => row.id === opened.ticketSession);
    const projectRow = listed.all.find((row) => row.id === opened.projectSession);
    return {
      // The ticketed one consulted the planner log and found a `user` start;
      // the ticketless one is answered without touching it at all. Both must
      // arrive at the same quiet answer.
      ok: ticketRow?.provenance?.kind === "user" && projectRow?.provenance?.kind === "user",
      detail: `ticket=${JSON.stringify(ticketRow?.provenance)} project=${JSON.stringify(projectRow?.provenance)}`,
    };
  });

  await attempt(4, "the rail those Sessions appear in draws no mark at all", async () => {
    await waitUntil("the sidebar lists a Session", async () =>
      (await page.locator('[data-sidebar="menu-button"]').count()) > 0 ? true : null,
    );
    const marks = await marksOnScreen(page);
    return {
      ok: marks.bolts === 0 && marks.provenanceTooltips === 0,
      detail: `bolts=${marks.bolts} provenance tooltips=${marks.provenanceTooltips}`,
    };
  });

  // === 3b. THE SESSION'S OWN HEADER =======================================
  // The tab IS the header — `chat-plane.tsx` draws no other — so this is the
  // surface a Session is looked at on for longest, and the one where a missing
  // mark is least likely to be noticed as missing. Driven through the strip's
  // own control rather than through IPC, so the tab under test is the tab the
  // app makes.
  const header = await (async () => {
    await startTerminalSession(page);
    const strip = tabStrip(page, HOME_TAB_STRIP);
    return waitUntil("the Home strip mints a Session tab", async () => {
      const tabs = strip.getByRole("tab");
      const count = await tabs.count();
      // Past the permanent Board tab: the strip always has that one.
      if (count < 2) return null;
      const tab = tabs.nth(count - 1);
      return {
        label: await tab.getAttribute("aria-label"),
        title: await tab.getAttribute("title"),
        html: await tab.innerHTML(),
      };
    });
  })();

  await attempt(5, "a person's Session gets no mark on the header that names it", async () => ({
    // The tooltip is the label and nothing else: no provenance line was
    // appended, and no bolt took the badge slot.
    ok:
      header.title === header.label &&
      !header.html.includes("Started by") &&
      !header.html.includes("text-primary"),
    detail: `label=${header.label} title=${JSON.stringify(header.title)}`,
  }));

  // === 3c. THE GLOBAL SESSION LISTING =====================================
  // The palette lists every project's Sessions in one list, which makes it the
  // easiest place to mistake a Run's Session for one a person opened. It reads
  // its rows through the same `sessions.list` door check 1 asserted, so this
  // also proves provenance survives the palette's own flattening.
  const palette = await (async () => {
    await page.keyboard.press("Meta+k");
    const dialog = page.getByRole("dialog", { name: "Search tickets and sessions" });
    await dialog.waitFor({ state: "visible", timeout: 10000 });
    const rows = await waitUntil("the palette lists the open Sessions", async () => {
      const count = await dialog.getByRole("option").count();
      return count > 0 ? count : null;
    });
    const marks = await marksOnScreen(page);
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden", timeout: 10000 });
    return { rows, marks };
  })();

  await attempt(6, "the global Session listing stays quiet too", async () => ({
    ok: palette.rows > 0 && palette.marks.bolts === 0 && palette.marks.provenanceTooltips === 0,
    detail: `rows=${palette.rows} bolts=${palette.marks.bolts} provenance tooltips=${palette.marks.provenanceTooltips}`,
  }));

  // === 4. THE RING MEANS LIVE, NOT FINISHING ===============================
  const [off, working, waiting, live] = await Promise.all([
    ringFacts(page, null),
    ringFacts(page, "working"),
    ringFacts(page, "waiting"),
    ringFacts(page, "live"),
  ]);

  await attempt(7, "a card with nothing running generates no ring at all", async () => ({
    // `display: none` is what makes an unlit card free: no boxes, no
    // pseudo-element, no animation, at 150 cards.
    ok: off.display === "none",
    detail: `display=${off.display}`,
  }));

  await attempt(8, "`live` is the ring standing still, in `working`'s own colour", async () => ({
    ok:
      live.display === "block" &&
      live.animationName === "none" &&
      live.background === "solid" &&
      // Told apart from `working` by motion alone. Amber would send a reader to
      // a chat that has no question in it.
      working.animationName === "session-ring-sweep" &&
      working.background === "gradient",
    detail: `live=${live.display}/${live.animationName}/${live.background} working=${working.animationName}/${working.background}`,
  }));

  await attempt(9, "`waiting` keeps its own reading beside the new word", async () => ({
    ok: waiting.display === "block" && waiting.animationName === "none",
    detail: `waiting=${waiting.display}/${waiting.animationName}`,
  }));

  // === 5. REDUCED MOTION KEEPS THE SIGNIFIER ===============================
  await page.emulateMedia({ reducedMotion: "reduce" });
  const [reducedWorking, reducedLive] = await Promise.all([
    ringFacts(page, "working"),
    ringFacts(page, "live"),
  ]);
  await page.emulateMedia({ reducedMotion: null });

  await attempt(10, "reduced motion removes the motion and keeps the ring", async () => ({
    ok:
      // The signifier survives whole: the ring is still drawn, and the whole
      // perimeter is still lit rather than one arc parked somewhere on it.
      reducedWorking.display === "block" &&
      reducedWorking.background === "solid" &&
      // Only the travel is gone — and only the travel. It is dimmed rather than
      // hidden, which is a settled value the read above can see.
      reducedWorking.animationName === "none" &&
      Number(reducedWorking.arcOpacity) > 0 &&
      Number(reducedWorking.arcOpacity) < Number(working.arcOpacity) &&
      // And the state that was already still is untouched by the preference:
      // there was no motion in it to take away.
      reducedLive.animationName === "none" &&
      reducedLive.background === "solid",
    detail: `working=${reducedWorking.display}/${reducedWorking.animationName}/${reducedWorking.background}/${reducedWorking.arcOpacity} (full motion ${working.arcOpacity})`,
  }));

  // === 6. A RUN THAT CANNOT START MARKS NOTHING ============================
  // The refusal arm, for the reason the header gives. It still proves the one
  // thing this probe can prove about a Run without credentials: a Run that did
  // not happen leaves no Session and therefore no mark behind it.
  const refused = await page.evaluate(async ({ projectId, ticketId }) => {
    const created = await window.api.automations.create({
      commandId: crypto.randomUUID(),
      projectId,
      name: "Nightly sweep",
      instructions: "Sweep the branch.",
      trigger: { kind: "none" },
      runtime: null,
    });
    if (!created.ok) return { fail: `create: ${created.error}` };
    const run = await window.api.automations.run({
      commandId: crypto.randomUUID(),
      // A Run names its target since VC-129: a saved Automation here, or
      // an Unbound Run's own Instructions.
      target: { kind: "automation", automationId: created.automation.id },
      ticketId,
      modelOverride: null,
    });
    const after = await window.api.sessions.listForTicket({ ticketId });
    return {
      refusal: run.ok ? null : run.code,
      rows: after.ok ? after.sessions.length : -1,
      marked: after.ok ? after.sessions.filter((row) => row.provenance.kind !== "user").length : -1,
    };
  }, seeded);

  await attempt(11, "a Run with no model refuses, and marks nothing", async () => ({
    ok: refused.refusal === "MODEL_REQUIRED" && refused.rows === 1 && refused.marked === 0,
    detail: `refusal=${refused.refusal ?? refused.fail} rows=${refused.rows} marked=${refused.marked}`,
  }));

  exitCode = summarize("automations provenance");
} catch (error) {
  console.error("\nFAILED:", error);
} finally {
  if (app !== null) await closeAppBounded(app);
  await cleanup();
  process.exit(exitCode);
}
