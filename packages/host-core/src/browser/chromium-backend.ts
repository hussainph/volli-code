/**
 * The Browser backend for a host with no window (VC-619): standalone
 * Chromium, launched by this backend and driven over a CDP pipe (VC-110: never
 * `--remote-debugging-port`). The second engine behind `BrowserBackend`;
 * desktop's `WebContentsView`s are the first.
 *
 * Policy is not here. Ownership at birth, caps, holds, console bounds,
 * pictures and traces are {@link BrowserTabRegistry}'s, shared with desktop,
 * so an agent's refs, generations and refusals do not depend on the engine.
 * This file answers the registry's abstract members with Chromium's facts:
 *
 * - **Ids stay ours.** A product tab id comes from `createId`; Chromium's
 *   target is created asynchronously behind the entry's `ready` promise, so
 *   `open` returns synchronously as the interface requires. Every engine call
 *   on a tab waits on that promise first.
 * - **Storage.** One browser context per `browserSessionPartition`: a Session's
 *   tabs share their Ticket's (or Project's) context and nobody else's. The
 *   person's own tabs use the default context. The whole profile is a private
 *   temp directory removed with the browser, so nothing persists past it.
 * - **Chrome facts** (url, title, loading, history) are tracked from events,
 *   so `liveChrome` stays synchronous. The generation bumps on main-frame
 *   navigation start, as desktop's `did-start-navigation` does.
 * - **Denied by default:** downloads (`Browser.setDownloadBehavior`) and every
 *   permission, per context, as desktop's session handlers deny them.
 * - **Page-driven navigation stays HTTP(S)-only.** Every document request and
 *   redirect hop the page makes — on its own session and every out-of-process
 *   iframe's — is checked against `isAllowedBrowserUrl` before it is sent
 *   (`Fetch`). The main frame's own non-HTTP(S) navigation is canceled
 *   synchronously in an isolated world; CDP stop/commit backstops remain for
 *   non-cancelable events. A slipped commit returns to `about:blank`. The
 *   residual — same-process `data:`/`blob:`/`srcdoc` frames, which no CDP
 *   hook refuses before they run — is in the package README.
 * - **Dialogs** nobody can answer get the safe answer, never "leave".
 * - **One shutdown** (`./chromium-launch`) however the browser ends; this
 *   backend forgets the browser's tabs and the next tab launches another.
 * - **Popups** never open: the browser attaches every new page paused, and a
 *   page with an opener is closed before it runs. Its URL becomes a product
 *   tab under the opener's provenance and caps, as desktop's window-open
 *   handler does.
 * - **Screencast** (`attachScreencast`) and the person's input
 *   (`viewerInput`) are the optional members a viewer client drives; VC-571
 *   carries them over the host protocol's binary channel and control plane.
 */
import type {
  BrowserDialogResponse,
  BrowserPendingDialog,
  BrowserScreencastMetadata,
  BrowserTabBounds,
  BrowserTabState,
  BrowserViewerInput,
  RuntimeBrowserConsoleMessage,
} from "@volli/shared";
import { BrowserRefusal } from "@volli/agent-runtime";

import {
  BROWSER_DEFAULT_BOUNDS,
  browserSessionPartition,
  isAllowedBrowserUrl,
  type BrowserLoadWaitMode,
  type BrowserTabCreateOptions,
} from "./backend";
import type { CdpTransport } from "./cdp-controller";
import {
  launchChromium,
  sweepStaleChromiumProfiles,
  type ChromiumLaunchOptions,
  type ChromiumProcess,
  type ChromiumSpawn,
} from "./chromium-launch";
import { CdpProtocolError, type CdpEvent, type CdpPipeConnection } from "./chromium-pipe";
import {
  BLOCKED_BROWSER_NAVIGATION,
  CHROMIUM_NAVIGATION_GUARD_BINDING,
  CHROMIUM_NAVIGATION_GUARD_SOURCE,
  CHROMIUM_NAVIGATION_GUARD_WORLD,
} from "./chromium-navigation-guard";
import { jpegSize } from "./jpeg-size";
import { ScreencastAttachment } from "./screencast";
import {
  BrowserTabRegistry,
  type BrowserTabChrome,
  type BrowserTabRecord,
  type BrowserTabRegistryPorts,
} from "./tab-registry";
import { hostLogger } from "../log/root";

const log = hostLogger("chromium");

/** The product's own blank start page, the one non-HTTP(S) address a product door may open. */
export const CHROMIUM_START_URL = "about:blank";
/** How long a load wait may run before it settles on the page as it stands. */
export const CHROMIUM_LOAD_TIMEOUT_MS = 10_000;
/** The grace an action gets to start a navigation before the wait gives up looking. */
export const CHROMIUM_NAVIGATION_GRACE_MS = 50;
/** Desktop's quiet window after the person touched a tab, before its camera reopens. */
export const CHROMIUM_INTERACTION_QUIET_MS = 5_000;
/** How long a created target may take to attach before its tab fails to open. */
export const CHROMIUM_ATTACH_TIMEOUT_MS = 10_000;
/**
 * How long a history (and title) re-read may take. It precedes the agent
 * controller's own bounded commands, so it carries its own bound; past it the
 * tab answers with the facts it already tracked.
 */
export const CHROMIUM_HISTORY_TIMEOUT_MS = 2_000;
/** A transcript preview is optional; a stuck compositor must not wedge a tool. */
export const CHROMIUM_PREVIEW_TIMEOUT_MS = 1_000;
/** The highest device scale factor a viewer may ask for, or a browser be launched at. */
export const CHROMIUM_MAX_SCREENCAST_SCALE = 3;
/** Previews pending per tab before optional previews fail closed. */
const PREVIEW_MAX_PENDING_CAPTURES = 2;
const PREVIEW_JPEG_QUALITY = 80;
/** Popup URLs a page announced and has not opened yet; more is a page asking without end. */
const MAX_PENDING_POPUPS = 8;
/** Dialog text kept in the console record, so a page cannot flood it through one alert. */
const DIALOG_MESSAGE_MAX_CHARS = 200;
/** Dialog text (and prompt text) a viewer is shown or may send back. */
const VIEWER_DIALOG_MESSAGE_MAX_CHARS = 4_096;
/**
 * How long a shown tab's dialog waits for the person before it gets the safe
 * answer. The page is stopped meanwhile, and so is an agent's call on it.
 */
export const CHROMIUM_DIALOG_ANSWER_TIMEOUT_MS = 60_000;

function boundedDialogText(message: string): string {
  const bounded = message.slice(0, DIALOG_MESSAGE_MAX_CHARS);
  return bounded === "" ? "" : `: ${bounded}`;
}

/**
 * The permissions every context denies, by the names `Browser.setPermission`
 * knows. Desktop's session handler denies every request; CDP has no "deny
 * everything" call, so the list is spelled out. A name this Chromium does not
 * know is not fatal, but it is logged by name (security review N7): that
 * permission falls back to the browser's own default, and someone should see.
 */
const DENIED_PERMISSIONS = [
  "geolocation",
  "notifications",
  "camera",
  "microphone",
  "midi",
  "clipboard-read",
  "clipboard-write",
  "persistent-storage",
  "background-sync",
  "background-fetch",
  "periodic-background-sync",
  "screen-wake-lock",
  "idle-detection",
  "local-fonts",
  "window-management",
  "display-capture",
  "storage-access",
  "top-level-storage-access",
  "accelerometer",
  "gyroscope",
  "magnetometer",
  "ambient-light-sensor",
  "payment-handler",
  "nfc",
  "keyboard-lock",
  "pointer-lock",
  "captured-surface-control",
  "speaker-selection",
] as const;

/** A cast's size: the viewport in CSS pixels, its scale, and the frame size that makes. */
interface CastShape {
  width: number;
  height: number;
  scale: number;
  pixelWidth: number;
  pixelHeight: number;
}

/** One tab's screencast: a serial reconfiguration worker and what is live now. */
interface CastState {
  running: boolean;
  /** A reconfiguration was asked for since the worker last looked. */
  dirty: boolean;
  /** Bumped by every round; the live cast carries the round that started it. */
  revision: number;
  /** The cast whose frames may be offered, or null while none is. */
  live: (CastShape & { revision: number }) | null;
}

function castMetadata(shape: CastShape): BrowserScreencastMetadata {
  return {
    encoding: "image/jpeg",
    width: shape.width,
    height: shape.height,
    deviceScaleFactor: shape.scale,
  };
}

/** The browser this backend launched, once it answers. */
interface ChromiumEngine {
  process: ChromiumProcess;
  connection: CdpPipeConnection;
  /** Browser context per storage partition; `undefined` is the default context. */
  contexts: Map<string, Promise<string | undefined>>;
  /**
   * Page targets the browser attached paused that no entry has claimed yet.
   * Creating a target and hearing it attach race; whichever comes second
   * completes the claim.
   */
  unclaimed: Map<string, string>;
  claims: Map<string, (sessionId: string) => void>;
  /**
   * Targets created for tabs that closed before they attached, closed at
   * once. An attach that still arrives for one is discarded, never parked.
   * Each leaves when its target is destroyed.
   */
  discarded: Set<string>;
}

