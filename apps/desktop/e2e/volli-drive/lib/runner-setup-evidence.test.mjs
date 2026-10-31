import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  installCommandFromSnapshot,
  redactInstallTokens,
  scrubRunnerSetupEvidence,
} from "./runner-setup-evidence.mjs";

const token = `vrt_${"a".repeat(43)}`;
const command = `- text: curl -fsSL https://github.com/hussainph/volli-code/releases/download/v0.3.0-canary.1/volli-runner-install.sh | sh -s -- --token '${token}' --user`;

test("reads the renderer token and pinned version without minting a substitute", () => {
  assert.deepEqual(installCommandFromSnapshot(command), {
    installToken: token,
    version: "0.3.0-canary.1",
  });
  for (const snapshot of ["no command", `${command}\n${command}`, `- text: ${token}`]) {
    assert.throws(
      () => installCommandFromSnapshot(snapshot),
      (error) => !error.message.includes(token),
    );
  }
});

test("redacts install tokens in error text", () => {
  const redacted = redactInstallTokens(`${command}\n${token}`);
  assert.equal(redacted.includes(token), false);
  assert.equal(redacted.match(/install token redacted/gu).length, 2);
});

test("scrubs failed-link snapshot evidence while retaining the useful tree", async () => {
  await fs.mkdir(".scratch", { recursive: true });
  const evidence = await fs.mkdtemp(join(".scratch", "runner-evidence-"));
  try {
    await scrubRunnerSetupEvidence(evidence);
    const snapshots = join(evidence, "snapshots");
    await fs.mkdir(snapshots);
    await fs.writeFile(join(snapshots, "gen-0001-main.txt"), command);
    await fs.writeFile(join(snapshots, "gen-0002-main.txt"), "byo6-box is online");
    await scrubRunnerSetupEvidence(evidence);
    const scrubbed = await fs.readFile(join(snapshots, "gen-0001-main.txt"), "utf8");
    assert.equal(scrubbed.includes(token), false);
    assert.ok(scrubbed.includes("/v0.3.0-canary.1/"));
    assert.equal(
      await fs.readFile(join(snapshots, "gen-0002-main.txt"), "utf8"),
      "byo6-box is online",
    );
  } finally {
    await fs.rm(evidence, { recursive: true, force: true });
  }
});
