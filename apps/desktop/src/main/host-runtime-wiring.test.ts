/**
 * index.ts's ACTUAL host wiring, executed against recorded ports.
 *
 * `host-runtime.test.ts` proves the desktop adapter in isolation; nothing there
 * fails if index.ts stops handing it the right gates, lifecycle or socket.
 * Importing index.ts is impractical (Electron, top-level boot side effects), so
 * this file parses it with oxc (the parser vite-plus ships), lifts the exact
 * composition expressions out of the source — `prepareHostQuit`, the three
 * late-bound quit gates, the accepted-quit hold, and the
 * `createDesktopHostRuntime` call — strips their types, and evaluates them with
 * every free identifier bound to a recorded port. The real `prepareDesktopQuit`,
 * `createDesktopHostRuntime`, `registerAcceptedQuitCoordinator` and quit-gate
 * helpers run unmodified; only index.ts's surroundings are fakes.
 *
 * An identifier the lifted code starts to need that this file does not bind
 * surfaces as a ReferenceError naming it — extend the scope, do not loosen the
 * assertions.
 */
import { readFileSync } from "node:fs";
import { parseSync, transformSync } from "vite/rolldown/utils";
import { describe, expect, it, vi } from "vite-plus/test";
import type { HostRuntimeOwner } from "@volli/host-core";
import {
  createClientStateFlush,
  MENU_BAR_FLUSH_OVERDUE_MS,
  SHUTDOWN_FLUSH_TIMEOUT_MS,
  type FlushTarget,
} from "./client-state-flush";
import { createDesktopHostRuntime, prepareDesktopQuit } from "./host-runtime";
import {
  planUnsavedQuit,
  quitAlreadyRefused,
  refuseQuit,
  registerAcceptedQuitCoordinator,
} from "./quit-gate";

/** The slice of oxc's ESTree this file reads. */
interface AstNode {
  readonly type: string;
  readonly start: number;
  readonly end: number;
  readonly [field: string]: unknown;
}

const INDEX_SOURCE = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const parsed = parseSync("index.ts", INDEX_SOURCE);
if (parsed.errors.length > 0)
  throw new Error(`index.ts failed to parse: ${parsed.errors[0]?.message}`);
const program = parsed.program as unknown as AstNode;

function isNode(value: unknown): value is AstNode {
  return typeof value === "object" && value !== null && typeof (value as AstNode).type === "string";
}

function nodesWhere(test: (node: AstNode) => boolean): AstNode[] {
  const found: AstNode[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!isNode(value)) return;
    if (test(value)) found.push(value);
    for (const [field, nested] of Object.entries(value)) if (field !== "parent") visit(nested);
  };
  visit(program);
  return found;
}

function exactlyOne<T>(nodes: readonly T[], what: string): T {
  if (nodes.length !== 1) {
    throw new Error(`index.ts must contain exactly one ${what}; found ${nodes.length}.`);
  }
  return nodes[0] as T;
}

function child(node: AstNode, field: string): AstNode {
  const value = node[field];
  if (!isNode(value)) throw new Error(`${node.type}.${field} is not a node.`);
  return value;
}

function isIdentifierNamed(value: unknown, name: string): boolean {
  return isNode(value) && value.type === "Identifier" && value["name"] === name;
}

function sourceOf(node: AstNode): string {
  return INDEX_SOURCE.slice(node.start, node.end);
}

/** The initializer of index.ts's one `const|let <name> = …` declaration. */
function initializerOf(name: string): AstNode {
  const declarator = exactlyOne(
    nodesWhere((node) => node.type === "VariableDeclarator" && isIdentifierNamed(node["id"], name)),
    `declaration of \`${name}\``,
  );
  return child(declarator, "init");
}

/** The right-hand side of index.ts's one later `<name> = …` assignment. */
function assignmentTo(name: string): AstNode {
  const assignment = exactlyOne(
    nodesWhere(
      (node) =>
        node.type === "AssignmentExpression" &&
        node["operator"] === "=" &&
        isIdentifierNamed(node["left"], name),
    ),
    `assignment to \`${name}\``,
  );
  return child(assignment, "right");
}

function callsTo(name: string): AstNode[] {
  return nodesWhere(
    (node) => node.type === "CallExpression" && isIdentifierNamed(node["callee"], name),
  );
}

function isCallTo(node: AstNode, name: string): boolean {
  return node.type === "CallExpression" && isIdentifierNamed(node["callee"], name);
}

function argument(call: AstNode, index: number): AstNode {
  const value = (call["arguments"] as unknown[])[index];
  if (!isNode(value)) throw new Error(`Call has no argument ${index}.`);
  return value;
}

function objectProperty(literal: AstNode, name: string): AstNode {
  if (literal.type !== "ObjectExpression") throw new Error("Expected an object literal.");
  const property = exactlyOne(
    (literal["properties"] as AstNode[]).filter(
      (candidate) =>
        candidate.type === "Property" &&
        candidate["computed"] === false &&
        isIdentifierNamed(candidate["key"], name),
    ),
    `\`${name}:\` property`,
  );
  return child(property, "value");
}

