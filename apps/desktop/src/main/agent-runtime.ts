import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { shellSingleQuote } from "@volli/shared";

export interface VolliCliShimInput {
  binDir: string;
  electronPath: string;
  bundlePath: string;
  socketPath: string;
  /** The dev main-process entry `volli app launch` should boot; null when packaged (the bare executable boots the app on its own). */
  appEntry: string | null;
}

/** Regenerates the userData-local `volli` launcher so it always matches this app build. */
export async function ensureVolliCliShim(input: VolliCliShimInput): Promise<string> {
  await mkdir(input.binDir, { recursive: true });
  const shimPath = join(input.binDir, "volli");
  const temporaryPath = `${shimPath}.tmp-${process.pid}`;
  const content =
    "#!/bin/sh\n" +
    "export ELECTRON_RUN_AS_NODE=1\n" +
    // Environment beats the baked default (the context ladder in decision 3):
    // `${VAR:-default}` only substitutes when VAR is unset/empty. This is an
    // assignment RHS (no surrounding double quotes around the whole
    // expansion), which POSIX shells exempt from field splitting and
    // pathname expansion — so the single-quoted default survives intact
    // even with spaces or glob characters, without a stray-quote bug a
    // `"${VAR:-'default'}"`-style wrapper would introduce (single quotes
    // lose their quoting meaning once nested inside double quotes).
    `export VOLLI_SOCKET=\${VOLLI_SOCKET:-${shellSingleQuote(input.socketPath)}}\n` +
    `export VOLLI_APP_EXECUTABLE=\${VOLLI_APP_EXECUTABLE:-${shellSingleQuote(input.electronPath)}}\n` +
    (input.appEntry !== null
      ? `export VOLLI_APP_ENTRY=\${VOLLI_APP_ENTRY:-${shellSingleQuote(input.appEntry)}}\n`
      : "") +
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
