/**
 * The applier's live ports: HTTPS with size caps, `tar`, the release's own
 * probes, and `systemctl`. Each is small and testable against a loopback
 * server, real `tar` and real processes.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { UpdateRefusal } from "./manifest";

const FETCH_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 15 * 60 * 1000;
const PROBE_TIMEOUT_MS = 120_000;

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

async function get(fetcher: Fetch, url: string, timeoutMs: number): Promise<Response> {
  const response = await fetcher(url, {
    headers: { "user-agent": "volli-runner-updater" },
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok || response.body === null) {
    throw new UpdateRefusal("download", `GET ${url} answered ${response.status}.`);
  }
  return response;
}

async function* chunks(
  response: Response,
  maxBytes: number,
  url: string,
): AsyncGenerator<Uint8Array> {
  let total = 0;
  for await (const chunk of response.body as ReadableStream<Uint8Array>) {
    total += chunk.byteLength;
    if (total > maxBytes) throw new UpdateRefusal("download", `${url} is larger than expected.`);
    yield chunk;
  }
}

export function liveFetchText(fetcher: Fetch = fetch) {
  return async (url: string, maxBytes: number): Promise<string> => {
    const response = await get(fetcher, url, FETCH_TIMEOUT_MS);
    const parts: Uint8Array[] = [];
    for await (const chunk of chunks(response, maxBytes, url)) parts.push(chunk);
    return Buffer.concat(parts).toString("utf8");
  };
}

export function liveDownload(fetcher: Fetch = fetch) {
  return async (
    url: string,
    path: string,
    maxBytes: number,
  ): Promise<{ sha256: string; size: number }> => {
    const response = await get(fetcher, url, DOWNLOAD_TIMEOUT_MS);
    const hash = createHash("sha256");
    let size = 0;
    async function* hashed(): AsyncGenerator<Uint8Array> {
      for await (const chunk of chunks(response, maxBytes, url)) {
        hash.update(chunk);
        size += chunk.byteLength;
        yield chunk;
      }
    }
    await pipeline(Readable.from(hashed()), createWriteStream(path, { mode: 0o600 }));
    return { sha256: hash.digest("hex"), size };
  };
}

/** Runs a program to completion; its stderr's tail names a failure. */
export function runProgram(
  program: string,
  args: readonly string[],
  options: { readonly timeoutMs: number; readonly cwd?: string } = { timeoutMs: PROBE_TIMEOUT_MS },
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      stdio: ["ignore", "ignore", "pipe"],
      timeout: options.timeoutMs,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (text: string) => {
      stderr = (stderr + text).slice(-2000);
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) resolve();
      else {
        const why = signal === null ? `exited ${code}` : `was killed (${signal})`;
        reject(new Error(`${program} ${why}${stderr.trim() === "" ? "" : `: ${stderr.trim()}`}`));
      }
    });
  });
}

/** `tar -xzf`, never restoring the archive's owners: a system release is root's. */
export async function liveExtract(tarball: string, into: string): Promise<void> {
  try {
    await runProgram("tar", ["-xzf", tarball, "-C", into, "--no-same-owner"], {
      timeoutMs: PROBE_TIMEOUT_MS,
    });
  } catch (error) {
    throw new UpdateRefusal("bad_tarball", (error as Error).message);
  }
}

/** The release's own probes, run by its own `bin/node`: it loads its natives and Code Mode here. */
export async function liveProbe(release: string): Promise<void> {
  const node = join(release, "bin", "node");
  for (const probe of ["probe-natives.cjs", "probe-codemode.mjs"]) {
    try {
      await runProgram(node, [join(release, "lib", probe)], {
        timeoutMs: PROBE_TIMEOUT_MS,
        cwd: release,
      });
    } catch (error) {
      throw new UpdateRefusal("probe", `${probe}: ${(error as Error).message}`);
    }
  }
}

/** `systemctl [--user] restart volli-runner.service`. */
export function liveRestart(
  mode: "system" | "user",
  unit: string,
  systemctl = "systemctl",
): Promise<void> {
  return runProgram(systemctl, [...(mode === "user" ? ["--user"] : []), "restart", unit], {
    timeoutMs: 90_000,
  });
}
