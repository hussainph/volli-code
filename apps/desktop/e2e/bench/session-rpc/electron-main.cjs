const { app, BrowserWindow, ipcMain } = require("electron");
const { monitorEventLoopDelay } = require("node:perf_hooks");
const { join } = require("node:path");
const Database = require("better-sqlite3");
const { argument, parsePositiveInteger } = require("./helpers.cjs");

const epochNow = () => performance.timeOrigin + performance.now();
const databasePath = argument("database");
const repetitions = parsePositiveInteger("repetitions", 300);
const frameCount = parsePositiveInteger("frames", 20_000);

const fullLogSql = `SELECT e.id, e.session_id, e.sequence, e.occurred_at, e.recorded_at,
                           p.provenance, e.attachment_id, e.command_id, e.payload
                      FROM session_events e
                      LEFT JOIN session_provenances p ON p.id = e.provenance_id
                     ORDER BY e.session_id, e.sequence`;

function blockingSqliteScan(path) {
  const database = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const rows = database.prepare(fullLogSql).all();
    let serializedBytes = 0;
    for (const row of rows) {
      serializedBytes += row.payload.length + row.provenance.length;
      JSON.parse(row.provenance);
      JSON.parse(row.payload);
    }
    return { rows: rows.length, serializedBytes };
  } finally {
    database.close();
  }
}

ipcMain.handle("volli-bench:session-rpc", (_event, request) => {
  const mainIn = epochNow();
  const payload = request.payload;
  const mainOut = epochNow();
  return { payload, mainIn, mainOut };
});

ipcMain.handle("volli-bench:session-sqlite", (_event, path) => {
  if (typeof path !== "string" || path.length === 0) {
    throw new Error("A disposable SQLite database path is required");
  }
  const startedAt = performance.now();
  const result = blockingSqliteScan(path);
  return { ...result, elapsedMs: performance.now() - startedAt };
});

ipcMain.handle("volli-bench:session-push", (event, options) => {
  const delay = monitorEventLoopDelay({ resolution: 1 });
  const payload = "x".repeat(options.payloadBytes);
  const cpuBefore = process.cpuUsage();
  const startedAt = performance.now();
  delay.enable();
  let sequence = 0;

  const sendChunk = () => {
    const end = Math.min(options.frames, sequence + 250);
    while (sequence < end) {
      event.sender.send("volli-bench:session-push-frame", {
        kind: "data",
        subscriptionId: `subscription-${sequence % options.sessions}`,
        eventId: String(sequence),
        data: payload,
      });
      sequence += 1;
    }
    if (sequence < options.frames) {
      setImmediate(sendChunk);
      return;
    }
    delay.disable();
    const cpu = process.cpuUsage(cpuBefore);
    event.sender.send("volli-bench:session-push-frame", {
      kind: "done",
      main: {
        elapsedMs: performance.now() - startedAt,
        cpuMs: (cpu.user + cpu.system) / 1_000,
        eventLoopMeanMs: Number(delay.mean) / 1e6,
        eventLoopMaxMs: Number(delay.max) / 1e6,
      },
    });
  };

  // Queue after the invoke acknowledgement. The production Session link also
  // measures the separate pre-ack race through its optional observer.
  setImmediate(sendChunk);
  return { ok: true };
});

