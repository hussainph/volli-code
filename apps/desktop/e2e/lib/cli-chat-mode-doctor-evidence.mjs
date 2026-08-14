const PATH_POSITION_TITLE = "✓ Volli's bin is first on PATH";
const APP_CLI_TITLES = new Set([
  "✓ `volli` is this app's CLI",
  // The transcript reader observes rendered Markdown text, which removes the
  // inline-code delimiters when the model does not wrap the report in a fence.
  "✓ volli is this app's CLI",
]);

function hasCheck(lines, titles, detailMatches) {
  return lines.some((line, index) => titles.has(line) && detailMatches(lines[index + 1] ?? ""));
}

/** Exact successful doctor evidence required by the CLI chat-mode smoke. */
export function inspectDoctorPathEvidence(reply, expectedShimPath) {
  const lines = reply.split(/\r?\n/u).map((line) => line.trim());
  return {
    pathPositionOk: hasCheck(lines, new Set([PATH_POSITION_TITLE]), (detail) =>
      /^position 1 of [1-9]\d*$/u.test(detail),
    ),
    cliShimOk: hasCheck(lines, APP_CLI_TITLES, (detail) => detail === expectedShimPath),
  };
}