/**
 * Evaluates one lifted index.ts expression. `scope` stands in for the lexical
 * bindings around it and is read and written LIVE (`with`), so a `let` that
 * index.ts reassigns after the expression was created is seen at call time —
 * exactly the late binding the quit gates rely on.
 */
function evaluate<T>(node: AstNode, scope: Record<string, unknown>): T {
  const stripped = transformSync("lifted.ts", `(${sourceOf(node)});`, { target: "es2022" });
  if (stripped.errors.length > 0) throw new Error(stripped.errors[0]?.message);
  const expression = stripped.code.trim().replace(/;$/, "");
  const run = new Function("scope", `with (scope) { return ${expression}; }`) as (
    scope: Record<string, unknown>,
  ) => T;
  return run(scope);
}

type QuitEvent = { preventDefault(): void };

/**
 * index.ts's quit path, lifted whole: `prepareHostQuit` as declared, each gate as
 * index.ts later assigns it, and the accepted-quit hold registered through the
 * Session runtime lifecycle's `installQuitHold`. Each gate's own port records.
 */
function liftedQuitPath(options: {
  declineUnsaved: boolean;
  cloud?: boolean;
  menuBar?: ReturnType<typeof menuBarFake> | null;
  /**
   * How each window's renderer answers a draft flush, through the REAL
   * `createClientStateFlush`: after `answerAfterMs` (it sends its draft,
   * then acks), or never.
   */
  renderer?: { answerAfterMs: number } | "silent";
  shutdownFlushTimeoutMs?: number;
}) {
  const calls: string[] = [];
  const listeners: Array<(event: QuitEvent) => void> = [];
  const exited = Promise.withResolvers<number>();
  const ptyManager = {
    kind: "pty-manager",
    killAll: () => {
      calls.push("terminals.killAll");
    },
  };
  const hostCore = {
    stop: vi.fn(async () => {
      calls.push("host.stop");
    }),
    warnIfFollowUpCleanCloseSkipped: vi.fn(),
  };
  const app = {
    on: (event: string, listener: (event: QuitEvent) => void) => {
      expect(event).toBe("before-quit");
      listeners.push(listener);
    },
    exit: exited.resolve,
  };
  const scope: Record<string, unknown> = {
    // Real modules index.ts imports.
    prepareDesktopQuit,
    registerAcceptedQuitCoordinator,
    planUnsavedQuit,
    quitAlreadyRefused,
    refuseQuit,
    errorMessage: (error: unknown) => String(error),
    // index.ts's own surroundings.
    noQuitAction: () => {},
    runtimeAutomations: {
      stop: () => {
        calls.push("automations.stop");
      },
    },
    updateInstallQuitInFlight: () => false,
    isExperimentEnabled: (id: string) => {
      expect(id).toBe("cloud");
      return options.cloud === true;
    },
    menuBarHost: options.menuBar ?? null,
    hostClosing: false,
    unsavedDocumentNames: () => ["draft.md"],
    process: { env: {} },
    confirmDiscardUnsaved: (names: readonly string[], verb: string) => {
      calls.push(`unsaved.confirm:${names.join(",")}:${verb}`);
      return !options.declineUnsaved;
    },
    ptyManager,
    prepareTerminalQuit: (manager: unknown, event: QuitEvent) => {
      expect(manager).toBe(ptyManager);
      calls.push(quitAlreadyRefused(event) ? "terminal.gate(refused)" : "terminal.gate");
    },
    transcriptRepackAbort: {
      abort: () => {
        calls.push("repack.abort");
      },
    },
    app,
    // index.ts hands the quit coordinator `app` with a log-flushing exit
    // (VC-699); the lifted path sees the same object under that name.
    quittingApp: app,
    hostCore,
    // Hosts added over SSH (VC-700): their tunnels and links close with the host.
    remoteHosts: {
      close: vi.fn(async () => {
        calls.push("remote-hosts.close");
      }),
    },
    webSealing: {
      stop: vi.fn(() => {
        calls.push("web-sealing.stop");
      }),
    },
    console: { error: vi.fn() },
    // The draft flush barrier (VC-577), as index.ts names and builds it:
    // the real barrier, over renderers this test scripts.
    BrowserWindow: { getAllWindows: () => ["window"] },
    SHUTDOWN_FLUSH_TIMEOUT_MS: options.shutdownFlushTimeoutMs ?? SHUTDOWN_FLUSH_TIMEOUT_MS,
    flushWindowState: (windows: unknown[], timeoutMs: number) => {
      calls.push(`windows.flush:${windows.length}`);
      const renderer = options.renderer ?? { answerAfterMs: 0 };
      return flusher.flush(
        windows.map((): FlushTarget => ({
          isDestroyed: () => false,
          requestFlush: (requestId) => {
            if (renderer === "silent") return;
            setTimeout(() => {
              calls.push("renderer.draft-sent");
              flusher.acknowledge(requestId);
            }, renderer.answerAfterMs);
          },
        })),
        timeoutMs,
      );
    },
  };
  let nextRequest = 0;
  const flusher = createClientStateFlush({
    newRequestId: () => `flush-${++nextRequest}`,
    log: (line) => calls.push(`flush.log:${line}`),
  });
  // Boot order as in index.ts: the gates start as no-ops, prepareHostQuit and
  // the quit hold are created, and only later does each gate get its body.
  scope["terminalQuit"] = evaluate(initializerOf("terminalQuit"), scope);
  scope["unsavedQuit"] = evaluate(initializerOf("unsavedQuit"), scope);
  scope["abortRepack"] = evaluate(initializerOf("abortRepack"), scope);
  scope["systemShutdownTeardown"] = evaluate(initializerOf("systemShutdownTeardown"), scope);
  scope["systemShutdownFlush"] = evaluate(initializerOf("systemShutdownFlush"), scope);
  scope["prepareHostQuit"] = evaluate(initializerOf("prepareHostQuit"), scope);
  const lifecycleCall = exactlyOne(
    callsTo("createSessionRuntimeLifecycle"),
    "createSessionRuntimeLifecycle(...) call",
  );
  const installQuitHold = evaluate<() => void>(
    objectProperty(argument(lifecycleCall, 0), "installQuitHold"),
    scope,
  );
  installQuitHold();
  scope["unsavedQuit"] = evaluate(assignmentTo("unsavedQuit"), scope);
  scope["terminalQuit"] = evaluate(assignmentTo("terminalQuit"), scope);
  scope["abortRepack"] = evaluate(assignmentTo("abortRepack"), scope);
  scope["systemShutdownTeardown"] = evaluate(assignmentTo("systemShutdownTeardown"), scope);
  return { calls, listeners, exited: exited.promise, hostCore, scope };
}

