import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { ensureVolliCliShim } from "./agent-runtime";

let cleanup: (() => Promise<void>) | undefined;

afterEach(async () => cleanup?.());

describe("ensureVolliCliShim", () => {
  it("generates an executable Electron-as-Node shim with safely quoted absolute paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "volli-shim-test-"));
    cleanup = async () => {
      const { rm } = await import("node:fs/promises");
      await rm(root, { recursive: true, force: true });
    };
    const shimPath = await ensureVolliCliShim({
      binDir: join(root, "bin"),
      electronPath: "/Applications/Volli Code.app/Contents/MacOS/Volli Code",
      bundlePath: "/tmp/owner's build/volli.cjs",
    });

    expect(shimPath).toBe(join(root, "bin", "volli"));
    expect(await readFile(shimPath, "utf8")).toBe(
      "#!/bin/sh\n" +
        "export ELECTRON_RUN_AS_NODE=1\n" +
        "exec '/Applications/Volli Code.app/Contents/MacOS/Volli Code' '/tmp/owner'\\''s build/volli.cjs' \"$@\"\n",
    );
    expect((await stat(shimPath)).mode & 0o777).toBe(0o755);
  });
});
