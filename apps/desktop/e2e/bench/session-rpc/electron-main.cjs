const { app, BrowserWindow, ipcMain } = require("electron");
const { monitorEventLoopDelay } = require("node:perf_hooks");
const { join } = require("node:path");

const epochNow = () => performance.timeOrigin + performance.now();

function parseInteger(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  const value = index === -1 ? fallback : Number(process.argv[index + 1]);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`--${name} must be positive`);
  return value;
}

const repetitions = parseInteger("repetitions", 300);
const frameCount = parseInteger("frames", 20_000);

ipcMain.handle("volli-bench:session-rpc", (_event, request) => {
  const mainIn = epochNow();
  const payload = request.payload;
  const mainOut = epochNow();
  return { payload, mainIn, mainOut };
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
  const percentile = (values, fraction) => {
    const ordered = [...values].sort((left, right) => left - right);
    return ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * fraction))];
  };
  const summary = (values) => ({
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    mean: values.reduce((sum, value) => sum + value, 0) / values.length,
  });
  const epochNow = () => performance.timeOrigin + performance.now();
  const payloadSizes = [0, 1_024, 16_384, 262_144, 1_048_576];
  const payloadCurve = [];

  for (const payloadBytes of payloadSizes) {
    const samples = [];
    const payload = "x".repeat(payloadBytes);
    const count = payloadBytes >= 1_048_576 ? Math.min(40, options.repetitions) : options.repetitions;
    for (let index = 0; index < 30; index += 1) await window.sessionRpcBench.roundTrip(payload);
    for (let index = 0; index < count; index += 1) {
      const rendererStart = epochNow();
      const response = await window.sessionRpcBench.roundTrip(payload);
      const rendererEnd = epochNow();
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

  const push = await new Promise(async (resolve, reject) => {
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
    try {
      // Establish the renderer's normal frame cadence before the burst.
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
      await window.sessionRpcBench.startPush({
        frames: options.frames,
        payloadBytes: 256,
        sessions: 4,
      });
    } catch (error) {
      detach();
      reject(error);
    }
  });

  return { payloadCurve, push };
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
    `(${runRenderer.toString()})(${JSON.stringify({ repetitions, frames: frameCount })})`,
    true,
  );
  process.stdout.write(`__SESSION_RPC_BENCH__${JSON.stringify(report)}__SESSION_RPC_BENCH__\n`);
  await window.close();
  app.quit();
});

app.on("window-all-closed", () => app.quit());
