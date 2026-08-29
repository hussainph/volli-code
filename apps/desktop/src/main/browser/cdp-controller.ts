/**
 * The per-tab CDP controller: the party that turns a snapshot ref into real
 * input, and the only writer of the generation a ref is judged against.
 *
 * It speaks raw Chrome DevTools Protocol through an injected {@link
 * CdpTransport} — in production the tab's `webContents.debugger`, which is
 * Electron's app-private CDP client. That transport choice is the security
 * architecture: no `--remote-debugging-port` is ever opened, so there is no
 * loopback endpoint through which another local process could reach this tab
 * (or, far worse, the app's own privileged renderer). See
 * docs/research/browser-tooling-vc-110.md and the VC-110 decision comment.
 *
 * Acting is by handle, never by selector: a snapshot mints `eN → backendDOMNodeId`
 * and an action resolves through that map, so what gets clicked is the element
 * the model was shown — or nothing. Two facts gate every action: the ref must
 * have been minted by the LAST snapshot, and that snapshot must belong to the
 * tab's CURRENT generation. The host bumps the generation on navigation, so a
 * ref from before the page changed refuses rather than acts on whatever now
 * occupies the coordinates. Refusals are {@link BrowserRefusal}s — policy
 * working, translated to readable text upstream — and never dispatch input.
 *
 * Deliberately absent, mirroring the tool surface: no page-supplied
 * JavaScript, no cookie or storage domains, no network interception. `select`
 * runs one host-authored function against the resolved element because CDP has
 * no input-level option picker; the function is a fixed string in this file,
 * never composed from model text.
 */

import { BrowserRefusal } from "@volli/agent-runtime";

import { formatAXSnapshot, type AXNodeLike } from "./snapshot-format";

/** One CDP wire: send a command, and hear the events the page emits. */
export interface CdpTransport {
  send: (method: string, params?: object) => Promise<unknown>;
  /** Subscribe to protocol events; returns the unsubscribe. */
  onEvent: (listener: (method: string, params: unknown) => void) => () => void;
}

/** What one act call may say — the tool schema's shape, minus the tab id the host resolved. */
export interface TabActRequest {
  generation: number;
  kind: "click" | "type" | "press" | "select" | "hover" | "scroll" | "wait";
  ref?: string;
  text?: string;
  key?: string;
  direction?: "up" | "down";
  waitMs?: number;
}

/** A printed snapshot, stamped with the generation its refs are valid against. */
export interface TabSnapshot {
  text: string;
  generation: number;
  truncated: boolean;
}

export interface TabConsoleRecord {
  messages: { level: "debug" | "info" | "log" | "warn" | "error"; text: string }[];
  truncated: boolean;
}

/** Bounds a caller may narrow but not remove. */
export interface ControllerLimits {
  maxConsoleMessages?: number;
  maxSnapshotChars?: number;
  maxWaitMs?: number;
}

const MAX_CONSOLE_MESSAGES = 100;
const MAX_WAIT_MS = 5_000;

/** CDP console-API types folded onto the product's five levels. */
function consoleLevel(type: unknown): TabConsoleRecord["messages"][number]["level"] {
  switch (type) {
    case "debug":
      return "debug";
    case "info":
      return "info";
    case "warning":
      return "warn";
    case "error":
    case "assert":
      return "error";
    default:
      return "log";
  }
}

/**
 * A console argument as one bounded piece of text. Only primitive `value`s are
 * read; a RemoteObject's preview graph is a rabbit hole of page-shaped data
 * the record does not need.
 */
function argText(argument: unknown): string {
  if (typeof argument !== "object" || argument === null) return "";
  const value = (argument as { value?: unknown }).value;
  if (value === undefined) {
    const description = (argument as { description?: unknown }).description;
    return typeof description === "string" ? description : "[object]";
  }
  return typeof value === "string" ? value : JSON.stringify(value);
}

/**
 * The fixed function `select` runs against the resolved element. A constant by
 * design: the one place this file executes anything in the page, and nothing
 * in it comes from the model — the option value arrives as a CDP argument,
 * data rather than code.
 */
const SELECT_OPTION_FUNCTION = `function(value) {
  if (this.tagName !== "SELECT") return false;
  const option = Array.from(this.options).find(function(o) { return o.value === value || o.label === value; });
  if (!option) return false;
  this.value = option.value;
  this.dispatchEvent(new Event("input", { bubbles: true }));
  this.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}`;

/** Keys `press` understands beyond single characters, in CDP's spellings. */
const NAMED_KEYS: Record<string, { key: string; code: string; keyCode: number }> = {
  enter: { key: "Enter", code: "Enter", keyCode: 13 },
  tab: { key: "Tab", code: "Tab", keyCode: 9 },
  escape: { key: "Escape", code: "Escape", keyCode: 27 },
  backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  delete: { key: "Delete", code: "Delete", keyCode: 46 },
  arrowup: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  arrowright: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
};

