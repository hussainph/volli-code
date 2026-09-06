/** Classify the native sampler's evidence independently of process orchestration. */
export function quietSmokeVerdict(report, { assertStationaryCursor = false } = {}) {
  const failures = [];
  if (report.samples === 0) failures.push("native sampler produced no observations");
  if (report.frontmostSamples > 0) {
    failures.push(
      `smoke app was frontmost in ${report.frontmostSamples}/${report.samples} samples ` +
        `(first: ${report.firstFrontmost ?? "unknown"})`,
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
  return { ok: failures.length === 0, failures };
}
