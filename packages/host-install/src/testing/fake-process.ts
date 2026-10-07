/** A child process stand-in for tests: scripted output, a recorded stdin, a kill switch. */
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

export interface FakeChild {
  readonly process: ChildProcess;
  readonly command: string;
  readonly args: readonly string[];
  /** Everything written to stdin, once it ended. */
  readonly stdin: Promise<string>;
  readonly killed: string[];
  out(text: string): void;
  err(text: string): void;
  exit(code: number | null): void;
  fail(error: NodeJS.ErrnoException): void;
}

export function fakeChild(command: string, args: readonly string[]): FakeChild {
  const emitter = new EventEmitter();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const killed: string[] = [];
  let written = "";
  stdin.on("data", (chunk: Buffer) => {
    written += chunk.toString();
  });
  const ended = new Promise<string>((resolve) => stdin.on("finish", () => resolve(written)));
  const process = Object.assign(emitter, {
    stdin,
    stdout,
    stderr,
    kill: (signal = "SIGTERM") => {
      killed.push(String(signal));
      return true;
    },
  }) as unknown as ChildProcess;
  return {
    process,
    command,
    args,
    stdin: ended,
    killed,
    out: (text) => stdout.write(text),
    err: (text) => stderr.write(text),
    exit: (code) => {
      stdout.end();
      stderr.end();
      // Exit, then close after the streams drain, as a real child's do.
      setImmediate(() => {
        emitter.emit("exit", code);
        emitter.emit("close", code);
      });
    },
    fail: (error) => {
      setImmediate(() => emitter.emit("error", error));
    },
  };
}

/** A spawn that hands each child to `script` to act out. */
export function scriptedSpawn(script: (child: FakeChild) => void) {
  const children: FakeChild[] = [];
  const spawn = (command: string, args: readonly string[]): ChildProcess => {
    const child = fakeChild(command, args);
    children.push(child);
    script(child);
    return child.process;
  };
  return { spawn, children };
}

/** A logger that keeps every line. */
export function recordingLogger() {
  const lines: { level: string; msg: string; fields: Record<string, unknown> }[] = [];
  const at =
    (level: string) =>
    (msg: string, fields: Record<string, unknown> = {}) => {
      lines.push({ level, msg, fields });
    };
  return {
    lines,
    logger: { debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") },
  };
}