/** The fixed Fetch pattern every page and frame session installs: each document request and redirect hop. */
const DOCUMENT_FETCH_PATTERNS = [
  { urlPattern: "*", resourceType: "Document", requestStage: "Request" },
];
/** Auto-attach as every page and frame session sets it: children attach paused, flattened. */
const PAUSED_AUTO_ATTACH = { autoAttach: true, waitForDebuggerOnStart: true, flatten: true };

/** One live tab's Chromium handles, once its target exists. */
interface ChromiumTarget {
  engine: ChromiumEngine;
  targetId: string;
  /** The backend's own session: chrome facts, console, policy, pictures, screencast. */
  sessionId: string;
  /** The tab's own browser window, once looked up. */
  windowId?: number;
}

interface NavigationHistory {
  currentIndex: number;
  entries: Array<{ id: number }>;
}

interface ChromiumTabEntry extends BrowserTabRecord {
  /** What the tab was opened with; a popup inherits its provenance and scope. */
  input: BrowserTabCreateOptions;
  ready: Promise<ChromiumTarget>;
  target: ChromiumTarget | null;
  /** The chrome facts {@link ChromiumBrowserBackend.liveChrome} reads. */
  chrome: { url: string; title: string; loading: boolean; history: NavigationHistory | null };
  /** Product navigations not yet answered: a startup blank-page stop cannot settle them. */
  pendingNavigations: number;
  /** Counts main-frame load starts, so a stop is matched to the load it ends. */
  loadEpoch: number;
  /** Main-frame document requests in flight, so a failure among them is the page's. */
  mainDocuments: Set<string>;
  bounds: BrowserTabBounds;
  /** When a person last sent this tab input through a viewer; see `capturePicture`. */
  lastInteractionAt: number | null;
  pictureCaptures: Map<number, Promise<string | null>>;
  /** Told whenever loading changes or the tab goes; the load wait listens here. */
  loadListeners: Set<() => void>;
  /** Viewers' screencast attachments; see {@link ChromiumBrowserBackend.attachScreencast}. */
  screencasts: Set<ScreencastAttachment>;
  /** The dialog the page waits on while a person may answer it; see `#onDialog`. */
  dialog: {
    shown: BrowserPendingDialog;
    target: ChromiumTarget;
    timer: ReturnType<typeof setTimeout>;
  } | null;
  /** The tab's one Chromium screencast, reconfigured serially; see `#reconfigureCast`. */
  cast: CastState;
  /** The latest window resize, so a cast starts only once the page is its new size. */
  viewport: Promise<unknown>;
  /** URLs from `Page.windowOpen`, waiting for the popup target they announce. */
  popups: string[];
  /** The wait for this tab's created target to attach, while it runs; a close cancels it. */
  claim: { cancel: () => void } | null;
  /**
   * Sessions onto the tab's out-of-process iframes. Each carries the same
   * document `Fetch` guard as the page, so a cross-site frame's navigations
   * and redirects are checked before they are sent.
   */
  frameSessions: Set<string>;
  closed: boolean;
}

/** What the Chromium backend asks its host for. The registry's ports, nothing more. */
export type ChromiumBrowserBackendPorts = BrowserTabRegistryPorts;

/** How this host runs Chromium. Policy: every field is the host's to state. */
export interface ChromiumBrowserBackendOptions extends ChromiumLaunchOptions {
  /** JPEG quality of screencast frames, 1-100. */
  screencastQuality: number;
  /** A test seam for the launch. Production passes none. */
  spawn?: ChromiumSpawn;
}

function stringParam(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  return typeof value === "string" ? value : undefined;
}

/** Desktop's level mapping, from Chromium's console vocabulary. */
function consoleLevel(type: string): RuntimeBrowserConsoleMessage["level"] {
  switch (type) {
    case "error":
    case "assert":
      return "error";
    case "warning":
    case "warn":
      return "warn";
    case "verbose":
    case "debug":
      return "debug";
    default:
      return "info";
  }
}

/** One console argument as the page's console would print it, without asking the page. */
function remoteObjectText(arg: unknown): string {
  if (typeof arg !== "object" || arg === null) return String(arg);
  const object = arg as {
    type?: string;
    value?: unknown;
    unserializableValue?: string;
    description?: string;
  };
  if (object.unserializableValue !== undefined) return object.unserializableValue;
  if (object.type === "string" && typeof object.value === "string") return object.value;
  if (object.value !== undefined) return JSON.stringify(object.value) ?? String(object.value);
  if (object.type === "undefined") return "undefined";
  return object.description ?? object.type ?? "";
}

/** Chromium's net error, in desktop's `errorDescription` spelling. */
function netError(errorText: string): string {
  return errorText.replace(/^net::/, "");
}

/** A superseded load and our own policy refusal are not the page failing. */
function isQuietLoadError(errorText: string): boolean {
  const code = netError(errorText);
  return code === "ERR_ABORTED" || code === "ERR_BLOCKED_BY_CLIENT";
}

export type ChromiumDialogType = "alert" | "confirm" | "prompt" | "beforeunload";

function chromiumDialogType(type: string | undefined): ChromiumDialogType {
  return type === "confirm" || type === "prompt" || type === "beforeunload" ? type : "alert";
}

/**
 * The answer a dialog gets when nobody can give one: acknowledge an alert,
 * decline every question, and never approve leaving a page.
 */
export function dialogFallback(type: ChromiumDialogType): { accept: boolean; said: string } {
  switch (type) {
    case "alert":
      return { accept: true, said: "acknowledged it" };
    case "confirm":
      return { accept: false, said: "declined it (confirm returned false)" };
    case "prompt":
      return { accept: false, said: "declined it (prompt returned null)" };
    case "beforeunload":
      return { accept: false, said: "declined it and stayed on the page" };
  }
}

/** The button a drag carries, from the DOM `buttons` bitmask: left, then right, then middle. */
function heldButton(buttons: number): "none" | "left" | "middle" | "right" {
  if (buttons & 1) return "left";
  if (buttons & 2) return "right";
  if (buttons & 4) return "middle";
  return "none";
}

function noop(): void {}

function closedFirst(): Error {
  return new Error("The Browser Tab closed before its page existed");
}

/** Whether a product door (an address bar, an agent's navigate) may open the target. */
export function isAllowedChromiumTarget(target: string): boolean {
  return target === CHROMIUM_START_URL || isAllowedBrowserUrl(target);
}

/**
 * Standalone Chromium as a {@link BrowserTabRegistry} backend. Launches its
 * browser on the first tab and keeps it until {@link dispose}; a browser that
 * exits on its own takes its tabs with it, and the next tab launches another.
 */
export class ChromiumBrowserBackend extends BrowserTabRegistry<
  ChromiumTabEntry,
  ChromiumBrowserBackendPorts
