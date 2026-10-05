/**
 * Runs `credential-child.ts` as a separate `node` process (VC-642): the
 * multi-process tests' other desktop, hostd or CLI. Test support only.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";

const HOOKS = new URL("./ts-hooks.mjs", import.meta.url).href;
const CHILD = new URL("./credential-child.ts", import.meta.url).pathname;

export interface Child {
  readonly process: ChildProcess;
  /** The next JSON line the child prints. */
  next(): Promise<Record<string, unknown>>;
  /** Resolves with the exit code and signal. */
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

/** Starts the child with one command. */
export function startChild(command: Record<string, unknown>): Child {
  const child = spawn(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", "--import", HOOKS, CHILD, JSON.stringify(command)],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let stderr = "";
  child.stderr!.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const lines: string[] = [];
  const waiting: Array<(line: string) => void> = [];
  createInterface({ input: child.stdout! }).on("line", (line) => {
    const wake = waiting.shift();
    if (wake === undefined) lines.push(line);
    else wake(line);
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((settle) =>
    child.on("exit", (code, signal) => settle({ code, signal })),
  );
  return {
    process: child,
    exited,
    next: () =>
      new Promise((settle, refuse) => {
        const line = lines.shift();
        if (line !== undefined) return settle(JSON.parse(line) as Record<string, unknown>);
        waiting.push((text) => settle(JSON.parse(text) as Record<string, unknown>));
        void exited.then(({ code, signal }) =>
          refuse(new Error(`child exited (${code ?? signal}) before answering: ${stderr}`)),
        );
      }),
  };
}

/** Runs the child to completion and answers its first line. */
export async function runChild(command: Record<string, unknown>): Promise<Record<string, unknown>> {
  const child = startChild(command);
  const answer = await child.next();
  const { code } = await child.exited;
  if (code !== 0) throw new Error(`child exited ${code}`);
  return answer;
}
