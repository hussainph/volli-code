import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { ensureVolliCliShim } from "./agent-runtime";

let cleanup: (() => Promise<void>) | undefined;

afterEach(async () => cleanup?.());

describe("ensureVolliCliShim", () => {
  it("generates an executable Electron-as-Node shim with safely quoted, env-overridable defaults", async () => {
    const root = await mkdtemp(join(tmpdir(), "volli-shim-test-"));
    cleanup = async () => {
      const { rm } = await import("node:fs/promises");
      await rm(root, { recursive: true, force: true });
    };
    const shimPath = await ensureVolliCliShim({
      binDir: join(root, "bin"),
      electronPath: "/Applications/Volli Code.app/Contents/MacOS/Volli Code",
      bundlePath: "/tmp/owner's build/volli.cjs",
      socketPath: "/Users/dev/Library/Application Support/Volli Code/volli.sock",
      appEntry: null,
    });

    expect(shimPath).toBe(join(root, "bin", "volli"));
    expect(await readFile(shimPath, "utf8")).toBe(
      "#!/bin/sh\n" +
        "export ELECTRON_RUN_AS_NODE=1\n" +
        "export VOLLI_SOCKET=${VOLLI_SOCKET:-'/Users/dev/Library/Application Support/Volli Code/volli.sock'}\n" +
        "export VOLLI_APP_EXECUTABLE=${VOLLI_APP_EXECUTABLE:-'/Applications/Volli Code.app/Contents/MacOS/Volli Code'}\n" +
        "exec '/Applications/Volli Code.app/Contents/MacOS/Volli Code' '/tmp/owner'\\''s build/volli.cjs' \"$@\"\n",
    );
    expect((await stat(shimPath)).mode & 0o777).toBe(0o755);
  });

  it("also default-exports VOLLI_APP_ENTRY when a dev entry path is provided", async () => {
    const root = await mkdtemp(join(tmpdir(), "volli-shim-test-"));
    cleanup = async () => {
      const { rm } = await import("node:fs/promises");
      await rm(root, { recursive: true, force: true });
    };
    const shimPath = await ensureVolliCliShim({
      binDir: join(root, "bin"),
      electronPath: "/work/volli-code/node_modules/.bin/electron",
      bundlePath: "/work/volli-code/packages/cli/dist/volli.cjs",
      socketPath: "/tmp/volli.sock",
      appEntry: "/work/volli-code/apps/desktop/dist-electron/main.cjs",
    });

    expect(await readFile(shimPath, "utf8")).toBe(
      "#!/bin/sh\n" +
        "export ELECTRON_RUN_AS_NODE=1\n" +
        "export VOLLI_SOCKET=${VOLLI_SOCKET:-'/tmp/volli.sock'}\n" +
        "export VOLLI_APP_EXECUTABLE=${VOLLI_APP_EXECUTABLE:-'/work/volli-code/node_modules/.bin/electron'}\n" +
        "export VOLLI_APP_ENTRY=${VOLLI_APP_ENTRY:-'/work/volli-code/apps/desktop/dist-electron/main.cjs'}\n" +
        "exec '/work/volli-code/node_modules/.bin/electron' '/work/volli-code/packages/cli/dist/volli.cjs' \"$@\"\n",
    );
  });
});
