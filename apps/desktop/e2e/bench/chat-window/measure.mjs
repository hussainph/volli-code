/** Measurement sequence only. The volli-drive supervisor owns every live resource.
 * No Electron import, app lifecycle or standalone launcher lives here.
 */
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

export async function measureChatWindow({ contents, rendererRssMb, settings, pause = sleep }) {
  const {
    sessions: SESSIONS,
    turns: TURNS,
    label: LABEL,
    arm: ARM,
    streamSamples: STREAM_SAMPLES,
    streamSteps: STREAM_STEPS,
    streamTokenRate: STREAM_TOKEN_RATE,
    streamContent: STREAM_CONTENT,
    draftPlanes: DRAFT_PLANES,
    draftBallast: DRAFT_BALLAST,
    draftKeys: DRAFT_KEYS,
    draftKeyInterval: DRAFT_KEY_INTERVAL_MS,
    draftCpuThrottle: DRAFT_CPU_THROTTLE,
    revealPlanes: REVEAL_PLANES,
    revealSwitches: REVEAL_SWITCHES,
    revealInterval: REVEAL_INTERVAL_MS,
    revealBallast: REVEAL_BALLAST,
    revealCpuThrottle: REVEAL_CPU_THROTTLE,
  } = settings;
  const errors = [];
  const run = (expression) => contents.executeJavaScript(expression);
  /**
   * One step's numbers. RSS is the MEDIAN of three readings a third of a second
   * apart, because a single one is worth ±30MB: the working set moves while
   * Chromium finishes rasterizing, trims caches and answers the collect() above.
   * DOM node count needs none of that — it is exact.
   */
  const sample = async (step) => {
    await run("window.chatBench.collect()");
    await pause(600);
    const readings = [];
    for (let index = 0; index < 3; index += 1) {
      readings.push(await rendererRssMb());
      await pause(320);
    }
    readings.sort((a, b) => a - b);
    return {
      step,
      nodes: await run("window.chatBench.nodes()"),
      rendererRssMb: readings[1],
      rssSpreadMb: readings[2] - readings[0],
      jsHeapMb: Math.round((await run("performance.memory?.usedJSHeapSize ?? 0")) / 1_048_576),
    };
  };

  const report = {
    label: LABEL,
    sessions: SESSIONS,
    turns: TURNS,
    steps: [],
    checks: {},
    streamingSamples: [],
    errors,
  };
  async function streamSamples() {
    for (let index = 0; index < STREAM_SAMPLES; index += 1) {
      const streamingSample = await run(
        `window.chatBench.streamAndScroll(0, ${STREAM_STEPS}, ${STREAM_TOKEN_RATE}, ${JSON.stringify(STREAM_CONTENT)})`,
      );
      report.streamingSamples.push({
        ...streamingSample,
        rendererRssMb: await rendererRssMb(),
      });
    }
  }
  /** The VC-338 steps: mount, scroll, stream, and many planes at once. */
  async function transcriptArm() {
    // Every Session's transcript is in the store and no plane is drawn: the
    // floor every later step is measured against.
    report.steps.push(await sample("seeded, no plane"));

    await run("window.chatBench.show(1)");
    report.steps.push(await sample("1 plane"));

    report.checks.firstTurn = await run("window.chatBench.reachFirst(0, 200)");
    report.checks.tail = await run("window.chatBench.tailProbe(0)");
    // Back to a fresh mount of the same plane so the scroll probes above cannot
    // leave revealed pages in the steps that follow.
    await run("window.chatBench.show(0)");
    await run(`window.chatBench.show(1)`);
    report.steps.push(await sample("1 plane, after scrolling"));

    // VC-353's simultaneous stream+scroll interaction. Repeated inside one
    // production renderer so p50/p95 and variance describe the interaction,
    // not Electron process startup.
    await streamSamples();

    await run(`window.chatBench.show(${SESSIONS})`);
    report.steps.push(await sample(`${SESSIONS} planes`));

    await run("window.chatBench.show(1)");
    report.steps.push(await sample("back to 1 plane"));
  }

  /**
   * Type into an empty Draft beside `DRAFT_PLANES` long transcripts and a
   * `DRAFT_BALLAST`-node stand-in for the sidebar and board, through Chromium's
   * trusted input path. Lower-case letters with a space every sixth key, at a
   * fixed cadence a fast typist reaches; the renderer probe does the timing.
   */
  async function draftArm() {
    const shown = await run(`window.chatBench.showDraft(${DRAFT_PLANES}, ${DRAFT_BALLAST})`);
    report.steps.push({ step: "draft shown", nodes: shown.nodes });
    if (DRAFT_CPU_THROTTLE > 1) {
      await contents.debugger.sendCommand("Emulation.setCPUThrottlingRate", {
        rate: DRAFT_CPU_THROTTLE,
      });
      await pause(500);
    }
    if (!(await run("window.chatBench.startTyping()"))) throw new Error("no draft textarea");
    await run("performance.mark('chat-bench:start')");
    for (let index = 0; index < DRAFT_KEYS; index += 1) {
      const key = index % 6 === 5 ? " " : String.fromCharCode(97 + (index % 26));
      const keyCode = key === " " ? "Space" : key;
      // One main-process dispatch, as in the original bench: no IPC/rAF gap
      // between keyDown and insertion that could report paint before the key.
      await contents.sendInputEvents([
        { type: "keyDown", keyCode },
        { type: "char", keyCode: key },
        { type: "keyUp", keyCode },
      ]);
      await pause(DRAFT_KEY_INTERVAL_MS);
    }
    report.draftTyping = await run("window.chatBench.stopTyping()");
    await run("performance.mark('chat-bench:end')");
  }

  /**
   * Press the cell's "Next chat" button through Chromium's trusted input path,
   * `REVEAL_SWITCHES` times, each press revealing a kept chat that was drawn
   * before. Before the timed presses: every plane is shown once (a kept view
   * is one the reader has seen), and the reader of the first plane scrolls up,
   * so the check after the run can prove a revealed view still lands where its
   * reader left it rather than at the bottom.
   */
  async function revealArm() {
    const shown = await run(`window.chatBench.showReveal(${REVEAL_PLANES}, ${REVEAL_BALLAST})`);
    report.steps.push({ step: "reveal cell shown", nodes: shown.nodes });
    const rect = await run(
      "(() => { const r = document.querySelector('[data-bench-switch]').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()",
    );
    const press = async () => {
      await contents.sendInputEvents([
        { type: "mouseDown", x: rect.x, y: rect.y, button: "left", clickCount: 1 },
        { type: "mouseUp", x: rect.x, y: rect.y, button: "left", clickCount: 1 },
      ]);
      await pause(REVEAL_INTERVAL_MS);
    };
    // Every plane drawn once, then back to the first.
    for (let index = 0; index < REVEAL_PLANES; index += 1) await press();
    const pinned = await run("window.chatBench.revealState()");
    // A real wheel, not a `scrollTop` write: the bottom lock only lets go for
    // a reader's own gesture, and only a reader's position is restored.
    for (let index = 0; index < 15; index += 1) {
      await contents.sendInputEvent({
        type: "mouseWheel",
        x: rect.x,
        y: 450,
        deltaX: 0,
        deltaY: 100,
      });
      await pause(16);
    }
    await pause(REVEAL_INTERVAL_MS);
    const scrolled = await run("window.chatBench.revealState()");
    for (let index = 0; index < REVEAL_PLANES; index += 1) await press();
    report.checks.revealRestore = {
      pinnedBefore: pinned,
      scrolledBefore: scrolled,
      afterRoundTrip: await run("window.chatBench.revealState()"),
    };
    // Back to the bottom so every timed reveal is the pinned common case.
    for (let index = 0; index < 60; index += 1) {
      await contents.sendInputEvent({
        type: "mouseWheel",
        x: rect.x,
        y: 450,
        deltaX: 0,
        deltaY: -200,
      });
      await pause(16);
    }
    await pause(REVEAL_INTERVAL_MS);
    if (REVEAL_CPU_THROTTLE > 1) {
      await contents.debugger.sendCommand("Emulation.setCPUThrottlingRate", {
        rate: REVEAL_CPU_THROTTLE,
      });
      await pause(500);
    }
    if (!(await run("window.chatBench.startReveal()"))) throw new Error("no reveal switch");
    await run("performance.mark('chat-bench:start')");
    for (let index = 0; index < REVEAL_SWITCHES; index += 1) await press();
    report.revealSwitch = await run("window.chatBench.stopReveal()");
    await run("performance.mark('chat-bench:end')");
    report.checks.revealPinned = await run("window.chatBench.revealState()");
  }

  try {
    await run("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))");
    // The first seconds of a renderer's life are its noisiest: fonts, the first
    // compositor frame, the module graph's own allocations. Let them finish
    // before anything is called a baseline.
    await pause(2500);

    report.steps.push(await sample("empty"));
    await run(`window.chatBench.seed(${SESSIONS}, ${TURNS})`);
    if (ARM === "draft") await draftArm();
    else if (ARM === "reveal") await revealArm();
    else if (ARM === "stream") {
      await run("window.chatBench.show(1)");
      await streamSamples();
    } else await transcriptArm();
  } catch (error) {
    report.failure = String(error && error.stack ? error.stack : error);
  }

  // Console text alone names the error and not its origin. The harness fails a
  // run on any renderer error, so carry the stacks out with the report.
  try {
    report.errorDetails = await run("window.chatBench.uncaught()");
  } catch {
    report.errorDetails = [];
  }

  return report;
}
