/**
 * A scripted stand-in for Chromium's side of the CDP pipe (VC-619), for the
 * backend's lifetime tests: it answers commands the way the browser does,
 * can hold any method's answer back, and exits when killed. No real process
 * is signalled — a fake spawn routes the launch's signals to `kill` here.
 */
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess, SpawnOptions } from "node:child_process";

export interface FakeCommand {
  id: number;
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
}

export interface FakeChromium {
  /** Every command the backend sent, in order, across every launch. */
  commands: FakeCommand[];
  /** Answers held back, by method, until {@link release}. */
  held: Map<string, FakeCommand[]>;
  /** Hold every later command of this method (or stop holding it). */
  hold(method: string, on?: boolean): void;
  /** Answers every held command of a method, with `result`. */
  release(method: string, result?: object): void;
  /** Never answer this method at all. */
  ignore(method: string): void;
  /** Answer this method with a protocol error from now on. */
  fail(method: string): void;
  reply(id: number, result?: object): void;
  event(method: string, params: object, sessionId?: string): void;
  /** How many browsers were spawned. */
  spawns: number;
  /** The options the last spawn got. */
  lastOptions: SpawnOptions | undefined;
  /** The current child, to crash or inspect. */
  child(): ChildProcess & EventEmitter;
  /** The launch's spawn seam. */
  spawn(command: string, args: readonly string[], options: SpawnOptions): ChildProcess;
  /** Page targets the fake browser started with; `Target.getTargets` reports them. */
  startupPages: string[];
}

export function fakeChromium(): FakeChromium {
  let child: (ChildProcess & EventEmitter) | null = null;
  let read: PassThrough | null = null;
  let targetCount = 0;
  const holding = new Set<string>();
  const ignoring = new Set<string>();
  const failing = new Set<string>();
  const fake: FakeChromium = {
    commands: [],
    held: new Map(),
    spawns: 0,
    lastOptions: undefined,
    startupPages: ["startup-page"],
    hold(method, on = true) {
      if (on) holding.add(method);
      else holding.delete(method);
    },
    release(method, result = {}) {
      const waiting = fake.held.get(method) ?? [];
      fake.held.delete(method);
      for (const command of waiting) fake.reply(command.id, result);
    },
    ignore(method) {
      ignoring.add(method);
    },
    fail(method) {
      failing.add(method);
    },
    reply(id, result = {}) {
      read?.write(`${JSON.stringify({ id, result })}\0`);
    },
    event(method, params, sessionId) {
      read?.write(
        `${JSON.stringify({ method, params, ...(sessionId === undefined ? {} : { sessionId }) })}\0`,
      );
    },
    child() {
      if (child === null) throw new Error("No fake browser was spawned");
      return child;
    },
    spawn(_command, _args, options) {
      fake.spawns += 1;
      fake.lastOptions = options;
      const made = new EventEmitter() as ChildProcess & EventEmitter;
      const write = new PassThrough();
      const output = new PassThrough();
      let exited = false;
      const exit = (code: number | null, signal: NodeJS.Signals | null): void => {
        if (exited) return;
        exited = true;
        queueMicrotask(() => made.emit("exit", code, signal));
      };
      Object.assign(made, {
        pid: 40_000 + fake.spawns,
        stderr: new PassThrough(),
        stdio: [null, null, null, write, output],
        kill: (signal: NodeJS.Signals = "SIGTERM") => {
          exit(null, signal);
          return true;
        },
      });
      child = made;
      read = output;
      let buffered = "";
      write.on("data", (chunk: Buffer) => {
        buffered += chunk.toString("utf8");
        let end = buffered.indexOf("\0");
        while (end !== -1) {
          const command = JSON.parse(buffered.slice(0, end)) as FakeCommand;
          buffered = buffered.slice(end + 1);
          end = buffered.indexOf("\0");
          fake.commands.push(command);
          queueMicrotask(() => answer(command, () => exit(0, null)));
        }
      });
      return made;
    },
  };

  const answer = (command: FakeCommand, exit: () => void): void => {
    if (ignoring.has(command.method)) return;
    if (failing.has(command.method)) {
      read?.write(
        `${JSON.stringify({ id: command.id, error: { code: -32000, message: "injected failure" } })}\0`,
      );
      return;
    }
    if (holding.has(command.method)) {
      const list = fake.held.get(command.method) ?? [];
      list.push(command);
      fake.held.set(command.method, list);
      return;
    }
    switch (command.method) {
      case "Target.getTargets":
        fake.reply(command.id, {
          targetInfos: fake.startupPages.map((targetId) => ({ targetId, type: "page" })),
        });
        return;
      case "Target.createTarget": {
        targetCount += 1;
        const targetId = `target-${targetCount}`;
        fake.reply(command.id, { targetId });
        queueMicrotask(() =>
          fake.event("Target.attachedToTarget", {
            sessionId: `session-${targetCount}`,
            targetInfo: { targetId, type: "page" },
            waitingForDebugger: true,
          }),
        );
        return;
      }
      case "Target.createBrowserContext":
        fake.reply(command.id, { browserContextId: `context-${fake.commands.length}` });
        return;
      case "Browser.getWindowForTarget":
        fake.reply(command.id, { windowId: 1 });
        return;
      case "Page.navigate":
        fake.reply(command.id, { frameId: "main", loaderId: "loader" });
        return;
      case "Page.getNavigationHistory":
        fake.reply(command.id, { currentIndex: 0, entries: [{ id: 1, title: "fixture" }] });
        return;
      case "Target.attachToTarget":
        fake.reply(command.id, { sessionId: `agent-${command.id}` });
        return;
      case "Browser.close":
        fake.reply(command.id);
        exit();
        return;
      default:
        fake.reply(command.id);
    }
  };
  return fake;
}

/** Lets queued microtasks and stream callbacks run. */
export async function settle(rounds = 5): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}
