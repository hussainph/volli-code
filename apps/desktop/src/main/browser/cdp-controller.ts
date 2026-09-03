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

import { formatAXSnapshot, SNAPSHOT_MAX_CHARS, type AXNodeLike } from "./snapshot-format";

/** One CDP wire. Production may re-establish and initialize its attachment. */
export interface CdpTransport {
  send: (method: string, params?: object) => Promise<unknown>;
  ensureReady?: () => Promise<void>;
  dispose?: () => void;
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

/** Bounds a caller may narrow but not remove. */
export interface ControllerLimits {
  maxSnapshotChars?: number;
  maxWaitMs?: number;
  maxCommandMs?: number;
}

const MAX_WAIT_MS = 5_000;

/**
 * How long one CDP command may go unanswered before its call fails. A crashed
 * renderer or an engine starved of frames can leave `webContents.debugger`
 * waiting forever, and an unbounded wait wedges the whole Session behind one
 * tool call (VC-252); the bound turns that into one readable failure the
 * caller can act on.
 */
export const CDP_COMMAND_TIMEOUT_MS = 15_000;

function narrowedLimit(requested: number | undefined, maximum: number): number {
  return Math.min(Math.max(requested ?? maximum, 0), maximum);
}

async function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const finish = (): void => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const abort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("Browser action cancelled"));
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
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
  readonly #ensureReady: CdpTransport["ensureReady"];
  readonly #disposeTransport: CdpTransport["dispose"];
  readonly #limits: Required<ControllerLimits>;
  #generation = 0;
  #refs: ReadonlyMap<string, number> = new Map();
  #snapshotGeneration = -1;
  #nextRef = 1;

  constructor(transport: CdpTransport, limits: ControllerLimits = {}) {
    this.#send = transport.send;
    this.#ensureReady = transport.ensureReady;
    this.#disposeTransport = transport.dispose;
    this.#limits = {
      maxSnapshotChars: Math.floor(narrowedLimit(limits.maxSnapshotChars, SNAPSHOT_MAX_CHARS)),
      maxWaitMs: narrowedLimit(limits.maxWaitMs, MAX_WAIT_MS),
      maxCommandMs: narrowedLimit(limits.maxCommandMs, CDP_COMMAND_TIMEOUT_MS),
    };
  }

  /** Domains the controller needs live; the host calls this once after attach. */
  async enable(signal?: AbortSignal): Promise<void> {
    if (this.#ensureReady !== undefined) {
      await this.#bounded(this.#ensureReady(), "its CDP attachment", signal);
      return;
    }
    await this.#command("Accessibility.enable", undefined, signal);
    await this.#command("DOM.enable", undefined, signal);
    await this.#command("Page.enable", undefined, signal);
  }

  /**
   * One engine answer, raced against the caller's signal and the command
   * clock. Losing either way rejects THIS call while the transport's own
   * promise stays harmlessly attached — a late answer settles a promise
   * nobody reads, never a session.
   */
  async #bounded<T>(answer: Promise<T>, what: string, signal?: AbortSignal): Promise<T> {
    // An already-aborted signal never dispatches `abort` to a listener added
    // after the fact, so the race below would wait out the whole clock for a
    // turn that is already gone. Answer it here instead.
    if (signal?.aborted === true) throw signal.reason;
    return await new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (settle: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        settle();
      };
      const abort = (): void => {
        finish(() => reject(signal?.reason ?? new Error("Browser action cancelled")));
      };
      const timer = setTimeout(() => {
        finish(() =>
          reject(
            new Error(
              `The Browser Tab's engine did not answer ${what} within ${this.#limits.maxCommandMs}ms.`,
            ),
          ),
        );
      }, this.#limits.maxCommandMs);
      signal?.addEventListener("abort", abort, { once: true });
      answer.then(
        (value) => finish(() => resolve(value)),
        (error: unknown) => finish(() => reject(error)),
      );
    });
  }

  /** Every CDP command this controller speaks goes through the bounded wire. */
  async #command(method: string, params?: object, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted();
    return await this.#bounded(this.#send(method, params), method, signal);
  }

  /**
   * The second half of a two-part input gesture, sent whatever became of the
   * first half.
   *
   * Press and release are one gesture to the page, but two commands on the
   * wire. The bound above can reject between them — on a timeout, or when the
   * turn is withdrawn — and a `mousePressed` with no `mouseReleased` leaves the
   * page holding a button down for as long as it lives: text selects on every
   * move, drags start, and the next Session to reach that tab inherits it. So
   * the release is best-effort and deliberately UNBOUND by the caller's signal.
   * A cancelled turn still owes the page a mouse-up, and its own failure is
   * what the caller hears; the release only ever adds to that, never replaces
   * it.
   */
  async #releaseHalf(method: string, params: object): Promise<void> {
    try {
      await this.#bounded(this.#send(method, params), method);
    } catch {
      // Nothing left to try. The engine is gone, wedged, or tearing down —
      // all three end the same way, and the caller already has the real fault.
    }
  }

  /**
   * Adopt the generation the host counted off the webContents' own events.
   * Monotonic by construction — the larger count wins and a smaller one is a
   * late echo, never a reason to resurrect refs that already staled.
   */
  syncGeneration(generation: number): void {
    if (generation <= this.#generation) return;
    this.#generation = generation;
    this.#refs = new Map();
    this.#snapshotGeneration = -1;
    this.#nextRef = 1;
  }

  get generation(): number {
    return this.#generation;
  }

  dispose(): void {
    this.#disposeTransport?.();
    this.#refs = new Map();
    this.#snapshotGeneration = -1;
  }

  async snapshot(signal?: AbortSignal): Promise<TabSnapshot> {
    signal?.throwIfAborted();
    const answer = (await this.#command("Accessibility.getFullAXTree", undefined, signal)) as {
      nodes?: AXNodeLike[];
    };
    signal?.throwIfAborted();
    const printed = formatAXSnapshot(answer.nodes ?? [], {
      maxChars: this.#limits.maxSnapshotChars,
      refStart: this.#nextRef,
    });
    this.#refs = printed.refs;
    this.#snapshotGeneration = this.#generation;
    this.#nextRef = printed.nextRef;
    return { text: printed.text, generation: this.#generation, truncated: printed.truncated };
  }

  /**
   * Perform one action, after the two checks that make a ref honest: the
   * generation the caller quotes must be the tab's current one, and the ref
   * must have been minted by the snapshot of that generation. Both refuse
   * before any input is dispatched.
   */
  async act(request: TabActRequest, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (request.generation !== this.#generation || this.#snapshotGeneration !== this.#generation) {
      throw new BrowserRefusal(
        "browser.stale-ref",
        `The tab is at generation ${this.#generation}, and refs from generation ${request.generation} no longer name what the page shows: take a fresh snapshot.`,
      );
    }
    switch (request.kind) {
      case "click":
        return this.#pointer(this.#resolve(request.ref), "click", signal);
      case "hover":
        return this.#pointer(this.#resolve(request.ref), "hover", signal);
      case "type": {
        const backendNodeId = this.#resolve(request.ref);
        if (request.text === undefined) {
          throw new BrowserRefusal(
            "browser.unactionable",
            "type needs text to insert into the element.",
          );
        }
        await this.#command("DOM.focus", { backendNodeId }, signal);
        await this.#command("Input.insertText", { text: request.text }, signal);
        return;
      }
      case "press":
        return this.#press(request.key ?? "", signal);
      case "select": {
        const backendNodeId = this.#resolve(request.ref);
        if (request.text === undefined) {
          throw new BrowserRefusal(
            "browser.unactionable",
            "select needs the option value or label to choose.",
          );
        }
        const resolved = (await this.#command("DOM.resolveNode", { backendNodeId }, signal)) as {
          object?: { objectId?: string };
        };
        const objectId = resolved.object?.objectId;
        if (objectId === undefined) {
          throw new BrowserRefusal(
            "browser.unknown-ref",
            "The element behind that ref is gone from the page: take a fresh snapshot.",
          );
        }
        const selected = (await this.#command(
          "Runtime.callFunctionOn",
          {
            objectId,
            functionDeclaration: SELECT_OPTION_FUNCTION,
            arguments: [{ value: request.text }],
            returnByValue: true,
          },
          signal,
        )) as { result?: { value?: unknown } };
        if (selected.result?.value !== true) {
          throw new BrowserRefusal(
            "browser.unactionable",
            "That ref is not a select element with the requested option: take a fresh snapshot and choose one it shows.",
          );
        }
        return;
      }
      case "scroll": {
        if (request.direction === undefined) {
          throw new BrowserRefusal("browser.unactionable", "scroll needs a direction: up or down.");
        }
        const { x, y } = await this.#viewportCenter(signal);
        await this.#command(
          "Input.dispatchMouseEvent",
          {
            type: "mouseWheel",
            x,
            y,
            deltaX: 0,
            deltaY: request.direction === "up" ? -500 : 500,
          },
          signal,
        );
        return;
      }
      case "wait": {
        const bounded = Math.min(Math.max(request.waitMs ?? 500, 0), this.#limits.maxWaitMs);
        await abortableDelay(bounded, signal);
        return;
      }
    }
  }

  async screenshot(
    signal?: AbortSignal,
  ): Promise<{ base64Png: string; width: number; height: number }> {
    signal?.throwIfAborted();
    const captured = (await this.#command("Page.captureScreenshot", { format: "png" }, signal)) as {
      data?: string;
    };
    if (typeof captured.data !== "string" || captured.data.length === 0) {
      throw new Error("Chromium returned no Browser Tab screenshot data");
    }
    const metrics = (await this.#command("Page.getLayoutMetrics", undefined, signal)) as {
      cssVisualViewport?: { clientWidth?: number; clientHeight?: number };
    };
    return {
      base64Png: captured.data,
      width: Math.round(metrics.cssVisualViewport?.clientWidth ?? 0),
      height: Math.round(metrics.cssVisualViewport?.clientHeight ?? 0),
    };
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

  async #pointer(
    backendNodeId: number,
    kind: "click" | "hover",
    signal?: AbortSignal,
  ): Promise<void> {
    await this.#command("DOM.scrollIntoViewIfNeeded", { backendNodeId }, signal);
    const box = (await this.#command("DOM.getBoxModel", { backendNodeId }, signal)) as {
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
      await this.#command("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }, signal);
      return;
    }
    try {
      await this.#command(
        "Input.dispatchMouseEvent",
        { type: "mousePressed", x, y, button: "left", clickCount: 1 },
        signal,
      );
    } finally {
      // The press may have reached the page and only failed to answer, so the
      // page gets its mouse-up either way and no tab is left mid-click.
      await this.#releaseHalf("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x,
        y,
        button: "left",
        clickCount: 1,
      });
    }
  }

  async #press(spec: string, signal?: AbortSignal): Promise<void> {
    const parts = spec
      .split("+")
      .map((one) => one.trim())
      .filter((one) => one !== "");
    const keyPart = parts.at(-1) ?? "";
    let modifiers = 0;
    for (const name of parts.slice(0, -1)) {
      const bit = MODIFIER_BITS[name.toLowerCase()];
      if (bit === undefined) {
        throw new BrowserRefusal(
          "browser.unactionable",
          `press does not know the modifier ${JSON.stringify(name)}.`,
        );
      }
      modifiers |= bit;
    }
    const named = NAMED_KEYS[keyPart.toLowerCase()];
    if (keyPart === "" || (named === undefined && keyPart.length !== 1)) {
      throw new BrowserRefusal(
        "browser.unactionable",
        "press needs one character or a supported key, e.g. Enter or Control+a.",
      );
    }
    const key = named ?? {
      key: keyPart,
      code: `Key${keyPart.toUpperCase()}`,
      keyCode: keyPart.toUpperCase().charCodeAt(0),
    };
    const keyUp = {
      type: "keyUp",
      modifiers,
      key: key.key,
      code: key.code,
      windowsVirtualKeyCode: key.keyCode,
    };
    try {
      await this.#command(
        "Input.dispatchKeyEvent",
        {
          type: "rawKeyDown",
          modifiers,
          key: key.key,
          code: key.code,
          windowsVirtualKeyCode: key.keyCode,
        },
        signal,
      );
      // A printable single character also produces its char event, so text
      // inputs actually receive it the way a keyboard would deliver it.
      if (named === undefined && keyPart.length === 1 && (modifiers & ~8) === 0) {
        await this.#command(
          "Input.dispatchKeyEvent",
          { type: "char", modifiers, text: keyPart, key: key.key },
          signal,
        );
      }
    } finally {
      // A key down with no key up is a key the page believes is still held —
      // modifiers latch, and every later keystroke arrives wearing them.
      await this.#releaseHalf("Input.dispatchKeyEvent", keyUp);
    }
  }

  async #viewportCenter(signal?: AbortSignal): Promise<{ x: number; y: number }> {
    const metrics = (await this.#command("Page.getLayoutMetrics", undefined, signal)) as {
      cssVisualViewport?: { clientWidth?: number; clientHeight?: number };
    };
    return {
      x: Math.round((metrics.cssVisualViewport?.clientWidth ?? 0) / 2),
      y: Math.round((metrics.cssVisualViewport?.clientHeight ?? 0) / 2),
    };
  }
}
