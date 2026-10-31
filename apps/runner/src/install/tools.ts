import { spawnSync } from "node:child_process";
import { closeSync, openSync, readSync, writeSync } from "node:fs";

export interface ToolOptions {
  env?: NodeJS.ProcessEnv;
  inherit?: boolean;
}
export interface ToolResult {
  status: number;
  stdout: string;
}
export type RunTool = (command: string, args: string[], options?: ToolOptions) => ToolResult;

/** Never include argv, stdout or stderr in an error: a proxy or link token may be in them. */
export const runTool: RunTool = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
    env: options.env,
  });
  return { status: result.status ?? 1, stdout: result.stdout ?? "" };
};

/** Confirmation reads the controlling terminal, never the piped installer script. */
export function confirmPurge(question: string): boolean {
  let fd: number;
  try {
    fd = openSync("/dev/tty", "r+");
  } catch {
    return false;
  }
  try {
    writeSync(fd, `${question} Type yes to continue: `);
    const bytes = Buffer.alloc(32);
    const count = readSync(fd, bytes, 0, bytes.length, null);
    return bytes.subarray(0, count).toString("utf8").trim() === "yes";
  } finally {
    closeSync(fd);
  }
}

export function mustRun(
  run: RunTool,
  command: string,
  args: string[],
  options?: ToolOptions,
): ToolResult {
  const result = run(command, args, options);
  if (result.status !== 0)
    throw new Error(`${command} failed. Fix the service or account configuration and retry.`);
  return result;
}