const MODIFIER_BITS: Record<string, number> = {
  alt: 1,
  control: 2,
  ctrl: 2,
  meta: 4,
  cmd: 4,
  shift: 8,
};

export class BrowserTabController {
  readonly #send: CdpTransport["send"];
  readonly #limits: Required<ControllerLimits>;
  readonly #console: TabConsoleRecord["messages"] = [];
  #consoleOverflowed = false;
  #generation = 0;
  #refs: ReadonlyMap<string, number> = new Map();
  #snapshotGeneration = 0;

  constructor(transport: CdpTransport, limits: ControllerLimits = {}) {
    this.#send = transport.send;
    this.#limits = {
      maxConsoleMessages: limits.maxConsoleMessages ?? MAX_CONSOLE_MESSAGES,
      maxSnapshotChars: limits.maxSnapshotChars ?? 30_000,
      maxWaitMs: limits.maxWaitMs ?? MAX_WAIT_MS,
    };
    transport.onEvent((method, params) => this.#onEvent(method, params));
  }

  /** Domains the controller needs live; the host calls this once after attach. */
  async enable(): Promise<void> {
    await this.#send("Accessibility.enable");
    await this.#send("Runtime.enable");
    await this.#send("DOM.enable");
    await this.#send("Page.enable");
  }

  /**
   * The host's notice that the page changed under the refs: every navigation
   * bumps this, and an action carrying an older generation refuses. The
   * controller cannot see navigations itself — the host owns the webContents
   * and its events, so the host owns the bump.
   */
  bumpGeneration(): void {
    this.#generation += 1;
  }

  get generation(): number {
    return this.#generation;
  }

