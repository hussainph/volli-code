import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { piExecutionEnv } from "./execution-env";

function workspace(): string {
  return mkdtempSync(join(tmpdir(), "volli-pi-env-"));
}

describe("piExecutionEnv", () => {
  it("runs a command without the host's own environment", async () => {
    process.env.VOLLI_TEST_FAKE_CREDENTIAL = "host-secret";
    const env = await piExecutionEnv(workspace());
    try {
      // Each `printenv` prints nothing for a variable the child was not given,
      // so anything before `done` is a leak of the host's environment.
      await expect(
        env.exec("printenv HOME; printenv VOLLI_TEST_FAKE_CREDENTIAL; echo done"),
      ).resolves.toEqual({
        ok: true,
        value: { stdout: "done\n", stderr: "", exitCode: 0 },
      });
    } finally {
      delete process.env.VOLLI_TEST_FAKE_CREDENTIAL;
      await env.cleanup();
    }
  });

  it("still gives a command the variables its caller asked for", async () => {
    const env = await piExecutionEnv(workspace());
    try {
      await expect(
        env.exec("printenv VOLLI_TEST_FLAG", { env: { VOLLI_TEST_FLAG: "yes" } }),
      ).resolves.toEqual({
        ok: true,
        value: { stdout: "yes\n", stderr: "", exitCode: 0 },
      });
    } finally {
      await env.cleanup();
    }
  });
});
