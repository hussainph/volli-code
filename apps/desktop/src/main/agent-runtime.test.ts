import { mkdir, mkdtemp, readFile, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { ensureVolliCliShim, volliRuntimePaths } from "./agent-runtime";

let cleanup: (() => Promise<void>) | undefined;

afterEach(async () => cleanup?.());

describe("volliRuntimePaths", () => {
  it("keeps dev launcher paths stable across an Electron relaunch from the built main entry", () => {
    const mainProcessDir = "/work/volli-code/apps/desktop/dist-electron";
    const input = {
      userDataPath: "/Users/dev/Library/Application Support/Volli Code-dev",
      resourcesPath: "/electron/resources",
      isPackaged: false,
      mainProcessDir,
    };

    const initial = volliRuntimePaths({
      ...input,
      appPath: "/work/volli-code/apps/desktop",
    } as Parameters<typeof volliRuntimePaths>[0]);
    const relaunched = volliRuntimePaths({
      ...input,
      appPath: mainProcessDir,
    } as Parameters<typeof volliRuntimePaths>[0]);

    expect(relaunched).toEqual(initial);
    expect(relaunched).toMatchObject({
      cliBundlePath: "/work/volli-code/packages/cli/dist/volli.cjs",
      appEntry: "/work/volli-code/apps/desktop",
    });
  });
});

describe("ensureVolliCliShim", () => {
  it("generates an executable Electron-as-Node shim with safely quoted, baked launch paths", async () => {
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
      userDataPath: "/Users/dev/Library/Application Support/Volli Code",
      rendererUrl: null,
      appEntry: null,
    });

    expect(shimPath).toBe(join(root, "bin", "volli"));
    expect(await readFile(shimPath, "utf8")).toBe(
      "#!/bin/sh\n" +
        "export ELECTRON_RUN_AS_NODE=1\n" +
        "export VOLLI_SOCKET=${VOLLI_SOCKET:-'/Users/dev/Library/Application Support/Volli Code/volli.sock'}\n" +
        "export VOLLI_APP_EXECUTABLE='/Applications/Volli Code.app/Contents/MacOS/Volli Code'\n" +
        "export VOLLI_APP_USER_DATA='/Users/dev/Library/Application Support/Volli Code'\n" +
        "exec '/Applications/Volli Code.app/Contents/MacOS/Volli Code' '/tmp/owner'\\''s build/volli.cjs' \"$@\"\n",
    );
    expect((await stat(shimPath)).mode & 0o777).toBe(0o755);
    expect((await stat(join(root, "bin"))).mode & 0o777).toBe(0o700);
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
      userDataPath: root,
      rendererUrl: "http://127.0.0.1:5173",
    } as Parameters<typeof ensureVolliCliShim>[0]);

    expect(await readFile(shimPath, "utf8")).toBe(
      "#!/bin/sh\n" +
        "export ELECTRON_RUN_AS_NODE=1\n" +
        "export VOLLI_SOCKET=${VOLLI_SOCKET:-'/tmp/volli.sock'}\n" +
        "export VOLLI_APP_EXECUTABLE='/work/volli-code/node_modules/.bin/electron'\n" +
        "export VOLLI_APP_ENTRY='/work/volli-code/apps/desktop/dist-electron/main.cjs'\n" +
        `export VOLLI_APP_USER_DATA='${root}'\n` +
        "export VOLLI_APP_RENDERER_URL='http://127.0.0.1:5173'\n" +
        "exec '/work/volli-code/node_modules/.bin/electron' '/work/volli-code/packages/cli/dist/volli.cjs' \"$@\"\n",
    );
  });

  it("refuses to place the launcher through a symlinked bin directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "volli-shim-test-"));
    cleanup = async () => {
      const { rm } = await import("node:fs/promises");
      await rm(root, { recursive: true, force: true });
    };
    const outside = join(root, "outside");
    const binDir = join(root, "bin");
    await mkdir(outside);
    await symlink(outside, binDir);

    await expect(
      ensureVolliCliShim({
        binDir,
        electronPath: "/Applications/Volli Code.app/Contents/MacOS/Volli Code",
        bundlePath: "/Applications/Volli Code.app/Contents/Resources/volli.cjs",
        socketPath: "/tmp/volli.sock",
        userDataPath: root,
        rendererUrl: null,
        appEntry: null,
      }),
    ).rejects.toThrow("Refusing to use non-directory CLI bin path");
    await expect(readFile(join(outside, "volli"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