function menuBarFake(
  branch: "quit" | "menu-bar",
  calls: string[],
  options: { shuttingDown?: boolean; tabs?: "close" | "cancel" } = {},
) {
  return {
    systemShuttingDown: vi.fn(() => options.shuttingDown === true),
    confirmEnter: vi.fn(() => {
      if (options.tabs === undefined) return true;
      calls.push("tabs.confirm");
      return options.tabs === "close";
    }),
    branch: vi.fn(() => branch),
    enter: vi.fn(() => {
      calls.push("menu-bar.enter");
    }),
  };
}

describe("index.ts quit wiring", () => {
  it("routes the 15-second shutdown deadline to the host's one-time watermark warning", async () => {
    vi.useFakeTimers();
    try {
      const quit = liftedQuitPath({ declineUnsaved: false });
      quit.hostCore.stop.mockImplementation(() => new Promise<void>(() => {}));
      quit.listeners[0]?.({ preventDefault: vi.fn() });
      await vi.advanceTimersByTimeAsync(14_999);
      expect(quit.hostCore.warnIfFollowUpCleanCloseSkipped).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(quit.hostCore.warnIfFollowUpCleanCloseSkipped).toHaveBeenCalledExactlyOnceWith(
        "quit: shutdown deadline expired after 15000ms",
      );
      await vi.runOnlyPendingTimersAsync();
      expect(await quit.exited).toBe(0);
      quit.listeners[0]?.({ preventDefault: vi.fn() });
      await vi.advanceTimersByTimeAsync(15_000);
      expect(quit.hostCore.stop).toHaveBeenCalledOnce();
      expect(quit.hostCore.warnIfFollowUpCleanCloseSkipped).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("has one accepted-quit hold, registered through the Session runtime lifecycle", () => {
    const hold = exactlyOne(
      callsTo("registerAcceptedQuitCoordinator"),
      "registerAcceptedQuitCoordinator(...) call",
    );
    const lifecycleCall = exactlyOne(
      callsTo("createSessionRuntimeLifecycle"),
      "createSessionRuntimeLifecycle(...) call",
    );
    const installQuitHold = objectProperty(argument(lifecycleCall, 0), "installQuitHold");
    expect(hold.start >= installQuitHold.start && hold.end <= installQuitHold.end).toBe(true);
  });

  it("an accepted quit runs all four gates in order, then stops the host and exits 0", async () => {
    const quit = liftedQuitPath({ declineUnsaved: false });
    expect(quit.listeners).toHaveLength(1);
    const event = { preventDefault: vi.fn() };
    quit.listeners[0]?.(event);
    expect(quit.calls).toEqual([
      "automations.stop",
      "unsaved.confirm:draft.md:Quit",
      "terminal.gate",
      "repack.abort",
    ]);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(await quit.exited).toBe(0);
    expect(quit.hostCore.stop).toHaveBeenCalledOnce();
    // The host and the remote hosts' tunnels close together (VC-700).
    expect(quit.calls.slice(-3)).toEqual(["web-sealing.stop", "host.stop", "remote-hosts.close"]);
  });

  it("a refused quit still runs all four gates in order and never stops the host", async () => {
    const quit = liftedQuitPath({ declineUnsaved: true });
    const event = { preventDefault: vi.fn() };
    quit.listeners[0]?.(event);
    expect(quit.calls).toEqual([
      "automations.stop",
      "unsaved.confirm:draft.md:Quit",
      "terminal.gate(refused)",
      "repack.abort",
    ]);
    expect(quitAlreadyRefused(event)).toBe(true);
    await new Promise((resolve) => setImmediate(resolve));
    expect(quit.hostCore.stop).not.toHaveBeenCalled();
    expect(quit.calls).not.toContain("web-sealing.stop");
  });

  it("prepareHostQuit reads each gate at quit time, not when it was created", () => {
    const quit = liftedQuitPath({ declineUnsaved: false });
    const late: string[] = [];
    for (const gate of ["unsavedQuit", "terminalQuit", "abortRepack"]) {
      quit.scope[gate] = () => {
        late.push(gate);
      };
    }
    (quit.scope["prepareHostQuit"] as (event: QuitEvent) => void)({ preventDefault: vi.fn() });
    expect(quit.calls).toEqual(["automations.stop"]);
    expect(late).toEqual(["unsavedQuit", "terminalQuit", "abortRepack"]);
  });

  it("flag off: a built menu-bar host is never asked, and the quit is today's", async () => {
    const calls: string[] = [];
    const menuBar = menuBarFake("menu-bar", calls);
    const quit = liftedQuitPath({ declineUnsaved: false, cloud: false, menuBar });
    quit.listeners[0]?.({ preventDefault: vi.fn() });
    expect(quit.calls.slice(0, 4)).toEqual([
      "automations.stop",
      "unsaved.confirm:draft.md:Quit",
      "terminal.gate",
      "repack.abort",
    ]);
    expect(menuBar.branch).not.toHaveBeenCalled();
    expect(await quit.exited).toBe(0);
  });

  it("flag on, live work: the confirms run, then menu-bar mode — no Automation stop, no host stop", async () => {
    const quit = liftedQuitPath({ declineUnsaved: false, cloud: true });
    const menuBar = menuBarFake("menu-bar", quit.calls);
    quit.scope["menuBarHost"] = menuBar;
    const event = { preventDefault: vi.fn() };
    quit.listeners[0]?.(event);
    expect(quit.calls).toEqual([
      "unsaved.confirm:draft.md:Quit",
      "terminal.gate",
      "menu-bar.enter",
    ]);
    expect(quitAlreadyRefused(event)).toBe(true);
    await new Promise((resolve) => setImmediate(resolve));
    expect(quit.hostCore.stop).not.toHaveBeenCalled();
  });

  it("flag on, no live work: today's quit with the two stops behind the decision", async () => {
    const quit = liftedQuitPath({ declineUnsaved: false, cloud: true });
    quit.scope["menuBarHost"] = menuBarFake("quit", quit.calls);
    quit.listeners[0]?.({ preventDefault: vi.fn() });
    expect(quit.calls.slice(0, 4)).toEqual([
      "unsaved.confirm:draft.md:Quit",
      "terminal.gate",
      "automations.stop",
      "repack.abort",
    ]);
    expect(await quit.exited).toBe(0);
  });

  it("flag on, system shutdown noted: no confirm is asked, their teardown runs, and the quit is accepted", async () => {
    const quit = liftedQuitPath({ declineUnsaved: true, cloud: true });
    const menuBar = menuBarFake("menu-bar", quit.calls, { shuttingDown: true });
    quit.scope["menuBarHost"] = menuBar;
    const event = { preventDefault: vi.fn() };
    quit.listeners[0]?.(event);
    expect(quit.calls.slice(0, 4)).toEqual([
      "terminals.killAll",
      "windows.flush:1",
      "automations.stop",
      "repack.abort",
    ]);
    expect(menuBar.branch).not.toHaveBeenCalled();
    expect(quitAlreadyRefused(event)).toBe(false);
    expect(await quit.exited).toBe(0);
    expect(quit.hostCore.stop).toHaveBeenCalledOnce();
    // The flush is joined: the renderer's draft went out before the exit.
    expect(quit.calls).toContain("renderer.draft-sent");
  });

  it("flag on, system shutdown: exit waits for a responsive renderer's draft (the re-check probe)", async () => {
    const quit = liftedQuitPath({
      declineUnsaved: true,
      cloud: true,
      renderer: { answerAfterMs: 50 },
    });
    quit.scope["menuBarHost"] = menuBarFake("menu-bar", quit.calls, { shuttingDown: true });
    let draftSentAtExit = false;
    const exited = quit.exited.then((code) => {
      draftSentAtExit = quit.calls.includes("renderer.draft-sent");
      return code;
    });
    quit.listeners[0]?.({ preventDefault: vi.fn() });
    // The host stops at once; the renderer answers 50ms later, inside the bound.
    expect(await exited).toBe(0);
    expect(draftSentAtExit).toBe(true);
  });

  it("flag on, system shutdown: a silent renderer never stalls power-off past the bound", async () => {
    const quit = liftedQuitPath({
      declineUnsaved: true,
      cloud: true,
      renderer: "silent",
      shutdownFlushTimeoutMs: 30,
    });
    quit.scope["menuBarHost"] = menuBarFake("menu-bar", quit.calls, { shuttingDown: true });
    const event = { preventDefault: vi.fn() };
    quit.listeners[0]?.(event);
    expect(await quit.exited).toBe(0);
    expect(quitAlreadyRefused(event)).toBe(false);
    expect(quit.calls).not.toContain("renderer.draft-sent");
    expect(quit.calls).toEqual(
      expect.arrayContaining([expect.stringContaining("flush.log:[client-state] 1 window(s)")]),
    );
  });

  it("flag off, system shutdown noted: today's confirms, and a decline still refuses", async () => {
    const quit = liftedQuitPath({ declineUnsaved: true, cloud: false });
    const menuBar = menuBarFake("menu-bar", quit.calls, { shuttingDown: true });
    quit.scope["menuBarHost"] = menuBar;
    const event = { preventDefault: vi.fn() };
    quit.listeners[0]?.(event);
    expect(quit.calls).toEqual([
      "automations.stop",
      "unsaved.confirm:draft.md:Quit",
      "terminal.gate(refused)",
      "repack.abort",
    ]);
    expect(menuBar.systemShuttingDown).not.toHaveBeenCalled();
    expect(quitAlreadyRefused(event)).toBe(true);
  });

  it("flag on, live work over agent Browser Tabs: Cancel refuses before the terminal gate", () => {
    const quit = liftedQuitPath({ declineUnsaved: false, cloud: true });
    const menuBar = menuBarFake("menu-bar", quit.calls, { tabs: "cancel" });
    quit.scope["menuBarHost"] = menuBar;
    const event = { preventDefault: vi.fn() };
    quit.listeners[0]?.(event);
    expect(quit.calls).toEqual([
      "unsaved.confirm:draft.md:Quit",
      "tabs.confirm",
      "terminal.gate(refused)",
    ]);
    expect(menuBar.enter).not.toHaveBeenCalled();
    expect(quitAlreadyRefused(event)).toBe(true);
  });

  it("flag on, but the host is already stopping: never offered menu-bar mode", () => {
    const quit = liftedQuitPath({ declineUnsaved: false, cloud: true });
    const menuBar = menuBarFake("menu-bar", quit.calls);
    quit.scope["menuBarHost"] = menuBar;
    quit.scope["hostClosing"] = true;
    (quit.scope["prepareHostQuit"] as (event: QuitEvent) => void)({ preventDefault: vi.fn() });
    expect(menuBar.branch).not.toHaveBeenCalled();
    expect(quit.calls[0]).toBe("automations.stop");
  });
});

/** index.ts's one `app.on("<event>", listener)` listener, as source. */
function appListener(event: string): AstNode {
  const call = exactlyOne(
    nodesWhere((node) => {
      if (node.type !== "CallExpression") return false;
      const callee = node["callee"];
      if (!isNode(callee) || callee.type !== "MemberExpression") return false;
      if (!isIdentifierNamed(callee["object"], "app")) return false;
      if (!isIdentifierNamed(callee["property"], "on")) return false;
      const first = (node["arguments"] as unknown[])[0];
      return isNode(first) && first.type === "Literal" && first["value"] === event;
    }),
    `app.on("${event}", …) listener`,
  );
  return argument(call, 1);
}

function windowsFake(count: number) {
  const restore = vi.fn();
  const focus = vi.fn();
  const all = Array.from({ length: count }, () => ({
    isMinimized: () => false,
    restore,
    focus,
  }));
  // Flag off nothing is ever retiring, so the live windows are all of them.
  return { BrowserWindow: { getAllWindows: () => all }, liveWindows: () => all, restore, focus };
}

describe("index.ts window-return wiring (VC-577)", () => {
  it("activate with no window reveals through the menu-bar host; with one, does nothing", () => {
    const reveal = vi.fn();
    const noteActivated = vi.fn();
    const listener = evaluate<() => void>(appListener("activate"), {
      ...windowsFake(0),
      menuBar: { reveal, noteActivated },
    });
    listener();
    expect(reveal).toHaveBeenCalledExactlyOnceWith();
    // Every activation ends a noted logout (VC-577 B3), window or not.
    expect(noteActivated).toHaveBeenCalledOnce();
    const busy = vi.fn();
    evaluate<() => void>(appListener("activate"), {
      ...windowsFake(1),
      menuBar: { reveal: busy, noteActivated },
    })();
    expect(busy).not.toHaveBeenCalled();
    expect(noteActivated).toHaveBeenCalledTimes(2);
  });

  it("second-instance with no window: today's early return with the flag off, a reveal with it on", () => {
    for (const cloud of [false, true]) {
      const reveal = vi.fn();
      const listener = evaluate<() => void>(appListener("second-instance"), {
        ...windowsFake(0),
        isExperimentEnabled: () => cloud,
        revealWindowForLaunch: reveal,
      });
      listener();
      expect(reveal).toHaveBeenCalledTimes(cloud ? 1 : 0);
    }
  });

  it("a notification click with no window reveals through the menu-bar host once it exists", () => {
    const opener = argument(exactlyOne(callsToMember("bindWindowOpener"), "bindWindowOpener"), 0);
    const reveal = vi.fn();
    const createOwnedWindow = vi.fn();
    evaluate<() => void>(opener, {
      ...windowsFake(0),
      menuBarHost: { reveal },
      createOwnedWindow,
    })();
    expect(reveal).toHaveBeenCalledOnce();
    expect(createOwnedWindow).not.toHaveBeenCalled();
    // Before the host exists (boot), exactly the former body.
    evaluate<() => void>(opener, { ...windowsFake(0), menuBarHost: null, createOwnedWindow })();
    expect(createOwnedWindow).toHaveBeenCalledOnce();
    evaluate<() => void>(opener, { ...windowsFake(1), menuBarHost: null, createOwnedWindow })();
    expect(createOwnedWindow).toHaveBeenCalledOnce();
  });
});

/** A window as closeAll and open touch it. */
function fakeWindow(name: string, calls: string[]) {
  let destroyed = false;
  return {
    name,
    hide: () => calls.push(`${name}.hide`),
    isDestroyed: () => destroyed,
    destroy: () => {
      destroyed = true;
      calls.push(`${name}.destroy`);
    },
  };
}

describe("index.ts menu-bar entry wiring (VC-577 B2)", () => {
  function liftedEntry() {
    const ports = argument(exactlyOne(callsTo("createMenuBarHost"), "createMenuBarHost(...)"), 0);
    const windowsPort = objectProperty(ports, "windows");
    const calls: string[] = [];
    const a = fakeWindow("a", calls);
    const b = fakeWindow("b", calls);
    const all = [a, b];
    const retiringWindows = new WeakSet<object>();
    const timers = new Map<number, () => void>();
    let nextTimer = 0;
    let nextRequestId = 0;
    const flusher = createClientStateFlush({
      newRequestId: () => `req-${++nextRequestId}`,
      timers: {
        setTimeout: (run) => {
          nextTimer += 1;
          timers.set(nextTimer, run);
          return nextTimer;
        },
        clearTimeout: (handle) => {
          timers.delete(handle as number);
        },
      },
      log: () => {},
    });
    const requests = new Map<string, string>();
    const createOwnedWindow = vi.fn();
    const revealWindow = vi.fn();
    const warn = vi.fn();
    const deferred: (() => void)[] = [];
    const scope = {
      setImmediate: (run: () => void) => deferred.push(run),
      liveWindows: () => all.filter((each) => !each.isDestroyed() && !retiringWindows.has(each)),
      retiringWindows,
      MENU_BAR_FLUSH_OVERDUE_MS,
      // index.ts's flushWindowState over the real barrier; each request id
      // is remembered per window so the test answers as that renderer.
      flushWindowState: (
        closing: ReturnType<typeof fakeWindow>[],
        timeoutMs: number,
        onAcked: (window: ReturnType<typeof fakeWindow>) => void,
      ) => {
        calls.push(`flush:${closing.length}:${timeoutMs}`);
        return flusher.flush(
          closing.map((window) => ({
            isDestroyed: () => window.isDestroyed(),
            requestFlush: (requestId: string) => requests.set(window.name, requestId),
            onAcked: () => onAcked(window),
          })),
          timeoutMs,
        );
      },
      // index.ts logs through the structured logger (VC-699).
      hostLogger: (component: string) => ({
        warn: (msg: string, fields?: unknown) => warn(`[${component}] ${msg}`, fields),
        info: vi.fn(),
      }),
      BrowserWindow: { getAllWindows: () => all.filter((each) => !each.isDestroyed()) },
      createOwnedWindow,
      revealWindow,
      nativeWindowPolicy: { kind: "native" },
    };
    return {
      closeAll: evaluate<() => void>(objectProperty(windowsPort, "closeAll"), scope),
      open: evaluate<() => void>(objectProperty(windowsPort, "open"), scope),
      count: evaluate<() => number>(objectProperty(windowsPort, "count"), scope),
      ack: (name: string) => flusher.acknowledge(requests.get(name)),
      runDeferred: () => {
        for (const run of deferred.splice(0)) run();
      },
      overdue: () => {
        for (const [id, run] of timers) {
          timers.delete(id);
          run();
        }
      },
      calls,
      a,
      b,
      retiringWindows,
      createOwnedWindow,
      revealWindow,
      warn,
    };
  }

  it("hides every window, then destroys each one only from its own renderer's flush ack", async () => {
    const entry = liftedEntry();
    entry.closeAll();
    expect(entry.calls).toEqual(["a.hide", "b.hide", `flush:2:${MENU_BAR_FLUSH_OVERDUE_MS}`]);
    // Retired at once: hidden windows no longer count as open.
    expect(entry.count()).toBe(0);
    entry.ack("a");
    expect(entry.a.isDestroyed()).toBe(false);
    entry.runDeferred();
    expect(entry.calls.at(-1)).toBe("a.destroy");
    expect(entry.b.isDestroyed()).toBe(false);
    entry.ack("b");
    expect(entry.b.isDestroyed()).toBe(false);
    entry.runDeferred();
    expect(entry.calls.at(-1)).toBe("b.destroy");
    await new Promise((resolve) => setImmediate(resolve));
    expect(entry.warn).not.toHaveBeenCalled();
  });

  it("never destroys an unflushed window: overdue logs and keeps it hidden until its ack", async () => {
    const entry = liftedEntry();
    entry.closeAll();
    entry.ack("a");
    entry.runDeferred();
    entry.overdue();
    await new Promise((resolve) => setImmediate(resolve));
    expect(entry.warn).toHaveBeenCalledWith(
      "[menu-bar] windows still saving drafts; kept hidden, not destroyed",
      { unanswered: 1 },
    );
    expect(entry.b.isDestroyed()).toBe(false);
    expect(entry.retiringWindows.has(entry.b)).toBe(true);
    // The slow renderer finally saved its latest draft: now it may go.
    entry.ack("b");
    expect(entry.b.isDestroyed()).toBe(false);
    entry.runDeferred();
    expect(entry.b.isDestroyed()).toBe(true);
  });

  it("a reveal reuses a window still saving its drafts, and its late ack then keeps it", () => {
    const entry = liftedEntry();
    entry.closeAll();
    entry.ack("a");
    entry.runDeferred();
    entry.open();
    expect(entry.createOwnedWindow).not.toHaveBeenCalled();
    expect(entry.revealWindow).toHaveBeenCalledExactlyOnceWith(entry.b, { kind: "native" });
    expect(entry.retiringWindows.has(entry.b)).toBe(false);
    expect(entry.count()).toBe(1);
    entry.ack("b");
    entry.runDeferred();
    expect(entry.b.isDestroyed()).toBe(false);
    // With nothing retained, a reveal builds a fresh window.
    entry.b.destroy();
    entry.open();
    expect(entry.createOwnedWindow).toHaveBeenCalledOnce();
  });

  it("a reveal after the flush ack but before native destruction cancels the deferred teardown", () => {
    const entry = liftedEntry();
    entry.closeAll();
    entry.ack("a");
    entry.open();
    expect(entry.revealWindow).toHaveBeenCalledExactlyOnceWith(entry.a, { kind: "native" });
    entry.runDeferred();
    expect(entry.a.isDestroyed()).toBe(false);
    expect(entry.count()).toBe(1);
    expect(entry.b.isDestroyed()).toBe(false);
  });

  it("an already destroyed acknowledged window is not destroyed again by its Immediate", () => {
    const entry = liftedEntry();
    entry.closeAll();
    entry.ack("a");
    entry.a.destroy();
    entry.runDeferred();
    expect(entry.calls.filter((call) => call === "a.destroy")).toHaveLength(1);
  });

  it("closes agent Browser Tabs with a model-readable reason, and reopens them on reveal", () => {
    const ports = argument(exactlyOne(callsTo("createMenuBarHost"), "createMenuBarHost(...)"), 0);
    const tabs = objectProperty(ports, "browserTabs");
    const browserTabs = {
      sessionTabCount: vi.fn(() => 3),
      closeAllForAgents: vi.fn(),
      reopenForAgents: vi.fn(),
    };
    const scope = { browserTabs, BROWSER_CLOSED_FOR_MENU_BAR: "closed for the menu bar" };
    expect(evaluate<() => number>(objectProperty(tabs, "sessionTabCount"), scope)()).toBe(3);
    evaluate<() => void>(objectProperty(tabs, "closeForMenuBar"), scope)();
    expect(browserTabs.closeAllForAgents).toHaveBeenCalledWith("closed for the menu bar");
    evaluate<() => void>(objectProperty(tabs, "reopen"), scope)();
    expect(browserTabs.reopenForAgents).toHaveBeenCalledOnce();
  });
});

/** Calls to `<anything>.<name>(…)`. */
function callsToMember(name: string): AstNode[] {
  return nodesWhere((node) => {
    if (node.type !== "CallExpression") return false;
    const callee = node["callee"];
    return (
      isNode(callee) &&
      callee.type === "MemberExpression" &&
      isIdentifierNamed(callee["property"], name)
    );
  });
}

/** The recorded `vi.fn` at `binding` or `binding.member` in a lifted scope. */
function spy(scope: Record<string, unknown>, path: string) {
  const [binding, member] = path.split(".");
  const target = scope[binding as string] as Record<string, ReturnType<typeof vi.fn>>;
  return member === undefined
    ? (target as unknown as ReturnType<typeof vi.fn>)
    : (target[member] as ReturnType<typeof vi.fn>);
}

describe("index.ts desktop host runtime wiring", () => {
  function liftedDesktopRuntime() {
    const proof = { services: { kind: "recovered" } };
    const rpc = { kind: "session-rpc" };
    const handlers = { kind: "host-handlers" };
    let owner: HostRuntimeOwner | undefined;
    const createDesktopHostRuntimeSpy = vi.fn(createDesktopHostRuntime);
    const scope: Record<string, unknown> = {
      createDesktopHostRuntime: createDesktopHostRuntimeSpy,
      hostCore: {
        start: vi.fn(async (runtime: HostRuntimeOwner) => {
          owner = runtime;
          await runtime.start();
        }),
      },
      runtimeLifecycle: {
        ready: vi.fn(async () => proof),
        close: vi.fn(async () => {}),
      },
      sessionRpc: null,
      // The host's one handler map (VC-668), built at readiness.
      handlersFor: vi.fn(() => handlers),
      createSessionRpc: vi.fn(() => rpc),
      runtimeSessionAgents: { toolDoor: vi.fn(), stop: vi.fn() },
      runtimeAutomations: { stop: vi.fn(), settled: vi.fn(async () => {}) },
      ptyManagerRef: { stopParkSweep: vi.fn() },
      backgroundShells: { close: vi.fn(async () => {}) },
      shutdownAgentSocket: vi.fn(async () => true),
      hostClosing: false,
    };
    const call = exactlyOne(
      callsTo("createDesktopHostRuntime"),
      "createDesktopHostRuntime(...) call",
    );
    const desktopRuntime = evaluate<{ start(): Promise<unknown> }>(call, scope);
    return {
      call,
      desktopRuntime,
      proof,
      rpc,
      handlers,
      scope,
      createDesktopHostRuntimeSpy,
      owner: () => {
        if (owner === undefined) throw new Error("index.ts's runtime never reached host.start.");
        return owner;
      },
    };
  }

  it("is the runtime index.ts boots, over the host core it built", () => {
    const { call } = liftedDesktopRuntime();
    expect(initializerOf("desktopRuntime")).toBe(call);
    const ready = initializerOf("readyRuntimeServices");
    expect(ready.type).toBe("AwaitExpression");
    expect(sourceOf(ready)).toBe("await desktopRuntime.start()");
    expect(isCallTo(initializerOf("hostCore"), "createHostCore")).toBe(true);
    expect(isCallTo(initializerOf("runtimeLifecycle"), "createSessionRuntimeLifecycle")).toBe(true);
    expect(isCallTo(initializerOf("agentSocket"), "createHostAgentSocket")).toBe(true);
    const shutdown = Symbol("agentSocket.shutdown");
    expect(evaluate(initializerOf("shutdownAgentSocket"), { agentSocket: { shutdown } })).toBe(
      shutdown,
    );
  });

  it("builds the host core with desktop's quit stop policy", () => {
    const hostCoreCall = initializerOf("hostCore");
    expect(isCallTo(hostCoreCall, "createHostCore")).toBe(true);
    expect(evaluate(objectProperty(argument(hostCoreCall, 1), "stopPolicy"), {})).toBe(
      "desktop-quit",
    );
  });

  it("hands createDesktopHostRuntime index's host, Session lifecycle and agent socket", async () => {
    const f = liftedDesktopRuntime();
    expect(f.createDesktopHostRuntimeSpy).toHaveBeenCalledOnce();
    const options = f.createDesktopHostRuntimeSpy.mock.calls[0]?.[0];
    expect(options?.host).toBe(f.scope["hostCore"]);
    expect(options?.lifecycle).toBe(f.scope["runtimeLifecycle"]);

    // start: host adopts the owner, which binds only the recovered services.
    expect(await f.desktopRuntime.start()).toBe(f.proof);
    expect(spy(f.scope, "hostCore.start")).toHaveBeenCalledOnce();
    expect(spy(f.scope, "handlersFor")).toHaveBeenCalledExactlyOnceWith(f.proof);
    expect(spy(f.scope, "createSessionRpc")).toHaveBeenCalledExactlyOnceWith(f.proof, f.handlers);
    expect(f.scope["sessionRpc"]).toBe(f.rpc);
    expect(spy(f.scope, "runtimeSessionAgents.toolDoor")).toHaveBeenCalledWith(f.proof);

    // stop: index's producers stop synchronously.
    f.owner().stopProducers();
    expect(f.scope["hostClosing"]).toBe(true);
    expect(spy(f.scope, "runtimeAutomations.stop")).toHaveBeenCalledOnce();
    expect(spy(f.scope, "runtimeSessionAgents.stop")).toHaveBeenCalledOnce();
    expect(spy(f.scope, "ptyManagerRef.stopParkSweep")).toHaveBeenCalledOnce();

    // close joins index's Session runtime lifecycle; the socket is index's.
    await f.owner().close();
    expect(spy(f.scope, "runtimeLifecycle.close")).toHaveBeenCalledOnce();
    expect(spy(f.scope, "shutdownAgentSocket")).not.toHaveBeenCalled();
    expect(await f.owner().closeSocket?.()).toBe(true);
    expect(spy(f.scope, "shutdownAgentSocket")).toHaveBeenCalledOnce();
  });

  it("adds no shell or Automation waits to desktop's quit", async () => {
    const f = liftedDesktopRuntime();
    await f.desktopRuntime.start();
    f.owner().stopProducers();
    await Promise.all([f.owner().close(), f.owner().closeSocket?.()]);
    expect(spy(f.scope, "backgroundShells.close")).not.toHaveBeenCalled();
    expect(spy(f.scope, "runtimeAutomations.settled")).not.toHaveBeenCalled();
  });
});