async function runRenderer(options) {
  // This function is serialized into the renderer, so its helpers must remain
  // inside it rather than capture declarations from the main-process scope.
  // oxlint-disable-next-line unicorn/consistent-function-scoping
  const percentile = (values, fraction) => {
    const ordered = values.toSorted((left, right) => left - right);
    return ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * fraction))];
  };
  const summary = (values) => ({
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    mean: values.reduce((sum, value) => sum + value, 0) / values.length,
  });
  // oxlint-disable-next-line unicorn/consistent-function-scoping
  const rendererEpochNow = () => performance.timeOrigin + performance.now();
  const payloadSizes = [0, 1_024, 16_384, 262_144, 1_048_576];
  const payloadCurve = [];

  for (const payloadBytes of payloadSizes) {
    const samples = [];
    const payload = "x".repeat(payloadBytes);
    const count =
      payloadBytes >= 1_048_576 ? Math.min(40, options.repetitions) : options.repetitions;
    for (let index = 0; index < 30; index += 1) await window.sessionRpcBench.roundTrip(payload);
    for (let index = 0; index < count; index += 1) {
      const rendererStart = rendererEpochNow();
      const response = await window.sessionRpcBench.roundTrip(payload);
      const rendererEnd = rendererEpochNow();
      if (response.payload.length !== payloadBytes) throw new Error("payload length changed");
      const total = rendererEnd - rendererStart;
      const handler = response.mainOut - response.mainIn;
      const ipcRoundTrip = response.preloadOut - response.preloadSend;
      // The echo has the same bytes in each direction. Cross-process clocks do
      // not have sufficient sub-millisecond alignment to split the two legs
      // directly, so report each as half of the non-handler invoke interval.
      const cloneAndIpcLeg = Math.max(0, ipcRoundTrip - handler) / 2;
      const contextBridgeLeg = Math.max(0, total - ipcRoundTrip) / 2;
      samples.push({
        total,
        rendererToPreload: contextBridgeLeg,
        cloneIn: cloneAndIpcLeg,
        handler,
        cloneOut: cloneAndIpcLeg,
        preloadToRenderer: contextBridgeLeg,
      });
    }
    payloadCurve.push({
      payloadBytes,
      repetitions: count,
      totalMs: summary(samples.map((sample) => sample.total)),
      rendererToPreloadMs: summary(samples.map((sample) => sample.rendererToPreload)),
      cloneInMs: summary(samples.map((sample) => sample.cloneIn)),
      handlerMs: summary(samples.map((sample) => sample.handler)),
      cloneOutMs: summary(samples.map((sample) => sample.cloneOut)),
      preloadToRendererMs: summary(samples.map((sample) => sample.preloadToRenderer)),
    });
  }

  const sqliteScan = options.databasePath
    ? await new Promise((resolve, reject) => {
        const animationFrameGaps = [];
        let animationFrame = 0;
        let previousAnimationFrame = 0;
        const tick = (timestamp) => {
          if (previousAnimationFrame > 0) {
            animationFrameGaps.push(timestamp - previousAnimationFrame);
          }
          previousAnimationFrame = timestamp;
          animationFrame = requestAnimationFrame(tick);
        };
        animationFrame = requestAnimationFrame(tick);
        setTimeout(() => {
          const rendererStartedAt = performance.now();
          const scan = window.sessionRpcBench.startSqliteScan(options.databasePath);
          // A single ordinary round trip, issued while main is inside the
          // synchronous scan. Animation frames answer whether the RENDERER
          // keeps painting; this answers what an interaction that needs main
          // actually waits, which is the cost the architecture question is
          // really about. It is issued after the scan invoke so it queues
          // behind a main process that is already blocked.
          const blockedStartedAt = performance.now();
          const blockedRoundTrip = window.sessionRpcBench
            .roundTrip("")
            .then(() => performance.now() - blockedStartedAt);
          void Promise.all([scan, blockedRoundTrip]).then(
            ([result, blockedRoundTripMs]) => {
              const rendererElapsedMs = performance.now() - rendererStartedAt;
              cancelAnimationFrame(animationFrame);
              const droppedAnimationFrames = animationFrameGaps.reduce(
                (dropped, gap) => dropped + Math.max(0, Math.round(gap / (1_000 / 60)) - 1),
                0,
              );
              resolve({
                ...result,
                rendererElapsedMs,
                blockedRoundTripMs,
                animationFrames: animationFrameGaps.length,
                droppedAnimationFrames,
                maxAnimationFrameGapMs: Math.max(0, ...animationFrameGaps),
                animationFrameGapsMs: animationFrameGaps,
              });
            },
            (error) => {
              cancelAnimationFrame(animationFrame);
              reject(error);
            },
          );
        }, 100);
      })
    : null;

  const push = await new Promise((resolve, reject) => {
    const handlerTimes = [];
    const animationFrameGaps = [];
    let animationFrame = 0;
    let previousAnimationFrame = 0;
    let received = 0;
    let firstAt = 0;
    let lastAt = 0;
    let checksum = 0;
    const tick = (timestamp) => {
      if (previousAnimationFrame > 0) animationFrameGaps.push(timestamp - previousAnimationFrame);
      previousAnimationFrame = timestamp;
      animationFrame = requestAnimationFrame(tick);
    };
    animationFrame = requestAnimationFrame(tick);
    const detach = window.sessionRpcBench.onPush((frame) => {
      const handlerStartedAt = performance.now();
      if (frame.kind === "done") {
        lastAt = performance.now();
        detach();
        cancelAnimationFrame(animationFrame);
        const droppedAnimationFrames = animationFrameGaps.reduce(
          (dropped, gap) => dropped + Math.max(0, Math.round(gap / (1_000 / 60)) - 1),
          0,
        );
        resolve({
          frames: received,
          rendererElapsedMs: lastAt - firstAt,
          framesPerSecond: received / ((lastAt - firstAt) / 1_000),
          rendererHandlerMs: summary(handlerTimes),
          animationFrames: animationFrameGaps.length,
          droppedAnimationFrames,
          maxAnimationFrameGapMs: Math.max(0, ...animationFrameGaps),
          checksum,
          main: frame.main,
        });
        return;
      }
      if (received === 0) firstAt = performance.now();
      received += 1;
      checksum += frame.data.length;
      handlerTimes.push(performance.now() - handlerStartedAt);
    });
    // Establish the renderer's normal frame cadence before the burst.
    setTimeout(() => {
      void window.sessionRpcBench
        .startPush({
          frames: options.frames,
          payloadBytes: 256,
          sessions: 4,
        })
        .catch((error) => {
          detach();
          reject(error);
        });
    }, 100);
  });

  return { payloadCurve, sqliteScan, push };
}

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  await window.loadURL("data:text/html,<meta charset=utf-8><title>Session RPC bench</title>");
  const report = await window.webContents.executeJavaScript(
    `(${runRenderer.toString()})(${JSON.stringify({
      repetitions,
      frames: frameCount,
      databasePath,
    })})`,
    true,
  );
  process.stdout.write(`__SESSION_RPC_BENCH__${JSON.stringify(report)}__SESSION_RPC_BENCH__\n`);
  await window.close();
  app.quit();
});

app.on("window-all-closed", () => app.quit());
