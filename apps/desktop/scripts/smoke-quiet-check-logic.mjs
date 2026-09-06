/** Classify the native sampler's evidence independently of process orchestration. */
export function quietSmokeVerdict(
  report,
  { assertStationaryCursor = false, requireHostInput = false } = {},
) {
  const failures = [];
  if (report.samples === 0) failures.push("native sampler produced no polling samples");
  if (report.smokeAppSamples === 0) {
    failures.push("native sampler did not observe a smoke app");
  }
  if (report.frontmostSamples > 0) {
    failures.push(
      `smoke app was frontmost in ${report.frontmostSamples}/${report.samples} samples ` +
        `(first: ${report.firstFrontmost ?? "unknown"})`,
    );
  }
  if (report.activeSamples > 0) {
    failures.push(
      `smoke app was active in ${report.activeSamples}/${report.samples} samples ` +
        `(first: ${report.firstActive ?? "unknown"})`,
    );
  }
  if (report.regularPolicySamples > 0) {
    failures.push(
      `smoke app had regular/Dock activation policy in ` +
        `${report.regularPolicySamples}/${report.samples} samples ` +
        `(first: ${report.firstRegular ?? "unknown"})`,
    );
  }
  if (assertStationaryCursor && report.cursor.maxDistanceFromStart > 0.5) {
    failures.push(
      `host cursor moved ${report.cursor.maxDistanceFromStart.toFixed(1)}px from its starting position`,
    );
  }
  if (requireHostInput && report.hostKeyInputSamples === 0) {
    failures.push("no host keyboard input was observed while a smoke app was running");
  }
  if (requireHostInput && report.hostClickInputSamples === 0) {
    failures.push("no host click input was observed while a smoke app was running");
  }
  return { ok: failures.length === 0, failures };
}
