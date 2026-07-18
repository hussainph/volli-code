import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { shellSingleQuote } from "@volli/shared";

export interface VolliCliShimInput {
  binDir: string;
  electronPath: string;
  bundlePath: string;
  socketPath: string;
}

/** Regenerates the userData-local `volli` launcher so it always matches this app build. */
export async function ensureVolliCliShim(input: VolliCliShimInput): Promise<string> {
  await mkdir(input.binDir, { recursive: true });
  const shimPath = join(input.binDir, "volli");
  const temporaryPath = `${shimPath}.tmp-${process.pid}`;
  const content =
    "#!/bin/sh\n" +
    "export ELECTRON_RUN_AS_NODE=1\n" +
    `export VOLLI_SOCKET=${shellSingleQuote(input.socketPath)}\n` +
    `exec ${shellSingleQuote(input.electronPath)} ${shellSingleQuote(input.bundlePath)} "$@"\n`;
  await writeFile(temporaryPath, content, { encoding: "utf8", mode: 0o755 });
  await chmod(temporaryPath, 0o755);
  await rename(temporaryPath, shimPath);
  return shimPath;
}

export interface VolliRuntimePaths {
  binDir: string;
  socketPath: string;
  cliBundlePath: string;
}

/** Resolves the three runtime paths shared by the shim, socket, and PTY environment. */
export function volliRuntimePaths(input: {
  userDataPath: string;
  appPath: string;
  resourcesPath: string;
  isPackaged: boolean;
}): VolliRuntimePaths {
  return {
    binDir: join(input.userDataPath, "bin"),
    socketPath: join(input.userDataPath, "volli.sock"),
    cliBundlePath: input.isPackaged
      ? join(input.appPath, "dist-electron/volli-cli.cjs")
      : resolve(input.appPath, "../../packages/cli/dist/volli.cjs"),
  };
}
