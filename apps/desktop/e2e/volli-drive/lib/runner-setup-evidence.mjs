import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { join } from "node:path";

/** The renderer's command, not a test-minted replacement. Never echo a failed snapshot. */
export function installCommandFromSnapshot(snapshot) {
  const tokens = snapshot.match(/vrt_[A-Za-z0-9_-]{40,48}/gu) ?? [];
  assert.equal(tokens.length, 1, "Expected exactly one install token in the sheet");
  const version = snapshot.match(/releases\/download\/v([0-9][0-9A-Za-z.+-]*)\//u)?.[1];
  assert.ok(version, "Expected a version-pinned installer in the sheet");
  return { installToken: tokens[0], version };
}

export function redactInstallTokens(text) {
  return text.replace(/vrt_[A-Za-z0-9_-]+/gu, "[install token redacted]");
}

/** The driver records accessibility trees. Scrub those after stop, including on failed links. */
export async function scrubRunnerSetupEvidence(evidence) {
  const snapshots = join(evidence, "snapshots");
  let files;
  try {
    files = await fs.readdir(snapshots, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  for (const file of files) {
    if (!file.isFile() || !file.name.endsWith(".txt")) continue;
    const path = join(snapshots, file.name);
    const text = await fs.readFile(path, "utf8");
    const scrubbed = redactInstallTokens(text);
    if (scrubbed !== text) await fs.writeFile(path, scrubbed);
  }
}