  async snapshot(): Promise<TabSnapshot> {
    if (this.#generation === 0) this.#generation = 1;
    const answer = (await this.#send("Accessibility.getFullAXTree")) as {
      nodes?: AXNodeLike[];
    };
    const printed = formatAXSnapshot(answer.nodes ?? [], {
      maxChars: this.#limits.maxSnapshotChars,
    });
    this.#refs = printed.refs;
    this.#snapshotGeneration = this.#generation;
    return { text: printed.text, generation: this.#generation, truncated: printed.truncated };
  }

  /**
   * Perform one action, after the two checks that make a ref honest: the
   * generation the caller quotes must be the tab's current one, and the ref
   * must have been minted by the snapshot of that generation. Both refuse
   * before any input is dispatched.
   */
  async act(request: TabActRequest): Promise<void> {
    if (request.generation !== this.#generation || this.#snapshotGeneration !== this.#generation) {
      throw new BrowserRefusal(
        "browser.stale-ref",
        `The tab is at generation ${this.#generation}, and refs from generation ${request.generation} no longer name what the page shows: take a fresh snapshot.`,
      );
    }
    switch (request.kind) {
      case "click":
        return this.#pointer(this.#resolve(request.ref), "click");
      case "hover":
        return this.#pointer(this.#resolve(request.ref), "hover");
      case "type": {
        const backendNodeId = this.#resolve(request.ref);
        await this.#send("DOM.focus", { backendNodeId });
        await this.#send("Input.insertText", { text: request.text ?? "" });
        return;
      }
      case "press":
        return this.#press(request.key ?? "");
      case "select": {
        const backendNodeId = this.#resolve(request.ref);
        const resolved = (await this.#send("DOM.resolveNode", { backendNodeId })) as {
          object?: { objectId?: string };
        };
        const objectId = resolved.object?.objectId;
        if (objectId === undefined) {
          throw new BrowserRefusal(
            "browser.unknown-ref",
            "The element behind that ref is gone from the page: take a fresh snapshot.",
          );
        }
        await this.#send("Runtime.callFunctionOn", {
          objectId,
          functionDeclaration: SELECT_OPTION_FUNCTION,
          arguments: [{ value: request.text ?? "" }],
        });
        return;
      }
      case "scroll": {
        const { x, y } = await this.#viewportCenter();
        await this.#send("Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x,
          y,
          deltaX: 0,
          deltaY: request.direction === "up" ? -500 : 500,
        });
        return;
      }
      case "wait": {
        const bounded = Math.min(Math.max(request.waitMs ?? 500, 0), this.#limits.maxWaitMs);
        await new Promise((resolve) => setTimeout(resolve, bounded));
        return;
      }
    }
  }

  /** The bounded, most-recent console record, oldest first. */
  console(): TabConsoleRecord {
    return { messages: [...this.#console], truncated: this.#consoleOverflowed };
  }

  async screenshot(): Promise<{ base64Png: string; width: number; height: number }> {
    const captured = (await this.#send("Page.captureScreenshot", { format: "png" })) as {
      data?: string;
    };
    const metrics = (await this.#send("Page.getLayoutMetrics")) as {
      cssVisualViewport?: { clientWidth?: number; clientHeight?: number };
    };
    return {
      base64Png: captured.data ?? "",
      width: Math.round(metrics.cssVisualViewport?.clientWidth ?? 0),
      height: Math.round(metrics.cssVisualViewport?.clientHeight ?? 0),
    };
  }

  #onEvent(method: string, params: unknown): void {
    if (method === "Runtime.consoleAPICalled") {
      const event = params as { type?: unknown; args?: unknown[] };
      const text = (event.args ?? [])
        .map(argText)
        .filter((one) => one !== "")
        .join(" ");
      this.#record({ level: consoleLevel(event.type), text });
      return;
    }
    if (method === "Runtime.exceptionThrown") {
      const details = (
        params as { exceptionDetails?: { text?: string; exception?: { description?: string } } }
      ).exceptionDetails;
      const text = [details?.text, details?.exception?.description]
        .filter((one): one is string => typeof one === "string" && one !== "")
        .join(" ");
      this.#record({ level: "error", text });
    }
  }

  #record(message: TabConsoleRecord["messages"][number]): void {
    this.#console.push(message);
    if (this.#console.length > this.#limits.maxConsoleMessages) {
      this.#console.shift();
      this.#consoleOverflowed = true;
    }
  }

  #resolve(ref: string | undefined): number {
    const backendNodeId = ref === undefined ? undefined : this.#refs.get(ref);
    if (backendNodeId === undefined) {
      throw new BrowserRefusal(
        "browser.unknown-ref",
        `No current snapshot minted a ref ${JSON.stringify(ref ?? "")}: act on a ref the latest snapshot shows.`,
      );
    }
    return backendNodeId;
  }

  async #pointer(backendNodeId: number, kind: "click" | "hover"): Promise<void> {
    await this.#send("DOM.scrollIntoViewIfNeeded", { backendNodeId });
    const box = (await this.#send("DOM.getBoxModel", { backendNodeId })) as {
      model?: { content?: number[] };
    };
    const quad = box.model?.content;
    if (quad === undefined || quad.length < 8) {
      throw new BrowserRefusal(
        "browser.unactionable",
        "The element behind that ref has no visible box to act on: take a fresh snapshot.",
      );
    }
    const x = (quad[0]! + quad[2]! + quad[4]! + quad[6]!) / 4;
    const y = (quad[1]! + quad[3]! + quad[5]! + quad[7]!) / 4;
    if (kind === "hover") {
      await this.#send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
      return;
    }
    await this.#send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button: "left",
      clickCount: 1,
    });
    await this.#send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button: "left",
      clickCount: 1,
    });
  }

  async #press(spec: string): Promise<void> {
    const parts = spec
      .split("+")
      .map((one) => one.trim())
      .filter((one) => one !== "");
    const keyPart = parts.at(-1) ?? "";
    const modifiers = parts
      .slice(0, -1)
      .reduce((bits, name) => bits | (MODIFIER_BITS[name.toLowerCase()] ?? 0), 0);
    const named = NAMED_KEYS[keyPart.toLowerCase()];
    const key = named ?? {
      key: keyPart,
      code: `Key${keyPart.toUpperCase()}`,
      keyCode: keyPart.toUpperCase().charCodeAt(0),
    };
    if (keyPart === "") {
      throw new BrowserRefusal(
        "browser.unactionable",
        "press needs a key, e.g. Enter or Control+a.",
      );
    }
    await this.#send("Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      modifiers,
      key: key.key,
      code: key.code,
      windowsVirtualKeyCode: key.keyCode,
    });
    // A printable single character also produces its char event, so text
    // inputs actually receive it the way a keyboard would deliver it.
    if (named === undefined && keyPart.length === 1) {
      await this.#send("Input.dispatchKeyEvent", {
        type: "char",
        modifiers,
        text: keyPart,
        key: key.key,
      });
    }
    await this.#send("Input.dispatchKeyEvent", {
      type: "keyUp",
      modifiers,
      key: key.key,
      code: key.code,
      windowsVirtualKeyCode: key.keyCode,
    });
  }

  async #viewportCenter(): Promise<{ x: number; y: number }> {
    const metrics = (await this.#send("Page.getLayoutMetrics")) as {
      cssVisualViewport?: { clientWidth?: number; clientHeight?: number };
    };
    return {
      x: Math.round((metrics.cssVisualViewport?.clientWidth ?? 0) / 2),
      y: Math.round((metrics.cssVisualViewport?.clientHeight ?? 0) / 2),
    };
  }
}
