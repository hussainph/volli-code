import { openSync } from "node:fs";
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { ReadStream } from "node:tty";
import type { ModelAccessSignInPrompt } from "@volli/shared";

import type { LoginTerminal } from "./renderer";

/** Reads a pipe, or /dev/tty (never the shell's argument list or environment). */
export function loginTerminal(write: (text: string) => void): LoginTerminal {
  let reader: ReturnType<typeof bufferedTerminal> | undefined;
  return {
    write,
    read: (prompt, signal) => {
      if (reader === undefined) {
        const piped = !process.stdin.isTTY;
        const input = piped ? process.stdin : new ReadStream(openSync("/dev/tty", "r+"));
        reader = bufferedTerminal(input, !piped, write, () => {
          if (!piped) input.destroy();
          else input.pause();
        });
      }
      return reader.read(prompt, signal);
    },
    close: () => reader?.close(),
  };
}

/** Exported for stream-boundary tests: piped lines can arrive before a prompt. */
export function bufferedTerminal(
  input: NodeJS.ReadableStream,
  tty: boolean,
  write: (text: string) => void,
  release: () => void,
): LoginTerminal {
  // Readline handles raw-mode editing and restores the tty when closed. Its
  // output sink deliberately swallows *all* echo (including manual codes).
  const output = new Writable({ write: (_chunk, _encoding, done) => done() });
  const lines = createInterface({ input, output, terminal: tty, historySize: 0 });
  const queued: string[] = [];
  let ended = false;
  let pending: { resolve(value: string): void; reject(error: Error): void } | undefined;
  const fail = (): void => pending?.reject(new Error("Sign-in input ended."));
  lines.on("line", (line) => {
    if (pending === undefined) queued.push(line);
    else pending.resolve(line);
  });
  lines.on("close", () => {
    ended = true;
    fail();
  });
  lines.on("SIGINT", fail);
  lines.on("error", fail);
  input.on("error", fail);
  return {
    write,
    read: async (prompt: ModelAccessSignInPrompt, signal: AbortSignal): Promise<string> => {
      signal.throwIfAborted();
      write(`${prompt.message}\n`);
      for (const option of prompt.options) {
        write(
          `  ${option.id}: ${option.label}${option.description === null ? "" : ` — ${option.description}`}\n`,
        );
      }
      if (queued.length > 0) return queued.shift()!;
      if (ended) throw new Error("Sign-in input ended.");
      return new Promise<string>((resolve, reject) => {
        const clear = (): void => {
          pending = undefined;
          signal.removeEventListener("abort", abort);
        };
        const abort = (): void => {
          clear();
          reject(new Error("Sign-in input withdrawn."));
        };
        pending = {
          resolve: (value) => {
            clear();
            resolve(value);
          },
          reject: (error) => {
            clear();
            reject(error);
          },
        };
        signal.addEventListener("abort", abort, { once: true });
      });
    },
    close: () => {
      queued.length = 0;
      lines.close();
      input.removeListener("error", fail);
      output.destroy();
      release();
    },
  };
}