> {
  #engine: Promise<ChromiumEngine> | null = null;
  /** The engine {@link #engine} resolved to, while it is live. */
  #live: ChromiumEngine | null = null;
  /** Shutdowns of browsers already gone or going, which dispose waits for. */
  readonly #retiring = new Set<Promise<void>>();
  readonly #bySession = new Map<string, ChromiumTabEntry>();
  /** Out-of-process iframe sessions, to the tab whose page they are in. */
  readonly #byFrameSession = new Map<string, ChromiumTabEntry>();
  readonly #byTarget = new Map<string, ChromiumTabEntry>();
  #disposed = false;
  #dialogCount = 0;
  /** Stale profiles of a host that died without closing its browser, removed before the first launch. */
  readonly #swept: Promise<unknown>;

  constructor(
    ports: ChromiumBrowserBackendPorts,
    private readonly options: ChromiumBrowserBackendOptions,
  ) {
    super(ports);
    const scale = options.deviceScaleFactor;
    if (!Number.isFinite(scale) || scale < 1 || scale > CHROMIUM_MAX_SCREENCAST_SCALE) {
      throw new RangeError(
        `The browser's device scale factor is between 1 and ${CHROMIUM_MAX_SCREENCAST_SCALE}`,
      );
    }
    this.#swept = sweepStaleChromiumProfiles(options.profileRoot).catch(() => []);
  }

  // ---- the engine ----------------------------------------------------------

  #requireEngine(): Promise<ChromiumEngine> {
    if (this.#disposed) return Promise.reject(new Error("The Chromium backend was disposed"));
    if (this.#engine !== null) return this.#engine;
    const starting = this.#launch();
    this.#engine = starting;
    void starting.then(
      (engine) => {
        // Unless it is already gone: then the next tab launches another.
        if (this.#engine === starting && !engine.connection.closed) this.#live = engine;
        else if (this.#engine === starting) this.#engine = null;
      },
      () => undefined,
    );
    // A launch that failed is not cached: the next tab tries again.
    starting.catch(() => {
      if (this.#engine === starting) this.#engine = null;
    });
    return starting;
  }

  async #launch(): Promise<ChromiumEngine> {
    await this.#swept;
    const process = await launchChromium(this.options, this.options.spawn);
    const engine: ChromiumEngine = {
      process,
      connection: process.connection,
      contexts: new Map(),
      unclaimed: new Map(),
      claims: new Map(),
      discarded: new Set(),
    };
    engine.connection.onEvent((event) => this.#onEvent(engine, event));
    process.onExit((description) => this.#engineGone(engine, description));
    try {
      // Every new page attaches paused, so a popup can be closed before it
      // runs and our own targets are configured before their first request.
      await engine.connection.send("Target.setDiscoverTargets", { discover: true });
      await engine.connection.send("Target.setAutoAttach", PAUSED_AUTO_ATTACH);
      // The page the browser started with is nobody's tab (security review
      // N2): close it rather than park it for the browser's lifetime. A
      // headless browser outlives its last page.
      const { targetInfos } = (await engine.connection.send("Target.getTargets")) as {
        targetInfos: Array<{ targetId: string; type: string }>;
      };
      for (const info of targetInfos) {
        if (info.type !== "page") continue;
        engine.unclaimed.delete(info.targetId);
        await engine.connection
          .send("Target.closeTarget", { targetId: info.targetId })
          .catch(() => undefined);
      }
      if (this.#disposed) throw new Error("The Chromium backend was disposed");
    } catch (error) {
      await process.close();
      throw error;
    }
    return engine;
  }

  /**
   * The browser is gone — it exited or crashed, or its pipe failed — and the
   * launch's shutdown is already ending its processes and profile. Every tab
   * it held is gone, as a crashed WebContents is on desktop, and the next tab
   * launches a new browser.
   */
  #engineGone(engine: ChromiumEngine, description: string): void {
    // Its shutdown is under way; a dispose that follows waits for it to end.
    const retiring = engine.process.close();
    this.#retiring.add(retiring);
    void retiring.finally(() => this.#retiring.delete(retiring));
    if (this.#live === engine) {
      this.#live = null;
      this.#engine = null;
    }
    for (const [tabId, entry] of this.tabs) {
      if (entry.target?.engine !== engine) continue;
      this.recordConsole(entry, { level: "error", text: `The browser stopped: ${description}` });
      this.#forget(tabId, entry);
    }
  }

  /** The browser context for one storage partition, made and secured once. */
  #contextFor(engine: ChromiumEngine, partition: string): Promise<string | undefined> {
    let context = engine.contexts.get(partition);
    if (context === undefined) {
      context = (async () => {
        // The person's tabs use the default context; every Session scope gets
        // its own, so credentials never cross Tickets or Projects.
        const browserContextId =
          partition ===
          browserSessionPartition({ createdBy: "user", projectId: "", ticketId: null })
            ? undefined
            : (
                (await engine.connection.send("Target.createBrowserContext", {
                  disposeOnDetach: true,
                })) as { browserContextId: string }
              ).browserContextId;
        const scope = browserContextId === undefined ? {} : { browserContextId };
        await engine.connection.send("Browser.setDownloadBehavior", {
          behavior: "deny",
          ...scope,
        });
        await Promise.all(
          DENIED_PERMISSIONS.map((name) =>
            engine.connection
              .send("Browser.setPermission", { permission: { name }, setting: "denied", ...scope })
              .catch((error: unknown) => {
                // The browser refused this one name: it is the browser's
                // default now, not denied, so say which. A closed connection
                // fails the whole context elsewhere.
                if (error instanceof CdpProtocolError) {
                  log.warn("chromium did not deny a permission; it keeps the default", {
                    permission: name,
                    error,
                  });
                }
              }),
          ),
        );
        return browserContextId;
      })();
      engine.contexts.set(partition, context);
      context.catch(() => engine.contexts.delete(partition));
    }
    return context;
  }

  /**
   * Waits for the browser to attach a target we created, whichever of the two
   * came first. `cancel` ends the wait at once — its timer, its close listener
   * and its map entry — and rejects it: the tab closed first.
   */
  #claim(
    engine: ChromiumEngine,
    targetId: string,
  ): { attached: Promise<string>; cancel: () => void } {
    const ready = engine.unclaimed.get(targetId);
    if (ready !== undefined) {
      engine.unclaimed.delete(targetId);
      return { attached: Promise.resolve(ready), cancel: noop };
    }
    let cancel: () => void = noop;
    const attached = new Promise<string>((resolve, reject) => {
      let unsubscribe: (() => void) | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settle = (): void => {
        clearTimeout(timer);
        unsubscribe?.();
        if (engine.claims.get(targetId) === claim) engine.claims.delete(targetId);
      };
      const claim = (sessionId: string): void => {
        settle();
        resolve(sessionId);
      };
      engine.claims.set(targetId, claim);
      timer = setTimeout(() => {
        settle();
        reject(new Error("The browser did not attach the new tab in time"));
      }, CHROMIUM_ATTACH_TIMEOUT_MS);
      unsubscribe = engine.connection.onClose((reason) => {
        settle();
        reject(new Error(reason));
      });
      cancel = () => {
        settle();
        reject(closedFirst());
      };
    });
    return { attached, cancel };
  }

  /** Closes a target made for a tab that closed first; a late attach for it is discarded. */
  #discardTarget(engine: ChromiumEngine, targetId: string): void {
    engine.discarded.add(targetId);
    engine.unclaimed.delete(targetId);
    void engine.connection.send("Target.closeTarget", { targetId }).catch(() => undefined);
  }

  async #createTarget(entry: ChromiumTabEntry): Promise<ChromiumTarget> {
    const engine = await this.#requireEngine();
    if (entry.closed) throw closedFirst();
    const browserContextId = await this.#contextFor(engine, browserSessionPartition(entry.input));
    if (entry.closed) throw closedFirst();
    const { targetId } = (await engine.connection.send("Target.createTarget", {
      url: "about:blank",
      // Each tab its own window: a background tab of a shared window is
      // hidden, and a hidden page stops painting.
      newWindow: true,
      ...(browserContextId === undefined ? {} : { browserContextId }),
    })) as { targetId: string };
    if (entry.closed) {
      // Closed while the browser made it: nobody will claim it.
      this.#discardTarget(engine, targetId);
      throw closedFirst();
    }
    // From here a close cancels the claim and closes the target at once,
    // rather than leave both waiting on an attach nobody wants.
    const claim = this.#claim(engine, targetId);
    entry.claim = {
      cancel: () => {
        claim.cancel();
        this.#discardTarget(engine, targetId);
      },
    };
    let sessionId: string;
    try {
      sessionId = await claim.attached;
    } catch (error) {
      if (!entry.closed) this.#discardTarget(engine, targetId);
      throw error;
    } finally {
      entry.claim = null;
    }
    const target: ChromiumTarget = { engine, targetId, sessionId };
    if (entry.closed) {
      await engine.connection.send("Target.closeTarget", { targetId }).catch(() => undefined);
      throw closedFirst();
    }
    entry.target = target;
    this.#bySession.set(sessionId, entry);
    this.#byTarget.set(targetId, entry);
    const send = (method: string, params: object = {}): Promise<unknown> =>
      engine.connection.send(method, params, sessionId);
    try {
      await this.#initializeTarget(entry, target, send);
    } catch (error) {
      // A page that could not be set up (its guard above all) never runs:
      // close it now, since `close` waits on a ready that will not come.
      if (entry.target === target) entry.target = null;
      this.#bySession.delete(sessionId);
      this.#byTarget.delete(targetId);
      for (const frame of entry.frameSessions) this.#byFrameSession.delete(frame);
      entry.frameSessions.clear();
      void engine.connection.send("Target.closeTarget", { targetId }).catch(() => undefined);
      throw error;
    }
    return target;
  }

  /** Enables the tab's domains and its document guard, sizes it, then lets it run. */
  async #initializeTarget(
    entry: ChromiumTabEntry,
    target: ChromiumTarget,
    send: (method: string, params?: object) => Promise<unknown>,
  ): Promise<void> {
    await Promise.all([
      send("Page.enable"),
      send("Runtime.enable"),
      send("Log.enable"),
      // Main-frame load failures are read off the network log; bodies are never kept.
      send("Network.enable", { maxTotalBufferSize: 1_024, maxResourceBufferSize: 1_024 }),
      send("Fetch.enable", { patterns: DOCUMENT_FETCH_PATTERNS }),
      send("Emulation.setFocusEmulationEnabled", { enabled: true }),
    ]);
    // Out-of-process iframes and workers attach to the page's session,
    // paused, so a frame gets the page's document guard before it runs.
    await send("Target.setAutoAttach", PAUSED_AUTO_ATTACH);
    // A renderer-local cancellation cannot lose a blob commit to the CDP
    // round trip. Its one static notice is scoped to the isolated world,
    // never a page-visible host API. A failed install never lets the page run.
    await send("Runtime.addBinding", {
      name: CHROMIUM_NAVIGATION_GUARD_BINDING,
      executionContextName: CHROMIUM_NAVIGATION_GUARD_WORLD,
    });
    await send("Page.addScriptToEvaluateOnNewDocument", {
      source: CHROMIUM_NAVIGATION_GUARD_SOURCE,
      worldName: CHROMIUM_NAVIGATION_GUARD_WORLD,
      runImmediately: true,
    });
    await this.#applyViewport(target, entry.bounds);
    await send("Runtime.runIfWaitingForDebugger");
  }

  /**
   * Sizes the tab's own window so its page is exactly `bounds`. The window,
   * not an emulated viewport: new headless still lays a browser frame around
   * the page, and what is drawn (a screencast, a capture) is what that
   * window shows, so an emulated viewport taller than it would be cropped.
   */
  async #applyViewport(target: ChromiumTarget, bounds: BrowserTabBounds): Promise<void> {
    const { connection } = target.engine;
    target.windowId ??= (
      (await connection.send("Browser.getWindowForTarget", { targetId: target.targetId })) as {
        windowId: number;
      }
    ).windowId;
    await connection.send("Browser.setContentsSize", {
      windowId: target.windowId,
      width: bounds.width,
      height: bounds.height,
    });
  }

  /** Runs one engine call on a tab once its target exists. Failures are logged, never thrown. */
  #whenReady(
    entry: ChromiumTabEntry,
    label: string,
    step: (target: ChromiumTarget) => Promise<unknown>,
  ): Promise<void> {
    return entry.ready
      .then(async (target) => {
        await step(target);
      })
      .catch((error: unknown) => {
        if (entry.closed) return;
        log.warn("browser tab step failed", { tabId: entry.state.tabId, step: label, error });
      });
  }

  // ---- events --------------------------------------------------------------

  #onEvent(engine: ChromiumEngine, event: CdpEvent): void {
    if (event.sessionId === undefined) {
      this.#onBrowserEvent(engine, event);
      return;
    }
    const entry = this.#bySession.get(event.sessionId);
    if (entry !== undefined && entry.target?.sessionId === event.sessionId) {
      this.#onTabEvent(entry, entry.target, event);
      return;
    }
    const framed = this.#byFrameSession.get(event.sessionId);
    if (framed?.target != null) this.#onFrameEvent(framed, framed.target, event);
  }

  /**
   * A child of a tab's page or of one of its frames attached, paused. An
   * out-of-process iframe gets the page's document guard (and attaches its
   * own children the same way) before it is let run; if the guard cannot be
   * installed, the frame stays paused rather than run unguarded. Workers run
   * and are let go: they navigate nothing.
   */
  #onChildAttached(
    entry: ChromiumTabEntry,
    target: ChromiumTarget,
    params: Record<string, unknown>,
  ): void {
    const { connection } = target.engine;
    const sessionId = stringParam(params, "sessionId");
    const info = params["targetInfo"] as { type?: string } | undefined;
    if (sessionId === undefined) return;
    if (info?.type !== "iframe") {
      void connection
        .send("Runtime.runIfWaitingForDebugger", {}, sessionId)
        .then(() => connection.send("Target.detachFromTarget", { sessionId }))
        .catch(() => undefined);
      return;
    }
    entry.frameSessions.add(sessionId);
    this.#byFrameSession.set(sessionId, entry);
    void (async () => {
      try {
        await connection.send("Fetch.enable", { patterns: DOCUMENT_FETCH_PATTERNS }, sessionId);
        await connection.send("Target.setAutoAttach", PAUSED_AUTO_ATTACH, sessionId);
      } catch (error) {
        if (!entry.closed && !connection.closed) {
          log.warn("browser tab kept a frame paused: navigation guard not installed", {
            tabId: entry.state.tabId,
            error,
          });
        }
        return;
      }
      await connection
        .send("Runtime.runIfWaitingForDebugger", {}, sessionId)
        .catch(() => undefined);
    })();
  }

  #onChildDetached(entry: ChromiumTabEntry, params: Record<string, unknown>): void {
    const sessionId = stringParam(params, "sessionId");
    if (sessionId === undefined || !entry.frameSessions.delete(sessionId)) return;
    this.#byFrameSession.delete(sessionId);
  }

  /** An out-of-process iframe's own events: its guard, and its children. */
  #onFrameEvent(entry: ChromiumTabEntry, target: ChromiumTarget, event: CdpEvent): void {
    switch (event.method) {
      case "Fetch.requestPaused":
        this.#guardDocument(target, event);
        return;
      case "Target.attachedToTarget":
        this.#onChildAttached(entry, target, event.params);
        return;
      case "Target.detachedFromTarget":
        this.#onChildDetached(entry, event.params);
        return;
    }
  }

  /**
   * Every document request and redirect hop a page or frame makes, before it
   * is sent: HTTP(S) continues, anything else fails as blocked. Answered on
   * the session that paused it.
   */
  #guardDocument(target: ChromiumTarget, event: CdpEvent): void {
    const request = event.params["request"] as { url?: string } | undefined;
    const requestId = stringParam(event.params, "requestId");
    if (requestId === undefined) return;
    const allowed = typeof request?.url === "string" && isAllowedBrowserUrl(request.url);
    void (
      allowed
        ? target.engine.connection.send("Fetch.continueRequest", { requestId }, event.sessionId)
        : target.engine.connection.send(
            "Fetch.failRequest",
            { requestId, errorReason: "BlockedByClient" },
            event.sessionId,
          )
    ).catch(() => undefined);
  }

  #onBrowserEvent(engine: ChromiumEngine, event: CdpEvent): void {
    const { params } = event;
    switch (event.method) {
      case "Target.attachedToTarget": {
        const sessionId = stringParam(params, "sessionId");
        const info = params["targetInfo"] as
          | { targetId: string; type: string; openerId?: string }
          | undefined;
        if (sessionId === undefined || info === undefined) return;
        // A second session onto a tab we already drive (an agent controller's).
        if (this.#byTarget.has(info.targetId)) return;
        if (info.type === "page" && info.openerId !== undefined) {
          this.#onPopup(engine, info.targetId, info.openerId);
          return;
        }
        if (info.type === "page" && engine.discarded.has(info.targetId)) {
          // Its tab closed while it was being made; it is already closing.
          void engine.connection
            .send("Target.closeTarget", { targetId: info.targetId })
            .catch(() => undefined);
          return;
        }
        if (info.type === "page") {
          const claim = engine.claims.get(info.targetId);
          engine.claims.delete(info.targetId);
          if (claim !== undefined) claim(sessionId);
          else engine.unclaimed.set(info.targetId, sessionId);
          return;
        }
        // Workers and the browser's own UI: let them run, and let go of them.
        void engine.connection
          .send("Runtime.runIfWaitingForDebugger", {}, sessionId)
          .then(() => engine.connection.send("Target.detachFromTarget", { sessionId }))
          .catch(() => undefined);
        return;
      }
      case "Target.targetInfoChanged": {
        const info = params["targetInfo"] as { targetId: string; title?: string } | undefined;
        const entry = info === undefined ? undefined : this.#byTarget.get(info.targetId);
        if (entry === undefined || typeof info?.title !== "string") return;
        if (entry.chrome.title === info.title) return;
        entry.chrome.title = info.title;
        this.publish(entry);
        return;
      }
      case "Target.targetCrashed": {
        const entry = this.#byTarget.get(stringParam(params, "targetId") ?? "");
        if (entry === undefined) return;
        const reason = stringParam(params, "status") ?? "crashed";
        this.recordConsole(entry, {
          level: "error",
          text: `Browser Tab renderer stopped: ${reason}`,
        });
        entry.chrome.loading = false;
        this.publish(entry, {
          error: `The page stopped responding and its renderer exited (${reason}).`,
          loading: false,
        });
        this.#notifyLoad(entry);
        return;
      }
      case "Target.targetDestroyed": {
        const targetId = stringParam(params, "targetId") ?? "";
        engine.unclaimed.delete(targetId);
        engine.discarded.delete(targetId);
        const entry = this.#byTarget.get(targetId);
        if (entry !== undefined && !entry.closed) this.#forget(entry.state.tabId, entry);
        return;
      }
    }
  }

  /**
   * A page opened a window. The popup never runs: it was attached paused and
   * is closed here. Its URL, which the opener announced in `Page.windowOpen`,
   * becomes a product tab under the opener's provenance and caps — exactly
   * desktop's window-open handler, which opens the tab itself and denies the
   * window.
   */
  #onPopup(engine: ChromiumEngine, targetId: string, openerId: string): void {
    void engine.connection.send("Target.closeTarget", { targetId }).catch(() => undefined);
    const opener = this.#byTarget.get(openerId);
    if (opener === undefined || opener.closed) return;
    const url = opener.popups.shift();
    if (url !== undefined && isAllowedBrowserUrl(url) && this.hasCapacity(opener.input)) {
      this.open({ ...opener.input, url });
    }
  }

  #onTabEvent(entry: ChromiumTabEntry, target: ChromiumTarget, event: CdpEvent): void {
    const { params } = event;
    const send = (method: string, body: object = {}): Promise<unknown> =>
      target.engine.connection.send(method, body, target.sessionId);
    const isMain = (frameId: unknown): boolean => frameId === target.targetId;
    switch (event.method) {
      case "Target.attachedToTarget":
        this.#onChildAttached(entry, target, params);
        return;
      case "Target.detachedFromTarget":
        this.#onChildDetached(entry, params);
        return;
      case "Page.frameRequestedNavigation": {
        // Best-effort stop for what the isolated-world listener could not
        // cancel. This notification is not an interception: a blob can
        // commit before Chromium receives our command. Keep the commit
        // backstop below; cancelable self-navigation is refused in-renderer.
        const url = stringParam(params, "url");
        if (!isMain(params["frameId"]) || url === undefined || this.#mayCommit(url)) return;
        this.recordConsole(entry, {
          level: "error",
          text: BLOCKED_BROWSER_NAVIGATION,
        });
        void send("Page.stopLoading").catch(() => undefined);
        return;
      }
      case "Page.frameStartedNavigating":
        if (!isMain(params["frameId"])) return;
        // A popup announced by the page it is leaving is not this page's (N11).
        entry.popups.length = 0;
        // Desktop's `did-start-navigation`: the generation a ref is judged by moves now.
        this.publish(entry, {
          error: null,
          generation: entry.state.generation + 1,
          ...(typeof params["url"] === "string" ? { url: params["url"] } : {}),
        });
        return;
      case "Page.frameStartedLoading":
        if (!isMain(params["frameId"])) return;
        entry.loadEpoch += 1;
        entry.chrome.loading = true;
        this.publish(entry, { loading: true });
        this.#notifyLoad(entry);
        return;
      case "Page.frameStoppedLoading":
        if (!isMain(params["frameId"])) return;
        // History first, so a load wait settles on the page's own title and
        // history rather than on whatever the target last reported.
        const epoch = entry.loadEpoch;
        void this.#refreshHistory(entry, target).then(() => {
          // A load that started meanwhile is not the one that stopped.
          if (entry.closed || entry.loadEpoch !== epoch) return;
          entry.chrome.loading = false;
          this.publish(entry);
          this.#notifyLoad(entry);
        });
        return;
      case "Page.frameNavigated": {
        const frame = params["frame"] as
          | {
              id: string;
              parentId?: string;
              url: string;
              urlFragment?: string;
              unreachableUrl?: string;
            }
          | undefined;
        if (frame === undefined || frame.parentId !== undefined || !isMain(frame.id)) return;
        const url = frame.unreachableUrl ?? `${frame.url}${frame.urlFragment ?? ""}`;
        if (frame.unreachableUrl === undefined && !this.#mayCommit(url)) {
          // Chromium already refuses file:, chrome: and top-level data:; this
          // catches what reached the main frame anyway (a page's own blob:).
          this.recordConsole(entry, {
            level: "error",
            text: BLOCKED_BROWSER_NAVIGATION,
          });
          void send("Page.navigate", { url: CHROMIUM_START_URL }).catch(() => undefined);
          return;
        }
        entry.chrome.url = url;
        this.publish(entry, { url });
        void this.#refreshHistory(entry, target);
        return;
      }
      case "Page.navigatedWithinDocument": {
        if (!isMain(params["frameId"]) || typeof params["url"] !== "string") return;
        entry.chrome.url = params["url"];
        this.publish(entry, { url: params["url"] });
        void this.#refreshHistory(entry, target);
        return;
      }
      case "Page.windowOpen": {
        const url = stringParam(params, "url");
        if (url !== undefined && entry.popups.length < MAX_PENDING_POPUPS) entry.popups.push(url);
        return;
      }
      case "Page.javascriptDialogOpening":
        this.#onDialog(entry, target, params);
        return;
      case "Page.javascriptDialogClosed":
        // Answered (by us) or dismissed by the page's own departure: either
        // way no viewer should still offer it.
        this.#clearDialog(entry);
        return;
      case "Fetch.requestPaused":
        this.#guardDocument(target, event);
        return;
      case "Network.requestWillBeSent":
        if (params["type"] === "Document" && isMain(params["frameId"])) {
          const requestId = stringParam(params, "requestId");
          if (requestId !== undefined) entry.mainDocuments.add(requestId);
        }
        return;
      case "Network.loadingFinished":
        entry.mainDocuments.delete(stringParam(params, "requestId") ?? "");
        return;
      case "Network.loadingFailed": {
        const requestId = stringParam(params, "requestId") ?? "";
        if (!entry.mainDocuments.delete(requestId)) return;
        const errorText = stringParam(params, "errorText") ?? "";
        if (params["canceled"] === true || isQuietLoadError(errorText)) return;
        this.#failLoad(entry, errorText);
        return;
      }
      case "Runtime.bindingCalled":
        if (
          params["name"] !== CHROMIUM_NAVIGATION_GUARD_BINDING ||
          params["payload"] !== BLOCKED_BROWSER_NAVIGATION
        )
          return;
        this.recordConsole(entry, { level: "error", text: BLOCKED_BROWSER_NAVIGATION });
        return;
      case "Runtime.consoleAPICalled": {
        const args = Array.isArray(params["args"]) ? (params["args"] as unknown[]) : [];
        this.recordConsole(entry, {
          level: consoleLevel(stringParam(params, "type") ?? "log"),
          text: args.map(remoteObjectText).join(" "),
        });
        return;
      }
      case "Runtime.exceptionThrown": {
        const details = params["exceptionDetails"] as
          | { text?: string; exception?: { description?: string } }
          | undefined;
        const description = details?.exception?.description?.split("\n")[0];
        this.recordConsole(entry, {
          level: "error",
          text: [details?.text, description].filter((part) => part !== undefined).join(" "),
        });
        return;
      }
      case "Log.entryAdded": {
        const logged = params["entry"] as { level?: string; text?: string } | undefined;
        if (typeof logged?.text !== "string") return;
        this.recordConsole(entry, {
          level: consoleLevel(logged.level ?? "info"),
          text: logged.text,
        });
        return;
      }
      case "Page.screencastFrame":
        this.#onFrame(entry, target, params);
        return;
    }
  }

  /**
   * A page opened a dialog, and an open dialog stops the page. On a tab
   * nobody is looking at, nobody can answer it, so the safe answer is given
   * at once and said aloud (console, and the tab's error for a refused
   * departure, which every agent answer carries):
   *
   * - an alert is acknowledged; a confirm or prompt is declined (`false`, `null`);
   * - a leave-page prompt (`beforeunload`) is declined: the tab STAYS, as
   *   desktop's does when nothing handles `will-prevent-unload`. Volli never
   *   approves leaving a page on anyone's behalf, so unsaved work a page
   *   guards is never discarded by a fallback. An agent that must leave
   *   closes the tab (closing runs no unload veto) or opens another.
   */
  #onDialog(
    entry: ChromiumTabEntry,
    target: ChromiumTarget,
    params: Record<string, unknown>,
  ): void {
    const type = chromiumDialogType(stringParam(params, "type"));
    const message = stringParam(params, "message") ?? "";
    if (entry.dialog !== null) this.#clearDialog(entry);
    if (!this.#someoneIsLooking(entry)) {
      this.#answerDialog(entry, target, type, message, null);
      return;
    }
    // A person is looking: the viewer shows the dialog and the person answers
    // it (`respondToDialog`). Nobody answering in time gets the safe answer.
    this.#dialogCount += 1;
    const dialog: BrowserPendingDialog = {
      dialogId: `${entry.state.tabId}:dialog-${this.#dialogCount}`,
      type,
      message: message.slice(0, VIEWER_DIALOG_MESSAGE_MAX_CHARS),
      defaultPrompt: (stringParam(params, "defaultPrompt") ?? "").slice(
        0,
        VIEWER_DIALOG_MESSAGE_MAX_CHARS,
      ),
    };
    const timer = setTimeout(() => {
      if (entry.dialog?.shown.dialogId !== dialog.dialogId) return;
      this.#clearDialog(entry);
      this.#answerDialog(entry, target, type, message, null, "nobody answered in time");
    }, CHROMIUM_DIALOG_ANSWER_TIMEOUT_MS);
    timer.unref?.();
    entry.dialog = { shown: dialog, target, timer };
    this.recordConsole(entry, {
      level: "info",
      text: `The page opened a ${type} dialog; waiting for the person to answer it${boundedDialogText(message)}`,
    });
    for (const attachment of entry.screencasts) attachment.setDialog(dialog);
  }

  /** Whether a person could answer a dialog on this tab now: it is shown, and a viewer is attached. */
  #someoneIsLooking(entry: ChromiumTabEntry): boolean {
    return entry.state.presentation !== "headless" && entry.screencasts.size > 0;
  }

  /**
   * Answers the page's dialog: with the person's response, or (`response`
   * null) with the safe fallback, said aloud — console, and for a refused
   * departure the tab's error, which every agent answer carries.
   */
  #answerDialog(
    entry: ChromiumTabEntry,
    target: ChromiumTarget,
    type: ChromiumDialogType,
    message: string,
    response: BrowserDialogResponse | null,
    why = "nobody could answer",
  ): void {
    if (response === null) {
      const outcome = dialogFallback(type);
      this.recordConsole(entry, {
        level: "warn",
        text: `The page opened a ${type} dialog ${why}; Volli ${outcome.said}${boundedDialogText(message)}`,
      });
      if (type === "beforeunload") {
        this.publish(entry, {
          error: "The page asked to confirm leaving it; Volli stayed on the page.",
        });
      }
      response = { accept: outcome.accept };
    } else {
      this.recordConsole(entry, {
        level: "info",
        text: `The person ${response.accept ? "accepted" : "declined"} the page's ${type} dialog`,
      });
    }
    void target.engine.connection
      .send(
        "Page.handleJavaScriptDialog",
        {
          accept: response.accept,
          ...(response.promptText === undefined ? {} : { promptText: response.promptText }),
        },
        target.sessionId,
      )
      .catch(() => undefined);
  }

  /** Forgets the pending dialog and tells the viewers it is gone. */
  #clearDialog(entry: ChromiumTabEntry): void {
    const pending = entry.dialog;
    if (pending === null) return;
    clearTimeout(pending.timer);
    entry.dialog = null;
    for (const attachment of entry.screencasts) attachment.setDialog(null);
  }

  /** The last viewer left (or the tab went headless) with a dialog open: nobody can answer it now. */
  #nobodyLeftToAnswer(entry: ChromiumTabEntry): void {
    const pending = entry.dialog;
    if (pending === null || this.#someoneIsLooking(entry)) return;
    this.#clearDialog(entry);
    if (entry.closed) return;
    this.#answerDialog(
      entry,
      pending.target,
      pending.shown.type,
      pending.shown.message,
      null,
      "nobody was left to answer",
    );
  }

  /** The dialog a shown tab's page is waiting on, for a viewer to render; null when none is. */
  pendingDialog(tabId: string): BrowserPendingDialog | null {
    const pending = this.requireTab(tabId).dialog;
    return pending === null ? null : { ...pending.shown };
  }

  /**
   * The person's answer to the dialog `dialogId`. False when that dialog is
   * no longer the one waiting (answered, timed out, closed by the page):
   * nothing is sent then. Leaving a page is the person's to approve here.
   */
  respondToDialog(tabId: string, dialogId: string, response: BrowserDialogResponse): boolean {
    const entry = this.requireTab(tabId);
    const pending = entry.dialog;
    if (pending === null || pending.shown.dialogId !== dialogId) return false;
    this.#clearDialog(entry);
    this.#answerDialog(entry, pending.target, pending.shown.type, pending.shown.message, {
      accept: response.accept,
      ...(response.promptText === undefined
        ? {}
        : { promptText: response.promptText.slice(0, VIEWER_DIALOG_MESSAGE_MAX_CHARS) }),
    });
    return true;
  }

  /** What a main frame may come to rest on: HTTP(S), the blank page, or Chromium's error page. */
  #mayCommit(url: string): boolean {
    return (
      isAllowedBrowserUrl(url) || url === CHROMIUM_START_URL || url.startsWith("chrome-error://")
    );
  }

  /** A main-frame load failed: desktop's `did-fail-load`, worded the same. */
  #failLoad(entry: ChromiumTabEntry, errorText: string): void {
    const message = `Could not load page: ${netError(errorText)}`;
    if (entry.state.error === message) return;
    this.recordConsole(entry, { level: "error", text: message });
    entry.chrome.loading = false;
    this.publish(entry, { error: message, loading: false });
    this.#notifyLoad(entry);
  }

  /**
   * Re-reads history, and the title it carries for the current entry —
   * empty included: a page that cleared its title has no title. Bounded by
   * {@link CHROMIUM_HISTORY_TIMEOUT_MS} and by `signal`; an abandoned read
   * leaves the pipe's pending map at once. Never rejects.
   */
  #refreshHistory(
    entry: ChromiumTabEntry,
    target: ChromiumTarget,
    signal?: AbortSignal,
  ): Promise<void> {
    return target.engine.connection
      .send("Page.getNavigationHistory", {}, target.sessionId, {
        timeoutMs: CHROMIUM_HISTORY_TIMEOUT_MS,
        ...(signal === undefined ? {} : { signal }),
      })
      .then((answer) => {
        if (entry.closed) return;
        const history = answer as NavigationHistory & { entries: Array<{ title?: string }> };
        entry.chrome.history = history;
        const title = history.entries[history.currentIndex]?.title;
        if (typeof title === "string") entry.chrome.title = title;
        this.publish(entry);
      })
      .catch(() => undefined);
  }

  #notifyLoad(entry: ChromiumTabEntry): void {
    for (const listener of entry.loadListeners) listener();
  }

  // ---- the registry's engine members ---------------------------------------

  protected liveChrome(entry: ChromiumTabEntry): BrowserTabChrome {
    const history = entry.chrome.history;
    return {
      url: entry.chrome.url,
      title: entry.chrome.title,
      loading: entry.chrome.loading || (entry.pendingNavigations > 0 && entry.state.error === null),
      canGoBack: history !== null && history.currentIndex > 0,
      canGoForward: history !== null && history.currentIndex < history.entries.length - 1,
    };
  }

  /**
   * Nothing to toggle. Every tab is its own window, a headless window is never
   * occluded, and the launch turns background timer throttling and renderer
   * backgrounding off, so every tab already runs at foreground pace whether or
   * not an agent holds it (VC-252's concern is desktop's detached views).
   */
  protected applyWakePolicy(): void {}

  /**
   * Nothing is on a screen here. What a person could see is a viewer's
   * screencast, and a tab going headless ends those streams: a headless tab
   * is drawn nowhere until the person shows it again (VC-238).
   */
  protected goOffScreen(entry: ChromiumTabEntry): void {
    this.#endScreencasts(entry);
  }

  open(input: BrowserTabCreateOptions): BrowserTabState {
    if (!isAllowedChromiumTarget(input.url)) {
      throw new Error("Browser Tabs only support HTTP(S) URLs");
    }
    if (this.#disposed) throw new Error("The Chromium backend was disposed");
    this.assertCapacity(input);
    const tabId = this.deps.createId();
    if (this.tabs.has(tabId)) throw new Error("Duplicate Browser Tab id");
    const state = this.newTabState(tabId, input);
    const entry: ChromiumTabEntry = {
      state,
      console: [],
      consoleTruncated: false,
      wakeLeases: 0,
      hold: null,
      input,
      ready: Promise.resolve() as unknown as Promise<ChromiumTarget>,
      target: null,
      chrome: { url: input.url, title: "", loading: true, history: null },
      pendingNavigations: 0,
      loadEpoch: 0,
      mainDocuments: new Set(),
      bounds: { ...BROWSER_DEFAULT_BOUNDS },
      lastInteractionAt: null,
      pictureCaptures: new Map(),
      loadListeners: new Set(),
      screencasts: new Set(),
      dialog: null,
      cast: { running: false, dirty: false, revision: 0, live: null },
      viewport: Promise.resolve(),
      popups: [],
      claim: null,
      frameSessions: new Set(),
      closed: false,
    };
    entry.ready = this.#createTarget(entry);
    // Every waiter handles its own rejection; this one records it once.
    entry.ready.catch((error: unknown) => {
      if (entry.closed) return;
      const reason = error instanceof Error ? error.message : String(error);
      const message = `The browser could not open this tab: ${reason}`;
      this.recordConsole(entry, { level: "error", text: message });
      entry.chrome.loading = false;
      this.publish(entry, { error: message, loading: false });
      this.#notifyLoad(entry);
    });
    this.tabs.set(tabId, entry);
    this.deps.publishState({ ...state });
    this.#navigateEngine(entry, input.url);
    return { ...state };
  }

  /** Loads a URL through the product door, once the target exists. */
  #navigateEngine(entry: ChromiumTabEntry, url: string): void {
    entry.chrome.loading = true;
    // The target first loads about:blank. Its stop can arrive during setup,
    // before this command is sent; only Page.navigate's answer makes a later
    // stopped-loading state eligible to settle the requested navigation.
    entry.pendingNavigations += 1;
    void this.#whenReady(entry, "navigate", async (target) => {
      const answer = (await target.engine.connection.send(
        "Page.navigate",
        { url },
        target.sessionId,
      )) as { errorText?: string; loaderId?: string };
      if (answer.errorText !== undefined && !isQuietLoadError(answer.errorText)) {
        this.#failLoad(entry, answer.errorText);
      } else if (answer.loaderId === undefined && answer.errorText === undefined) {
        // A same-document navigation has no load of its own to stop.
        entry.chrome.loading = false;
        this.publish(entry);
        this.#notifyLoad(entry);
      }
    })
      .finally(() => {
        entry.pendingNavigations -= 1;
        if (entry.closed) return;
        this.publish(entry);
        this.#notifyLoad(entry);
      })
      .catch((error: unknown) => {
        if (!entry.closed)
          log.warn("browser tab could not publish navigation", { tabId: entry.state.tabId, error });
      });
  }

  close(tabId: string): void {
    const entry = this.requireTab(tabId);
    this.#forget(tabId, entry);
    this.#whenReady(entry, "close", (target) =>
      target.engine.connection.send("Target.closeTarget", { targetId: target.targetId }),
    );
  }

  /** Drops one tab from the registry and every index, and ends whatever waited on it. */
  #forget(tabId: string, entry: ChromiumTabEntry): void {
    entry.closed = true;
    const claim = entry.claim;
    entry.claim = null;
    claim?.cancel();
    if (entry.target !== null) {
      this.#bySession.delete(entry.target.sessionId);
      this.#byTarget.delete(entry.target.targetId);
    }
    this.#endScreencasts(entry);
    this.#clearDialog(entry);
    for (const sessionId of entry.frameSessions) this.#byFrameSession.delete(sessionId);
    entry.frameSessions.clear();
    this.#notifyLoad(entry);
    if (this.tabs.get(tabId) === entry) this.forgetEntry(tabId, entry);
  }

  navigate(tabId: string, url: string): BrowserTabState {
    if (!isAllowedChromiumTarget(url)) {
      throw new Error("Browser Tabs only support HTTP(S) URLs");
    }
    const entry = this.requireTab(tabId);
    this.beginProductNavigation(entry, url);
    this.#navigateEngine(entry, url);
    return { ...entry.state };
  }

  back(tabId: string): BrowserTabState {
    return this.#history(tabId, -1);
  }

  forward(tabId: string): BrowserTabState {
    return this.#history(tabId, 1);
  }

  /** Moves through history when the tracked history has an entry that way. */
  #history(tabId: string, step: -1 | 1): BrowserTabState {
    const entry = this.requireTab(tabId);
    const chrome = this.liveChrome(entry);
    if (step === -1 ? !chrome.canGoBack : !chrome.canGoForward) return { ...entry.state };
    this.beginProductNavigation(entry);
    entry.chrome.loading = true;
    this.#whenReady(entry, "move through history", async (target) => {
      const send = (method: string, params: object = {}): Promise<unknown> =>
        target.engine.connection.send(method, params, target.sessionId);
      // Read now rather than trust the tracked copy: a navigation may have
      // landed since it was taken.
      const history = (await target.engine.connection.send(
        "Page.getNavigationHistory",
        {},
        target.sessionId,
        { timeoutMs: CHROMIUM_HISTORY_TIMEOUT_MS },
      )) as NavigationHistory;
      const destination = history.entries[history.currentIndex + step];
      if (destination === undefined) {
        entry.chrome.loading = false;
        this.publish(entry);
        this.#notifyLoad(entry);
        return;
      }
      await send("Page.navigateToHistoryEntry", { entryId: destination.id });
    });
    return { ...entry.state };
  }

  reload(tabId: string): BrowserTabState {
    const entry = this.requireTab(tabId);
    this.beginProductNavigation(entry);
    entry.chrome.loading = true;
    this.#whenReady(entry, "reload", (target) =>
      target.engine.connection.send("Page.reload", {}, target.sessionId),
    );
    return { ...entry.state };
  }

  setBounds(tabId: string, bounds: BrowserTabBounds): void {
    const entry = this.requireTab(tabId);
    const current = entry.bounds;
    if (
      current.x === bounds.x &&
      current.y === bounds.y &&
      current.width === bounds.width &&
      current.height === bounds.height
    ) {
      return;
    }
    entry.bounds = { ...bounds };
    entry.viewport = entry.ready
      .then((target) => this.#applyViewport(target, entry.bounds))
      .catch((error: unknown) => {
        if (!entry.closed) log.warn("browser tab could not resize", { tabId, error });
      });
    if (entry.screencasts.size > 0) this.#reconfigureCast(entry);
  }

  /**
   * The tab's CDP wire for the agent controller: its own flattened session
   * onto the tab's target, attached lazily and detached on dispose, so the
   * controller's attachment is as separable from the backend's as desktop's
   * debugger is from its WebContents events.
   */
  transportFor(tabId: string): CdpTransport {
    const entry = this.requireTab(tabId);
    let sessionId: string | null = null;
    let attaching: Promise<string> | null = null;
    let disposed = false;
    let engine: ChromiumEngine | null = null;
    const assertLive = (): void => {
      if (disposed) throw new Error("The Browser Tab transport was disposed");
    };
    const attach = async (): Promise<string> => {
      let target: ChromiumTarget;
      try {
        target = await entry.ready;
        engine = target.engine;
        const live = engine;
        const attached = (await live.connection.send("Target.attachToTarget", {
          targetId: target.targetId,
          flatten: true,
        })) as { sessionId: string };
        const detach = (): void => {
          void live.connection
            .send("Target.detachFromTarget", { sessionId: attached.sessionId })
            .catch(() => undefined);
        };
        // Disposed while the attach was on the wire: its answer is a session
        // nobody will use, so it goes at once.
        if (disposed) {
          detach();
          assertLive();
        }
        sessionId = attached.sessionId;
        try {
          for (const method of ["Accessibility.enable", "DOM.enable", "Page.enable"]) {
            await live.connection.send(method, {}, attached.sessionId);
          }
        } catch (error) {
          // Half-made: let go of it, rather than keep a session nobody drives.
          if (sessionId === attached.sessionId) {
            sessionId = null;
            detach();
          }
          throw error;
        }
        assertLive();
        return attached.sessionId;
      } catch (error) {
        assertLive();
        throw new BrowserRefusal(
          "browser.debugger-unavailable",
          `Browser control is unavailable for this tab: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    };
    const ensureReady = async (): Promise<void> => {
      assertLive();
      if (sessionId !== null && engine !== null && !engine.connection.closed) return;
      attaching ??= attach().finally(() => {
        attaching = null;
      });
      await attaching;
    };
    return {
      ensureReady,
      send: async (method, params) => {
        await ensureReady();
        assertLive();
        return await engine!.connection.send(method, params ?? {}, sessionId!);
      },
      dispose: () => {
        disposed = true;
        const live = sessionId;
        sessionId = null;
        if (live === null || engine === null || engine.connection.closed) return;
        void engine.connection
          .send("Target.detachFromTarget", { sessionId: live })
          .catch(() => undefined);
      },
    };
  }

  /**
   * Settles when the tab stops loading, at the bound, or on withdrawal —
   * desktop's `loadWaiter`, over the tracked loading state. Never rejects.
   */
  async waitForLoad(
    tabId: string,
    signal: AbortSignal,
    mode: BrowserLoadWaitMode = "current",
  ): Promise<void> {
    const entry = this.requireTab(tabId);
    await this.#settle(entry, signal, mode);
    // Chromium reports a script's title change late (its target info is
    // throttled); a read is answered with the title as it stands now —
    // within the history bound, and never past the caller's withdrawal.
    if (entry.target !== null && !entry.closed && !signal.aborted) {
      await this.#refreshHistory(entry, entry.target, signal);
    }
  }

  #settle(entry: ChromiumTabEntry, signal: AbortSignal, mode: BrowserLoadWaitMode): Promise<void> {
    const loading = this.liveChrome(entry).loading;
    if ((!loading && mode === "current") || signal.aborted) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let grace: ReturnType<typeof setTimeout> | undefined;
      let wasLoading = loading;
      const finish = (): void => {
        clearTimeout(timer);
        clearTimeout(grace);
        entry.loadListeners.delete(changed);
        signal.removeEventListener("abort", finish);
        resolve();
      };
      const changed = (): void => {
        if (entry.closed) return finish();
        if (this.liveChrome(entry).loading) {
          wasLoading = true;
          clearTimeout(grace);
        } else if (wasLoading) {
          finish();
        }
      };
      const timer = setTimeout(finish, CHROMIUM_LOAD_TIMEOUT_MS);
      entry.loadListeners.add(changed);
      signal.addEventListener("abort", finish, { once: true });
      if (!loading && mode === "possible-navigation") {
        grace = setTimeout(finish, CHROMIUM_NAVIGATION_GRACE_MS);
      }
    });
  }

  /**
   * A picture of the tab for the transcript card after an agent changed it —
   * desktop's rules: never while a person is using the tab or within the
   * quiet window after, bounded in time and in pending captures, and dropped
   * when the page moved on while it was taken.
   */
  async capturePicture(tabId: string, signal?: AbortSignal): Promise<string | null> {
    const entry = this.tabs.get(tabId);
    if (entry === undefined || signal?.aborted || entry.target === null) return null;
    if (this.#isBeingUsed(entry)) return null;
    const target = entry.target;
    const generation = entry.state.generation;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abandon: (() => void) | undefined;
    try {
      let capture = entry.pictureCaptures.get(generation);
      if (capture === undefined && entry.pictureCaptures.size >= PREVIEW_MAX_PENDING_CAPTURES) {
        return null;
      }
      if (capture === undefined) {
        const started = target.engine.connection
          .send(
            "Page.captureScreenshot",
            { format: "jpeg", quality: PREVIEW_JPEG_QUALITY },
            target.sessionId,
          )
          .then((shot) => {
            const data = (shot as { data?: unknown }).data;
            return typeof data === "string" && data.length > 0 ? data : null;
          });
        capture = started;
        entry.pictureCaptures.set(generation, started);
        const done = (): void => {
          if (entry.pictureCaptures.get(generation) === started) {
            entry.pictureCaptures.delete(generation);
          }
        };
        void started.then(done, done);
      }
      const deadline = new Promise<null>((resolve) => {
        abandon = () => resolve(null);
        signal?.addEventListener("abort", abandon, { once: true });
        timer = setTimeout(() => {
          log.warn("browser tab preview capture timed out", { tabId });
          resolve(null);
        }, CHROMIUM_PREVIEW_TIMEOUT_MS);
      });
      const data = await Promise.race([capture, deadline]);
      if (
        data === null ||
        signal?.aborted ||
        this.tabs.get(tabId) !== entry ||
        entry.state.generation !== generation ||
        this.#isBeingUsed(entry)
      ) {
        return null;
      }
      return this.deps.pictures.put({
        tabId,
        generation,
        mime: "image/jpeg",
        bytes: Buffer.from(data, "base64"),
        ownerSessionId: entry.state.ownerSessionId,
        persist: false,
      });
    } catch (error) {
      log.warn("browser tab preview capture unavailable", { tabId, error });
      return null;
    } finally {
      clearTimeout(timer);
      if (abandon !== undefined) signal?.removeEventListener("abort", abandon);
    }
  }

  #isBeingUsed(entry: ChromiumTabEntry): boolean {
    const last = entry.lastInteractionAt;
    return last !== null && this.now() - last < CHROMIUM_INTERACTION_QUIET_MS;
  }

  closeAll(): void {
    for (const tabId of this.tabs.keys()) this.close(tabId);
  }

  /** Closes every tab and the browser, and removes its profile. Idempotent. */
  async dispose(): Promise<void> {
    this.closeAll();
    this.#disposed = true;
    const engine = this.#engine;
    this.#engine = null;
    this.#live = null;
    const live = engine === null ? null : await engine.catch(() => null);
    await live?.process.close();
    await Promise.all(this.#retiring);
  }

  // ---- the viewer: screencast and the person's input -----------------------

  /**
   * A frame source for one shown tab (`./screencast`). A headless tab
   * refuses: only the person can reveal a Session's tab (VC-238), and every
   * attachment ends when its tab goes headless or closes.
   *
   * One Chromium screencast per tab, shared by its attachments. Chromium's
   * frames are acknowledged as they arrive, so it keeps drawing the newest
   * page, and each attachment keeps only the newest frame its consumer has
   * not taken (latest wins). Frames are drawn at the highest device scale
   * factor any attachment asked for, up to the browser's own
   * ({@link ChromiumLaunchOptions.deviceScaleFactor}); the metadata
   * says which.
   */
  attachScreencast(tabId: string, options: { deviceScaleFactor: number }): ScreencastAttachment {
    const entry = this.requireTab(tabId);
    if (entry.state.presentation === "headless") {
      throw new Error("A Headless Browser Tab has no view until the person shows it");
    }
    const scale = options.deviceScaleFactor;
    if (!Number.isFinite(scale) || scale < 1 || scale > CHROMIUM_MAX_SCREENCAST_SCALE) {
      throw new RangeError(
        `A screencast's device scale factor is between 1 and ${CHROMIUM_MAX_SCREENCAST_SCALE}`,
      );
    }
    // What its frames will be once the cast is (re)started for it; no frame
    // reaches it before one of exactly this shape can.
    const attachment = new ScreencastAttachment(
      castMetadata(this.#castShape(entry, Math.max(scale, this.#wantedCast(entry)?.scale ?? 1))),
      scale,
      (gone) => this.#detachScreencast(entry, gone),
    );
    entry.screencasts.add(attachment);
    if (entry.dialog !== null) attachment.setDialog(entry.dialog.shown);
    this.#reconfigureCast(entry);
    return attachment;
  }

  /** The cast this tab's attachments need now, or null when none is wanted. */
  #wantedCast(entry: ChromiumTabEntry): CastShape | null {
    if (entry.closed || entry.screencasts.size === 0 || entry.state.presentation === "headless") {
      return null;
    }
    let wanted = 1;
    for (const attachment of entry.screencasts) {
      wanted = Math.max(wanted, attachment.requestedScale);
    }
    return this.#castShape(entry, wanted);
  }

  #castShape(entry: ChromiumTabEntry, requested: number): CastShape {
    const scale = Math.min(requested, this.options.deviceScaleFactor);
    return {
      width: entry.bounds.width,
      height: entry.bounds.height,
      scale,
      pixelWidth: Math.round(entry.bounds.width * scale),
      pixelHeight: Math.round(entry.bounds.height * scale),
    };
  }

  /**
   * Asks for the tab's cast to match its attachments. Requests coalesce: one
   * worker per tab runs at a time, and a request made while it runs makes it
   * go round again with the newest wants. Each round stops the running cast
   * (from then no frame is offered: `live` is null), waits for the window's
   * latest size, and starts the cast the attachments want then — rechecking
   * after every await, so a request that arrives meanwhile (the last viewer
   * leaving, a resize, a new scale) is served by the next round, and a
   * zero-viewer stop is always the last word. Only when a start has answered
   * and nothing newer is waiting does the cast go live: its revision and
   * shape are published, every attachment hears the new metadata, and frames
   * of that shape flow again.
   */
  #reconfigureCast(entry: ChromiumTabEntry): void {
    const cast = entry.cast;
    // From this request until a cast of the new wants answers, no frame is offered.
    cast.live = null;
    cast.dirty = true;
    if (cast.running) return;
    cast.running = true;
    void (async () => {
      try {
        const target = await entry.ready;
        const send = (method: string, params: object = {}): Promise<unknown> =>
          target.engine.connection.send(method, params, target.sessionId);
        while (cast.dirty && !entry.closed) {
          cast.dirty = false;
          cast.revision += 1;
          cast.live = null;
          await send("Page.stopScreencast");
          if (cast.dirty || entry.closed) continue;
          if (this.#wantedCast(entry) === null) break;
          await entry.viewport;
          if (cast.dirty || entry.closed) continue;
          const wanted = this.#wantedCast(entry);
          if (wanted === null) break;
          await send("Page.startScreencast", {
            format: "jpeg",
            quality: this.options.screencastQuality,
            maxWidth: wanted.pixelWidth,
            maxHeight: wanted.pixelHeight,
            everyNthFrame: 1,
          });
          if (cast.dirty || entry.closed) continue;
          cast.live = { ...wanted, revision: cast.revision };
          const metadata = castMetadata(wanted);
          for (const attachment of entry.screencasts) attachment.setMetadata(metadata);
        }
      } catch (error) {
        cast.live = null;
        if (!entry.closed) {
          log.warn("browser tab screencast stopped", { tabId: entry.state.tabId, error });
        }
      } finally {
        cast.running = false;
      }
    })();
  }

  #detachScreencast(entry: ChromiumTabEntry, attachment: ScreencastAttachment): void {
    if (!entry.screencasts.delete(attachment)) return;
    this.#reconfigureCast(entry);
    this.#nobodyLeftToAnswer(entry);
  }

  /** Ends every attachment from the host's side: the tab closed or went headless. */
  #endScreencasts(entry: ChromiumTabEntry): void {
    if (entry.screencasts.size === 0) return;
    const ending = [...entry.screencasts];
    entry.screencasts.clear();
    for (const attachment of ending) attachment.end();
    this.#reconfigureCast(entry);
    this.#nobodyLeftToAnswer(entry);
  }

  /**
   * One frame of the tab's cast. Every frame is acknowledged, offered or not,
   * so Chromium keeps drawing. It is offered only to a live cast and only
   * when its real pixel size is that cast's: a frame from before a stop or a
   * resize, or drawn at another scale, is dropped, never shown under the new
   * metadata.
   */
  #onFrame(entry: ChromiumTabEntry, target: ChromiumTarget, params: Record<string, unknown>): void {
    void target.engine.connection
      .send("Page.screencastFrameAck", { sessionId: params["sessionId"] }, target.sessionId)
      .catch(() => undefined);
    const live = entry.cast.live;
    const data = stringParam(params, "data");
    if (data === undefined || live === null || entry.screencasts.size === 0) return;
    const bytes = Buffer.from(data, "base64");
    const size = jpegSize(bytes);
    if (
      size === null ||
      Math.abs(size.width - live.pixelWidth) > 1 ||
      Math.abs(size.height - live.pixelHeight) > 1
    ) {
      return;
    }
    for (const attachment of entry.screencasts) attachment.offer(bytes);
  }

  /**
   * A person's input from a viewer, applied to the tab as-is. It is the
   * person's, so it takes no agent hold; it does close the tab's camera for
   * the quiet window, as touching a shown tab does on desktop.
   */
  async viewerInput(tabId: string, input: BrowserViewerInput): Promise<void> {
    const entry = this.requireTab(tabId);
    if (entry.state.presentation === "headless") {
      throw new Error("A Headless Browser Tab has no view until the person shows it");
    }
    entry.lastInteractionAt = this.now();
    const target = await entry.ready;
    const send = (method: string, params: object): Promise<unknown> =>
      target.engine.connection.send(method, params, target.sessionId);
    switch (input.kind) {
      case "mouse":
        await send("Input.dispatchMouseEvent", {
          type:
            input.type === "pressed"
              ? "mousePressed"
              : input.type === "released"
                ? "mouseReleased"
                : "mouseMoved",
          x: input.x,
          y: input.y,
          // A move while a button is held is a drag: Chromium needs the held
          // button named on it (as a native pointer reports it), not "none".
          button:
            input.type === "moved" && input.button === "none"
              ? heldButton(input.buttons)
              : input.button,
          buttons: input.buttons,
          clickCount: input.clickCount,
          modifiers: input.modifiers,
        });
        return;
      case "wheel":
        await send("Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x: input.x,
          y: input.y,
          deltaX: input.deltaX,
          deltaY: input.deltaY,
          modifiers: input.modifiers,
        });
        return;
      case "key":
        await send("Input.dispatchKeyEvent", {
          type: input.type === "up" ? "keyUp" : input.text === undefined ? "rawKeyDown" : "keyDown",
          key: input.key,
          code: input.code,
          windowsVirtualKeyCode: input.keyCode,
          modifiers: input.modifiers,
          ...(input.text === undefined ? {} : { text: input.text, unmodifiedText: input.text }),
        });
        return;
      case "text":
        await send("Input.insertText", { text: input.text });
        return;
      case "composition":
        await send("Input.imeSetComposition", {
          text: input.text,
          selectionStart: input.selectionStart,
          selectionEnd: input.selectionEnd,
        });
        return;
    }
  }
}
