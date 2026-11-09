const completeProbe = (probe, count) =>
  probe?.ok === true &&
  probe?.handlerMs?.length === count &&
  probe?.latencyMs?.length === count &&
  [...probe.handlerMs, ...probe.latencyMs].every((value) => Number.isFinite(value) && value >= 0);
/** Lifecycle contract, testable without importing Playwright or launching an app. */
export async function runGuardedSide({ drive, settings, source, signals = process }) {
  let id, ready, result, stop, stopPromise;
  let interrupted = false;
  const stopOwned = () => (stopPromise ??= drive(["stop", id, "--json"]));
  const interrupt = () => {
    interrupted = true;
    if (id) void stopOwned().catch(() => {}); // awaited in finally
  };
  signals.on("SIGINT", interrupt);
  signals.on("SIGTERM", interrupt);
  try {
    ready = await drive([
      "launch",
      "--model",
      "fake",
      "--fixture",
      "empty",
      "--no-build",
      "--json",
    ]);
    id = ready.id;
    if (!/^vd-[a-z0-9]+$/.test(id)) throw new Error("driver launch returned no instance id");
    if (interrupted) throw new Error("benchmark interrupted during launch");
    const guard = await drive(["doctor", id, "--json"]);
    if (!guard.ok) throw new Error("driver doctor refused the benchmark");
    result = await drive(["chat-window-bench", id, "--settings", JSON.stringify(settings)]);
    const guardAfter = await drive(["doctor", id, "--json"]);
    if (!guardAfter.ok) throw new Error("driver doctor failed after the benchmark");
    result = { ...result, source, settings, driver: { id, ready, guard, guardAfter } };
  } catch (error) {
    // Failed readiness still names its reserved instance in the driver's own
    // error/evidence path. Do not abandon a partial launch or invent a pid.
    id ??= /\bvd-[a-z0-9]{6}\b/.exec(error.stderr ?? error.message)?.[0];
    throw error;
  } finally {
    try {
      if (id) stop = await stopOwned();
    } finally {
      signals.removeListener("SIGINT", interrupt);
      signals.removeListener("SIGTERM", interrupt);
    }
  }
  if (interrupted) throw new Error("benchmark interrupted; instance stopped");
  result.driver.stop = stop;
  const cleanup = stop.cleanup;
  if (
    cleanup?.keychainViolationExit ||
    cleanup?.keychainViolations?.length ||
    stop.leftovers?.length ||
    !cleanup?.scratchRemoved ||
    cleanup?.electron?.close?.kind !== "graceful"
  )
    throw new Error(`driver cleanup was not clean/graceful; keep evidence for ${id}`);
  if (result.failure || result.errors?.length || result.errorDetails?.length)
    throw new Error(
      `bench failed: ${result.failure ?? JSON.stringify(result.errors ?? result.errorDetails)}`,
    );
  if (
    settings.arm === "draft" &&
    (result.draftTyping?.typedCharacters !== settings.draftKeys ||
      !completeProbe(result.draftTyping, settings.draftKeys))
  )
    throw new Error("draft arm did not receive all trusted keys/paint samples");
  if (settings.arm === "reveal" && !completeProbe(result.revealSwitch, settings.revealSwitches))
    throw new Error("reveal arm did not receive all trusted clicks/paint samples");
  if (
    ["stream", "transcript"].includes(settings.arm) &&
    settings.streamContent !== "diagram" &&
    (result.streamingSamples?.length !== settings.streamSamples ||
      result.streamingSamples.some(
        (sample) =>
          !sample.ok ||
          !sample.streamedWhileWorking ||
          !sample.streamedWhileTurnActive ||
          !(sample.liveCodeBlocks > 0),
      ))
  )
    throw new Error("stream arm did not measure live streaming code");
  if (
    settings.diagramSampleMs !== null &&
    settings.diagramSampleMs !== undefined &&
    result.benchCadence?.diagramSampleMs !== settings.diagramSampleMs
  )
    throw new Error("bench cadence artifact missing or mismatched in report");
  if (settings.streamContent === "diagram") validateDiagramProbe(result, settings.streamSamples);
  return result;
}

export async function serialComparison(sides, runSide) {
  const reports = [];
  for (const side of sides) reports.push(await runSide(side));
  if (reports.length === 2) {
    for (const key of ["electron", "chrome", "node"]) {
      if (reports[0].runtime?.[key] !== reports[1].runtime?.[key])
        throw new Error(`unmatched runtime ${key}`);
    }
  }
  return reports;
}

/** Refuse plausible-looking numbers from an empty, hidden or static probe. */
export function validateDiagramProbe(report, expectedSamples) {
  if (
    report.failure !== undefined ||
    !Array.isArray(report.streamingSamples) ||
    report.streamingSamples.length !== expectedSamples ||
    !Array.isArray(report.errors) ||
    report.errors.length > 0 ||
    !Array.isArray(report.errorDetails) ||
    report.errorDetails.length > 0
  ) {
    throw new Error("diagram probe has missing samples or renderer errors");
  }
  for (const sample of report.streamingSamples) {
    if (
      sample?.ok !== true ||
      sample.streamContent !== "diagram" ||
      sample.codeFenceOpened !== true ||
      sample.codeFenceClosed !== true ||
      sample.streamedWhileWorking !== true ||
      sample.streamedWhileTurnActive !== true ||
      !(sample.liveDiagramSvgs > 0) ||
      !(sample.visibleDiagramFrames > 1) ||
      !(sample.distinctVisibleDiagramSources > 1) ||
      sample.maxDiagramLabels !== 18 ||
      sample.settledDiagramSvgs !== 1 ||
      sample.settledDiagramLabels !== 18 ||
      !(sample.scrollDistancePx > 0) ||
      !(sample.refreshIntervalMs > 0) ||
      ![
        sample.liveDiagramSvgs,
        sample.visibleDiagramFrames,
        sample.distinctVisibleDiagramSources,
        sample.scrollDistancePx,
        sample.refreshIntervalMs,
      ].every(Number.isFinite)
    ) {
      throw new Error("diagram probe missed its visible/changing/complete SVG contract");
    }
  }
}
