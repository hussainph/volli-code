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

export interface ChildOptions {
  /** Another child script (absolute path); default `credential-child.ts`. */
  readonly script?: string;
  /**
   * Node's `--experimental-transform-types`, for a child whose imports reach
   * TypeScript that type stripping alone cannot run (agent-runtime's
   * parameter properties). VC-643's web-key children need it.
   */
  readonly transformTypes?: boolean;
  /** `--import`ed instead of the default resolve hooks (absolute URL). */
  readonly hooks?: string;
}

/** Starts the child with one command. */
export function startChild(command: Record<string, unknown>, options: ChildOptions = {}): Child {
  const child = spawn(
    process.execPath,
    [
      "--disable-warning=ExperimentalWarning",
      ...(options.transformTypes === true ? ["--experimental-transform-types"] : []),
      "--import",
      options.hooks ?? HOOKS,
      options.script ?? CHILD,
      JSON.stringify(command),
    ],
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
export async function runChild(
  command: Record<string, unknown>,
  options: ChildOptions = {},
): Promise<Record<string, unknown>> {
  const child = startChild(command, options);
  const answer = await child.next();
  const { code } = await child.exited;
  if (code !== 0) throw new Error(`child exited ${code}`);
  return answer;
}
