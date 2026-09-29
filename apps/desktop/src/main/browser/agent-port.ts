/**
 * The desktop's answer to {@link RuntimeBrowserPort}: one Session's Browser
 * capability, composed from the BrowserTabHost's registry and a per-tab CDP
 * controller, scoped before anything else happens.
 *
 * Scope is the whole of the visibility policy this slice carries: a Session
 * sees the person's own tabs (duosync — "look at what I'm reading" needs the
 * agent to reach the tab the person named) and the agent tabs it OPENED
 * itself (VC-238), and nothing another Session opened — not even a sibling on
 * the same Ticket, which used to see and drive this Session's tabs because the
 * scope stopped at the Ticket. An out-of-scope tab refuses as
 * `browser.unknown-tab` — unknown rather than forbidden, because a tab this
 * Session cannot touch is a tab it was never shown, and a refusal that says
 * "exists, but not yours" is a listing of somebody else's work.
 *
 * Whether a VC-9 subagent may see its parent's tabs (or a parent its child's)
 * is VC-9's decision. The seam for it is {@link AgentBrowserPortOptions.sharesTabsOf}:
 * one predicate over another Session's id, defaulting to "nobody".
 *
 * Visibility of a personal tab carries ACTUATION, not only reading: a Session
 * may `navigate` and `act` on a `user` tab, not merely snapshot it. That is a
 * deliberate grant and a knowingly accepted risk, so it is written down here
 * rather than left to be rediscovered. Personal tabs share one PERSISTENT
 * profile (`persist:volli-browser:user`), so they carry real cookies and real
 * sign-ins, while Session tabs get a credentialless per-Ticket or per-Project
 * partition. The consequence to hold in view: page content this port returns is untrusted,
 * and a prompt injection that survives the tools' envelope could ask the model
 * to steer an authenticated tab and read the result back. Volli takes that
 * trade for now because duosync is the feature — "drive the thing I am looking
 * at" is the point, and a read-only port would not be it.
 *
 * This is explicitly PROVISIONAL. The preferred end state is an approval step:
 * the person confirms before a Session acts on a tab that is theirs, the way a
 * destructive command asks first. It is deferred rather than rejected, and
 * VC-239 answered the question that deferred it — how often the prompt would
 * fire. It fires where the HOLD is taken (`takeHold` below): once per hold,
 * which spans a turn's run of actions on one tab, not once per click. That is
 * seldom enough to be a safeguard rather than friction.
 *
 * When that lands, it belongs in `takeHold`, keyed on `tab.createdBy ===
 * "user"` — not in the visibility filter below, because listing a tab and
 * driving it are separate questions and only the second one needs an answer
 * from the person.
 *
 * THE HOLD (VC-239). A hold is one party's turn to drive a tab: one Session or
 * the person, never both. Reads never need one. Every write — `act`, and
 * `navigate` on an existing tab — takes the hold on a free tab, keeps its own,
 * and is refused on anybody else's with the holder named and the way out
 * stated: open your own tab, or wait. A tab this Session opens is held from
 * birth. A hold ends when the Session releases it, when its turn ends
 * (`turnEnded`, driven by the adapter off the turn observation), when the
 * attachment ends (`dispose`), when the tab closes, or when the person takes
 * over — and by nothing else, so a stale hold is impossible by construction.
 * The host judges every one of those against the attachment id, so a port
 * from an earlier attachment cannot keep or release a newer one's hold.
 *
 * Generations bridge the two owners: the host counts navigations off the
 * webContents' own events (a person navigating a shared tab included), and
 * every port call re-syncs the controller to the host's count before acting,
 * so a ref minted before anyone — model or person — moved the page refuses
 * rather than clicks what now sits at those coordinates.
 *
 * Everything here throws {@link BrowserRefusal} for judged outcomes and plain
 * errors for broken plumbing; the runtime's tools translate the former into
 * readable text and let the latter fail the call, exactly as the web ports do.
 */

import type { WebContents } from "electron";

import { BrowserRefusal } from "@volli/agent-runtime";
import type {
  BrowserTabHolder,
  RuntimeBrowserActResult,
  RuntimeBrowserConsole,
  RuntimeBrowserHoldOutcome,
  RuntimeBrowserHolder,
  RuntimeBrowserNavigation,
  RuntimeBrowserPage,
  RuntimeBrowserPort,
  RuntimeBrowserSnapshot,
} from "@volli/shared";

import type { BrowserTabState } from "../../ipc/contract";
import type { BrowserAgentCoordinator } from "./agent-coordinator";
import type {
  BrowserHoldEnd,
  BrowserHoldOutcome,
  BrowserSessionHolder,
  BrowserTabCreateOptions,
} from "./tab-host";
import { BrowserSessionTabLimitError, BrowserTabLimitError, isAllowedBrowserUrl } from "./tab-host";
import type { BrowserTabController, CdpTransport, TabCursorDriver } from "./cdp-controller";

/**
 * What the port asks of the host — the registry and navigation surface, as a
 * structural subset of BrowserTabHost so tests can answer it with a plain
 * record and production hands the host itself.
 */
export interface AgentBrowserHost {
  /** Host-wide Browser operation queues and shared debugger lifetimes. */
  agentOperations: BrowserAgentCoordinator;
  list(scope: { projectId: string; ticketId?: string }): BrowserTabState[];
  open(input: BrowserTabCreateOptions): BrowserTabState;
  navigate(tabId: string, url: string): BrowserTabState;
  back(tabId: string): BrowserTabState;
  forward(tabId: string): BrowserTabState;
  reload(tabId: string): BrowserTabState;
  consoleOf(tabId: string): Pick<RuntimeBrowserConsole, "messages" | "truncated">;
  /** A live picture of the tab for the transcript card, or null when the host declined to look. */
  capturePicture(tabId: string, signal?: AbortSignal): Promise<string | null>;
  /** Keeps a model-requested screenshot for the person; answers the picture's id. */
  keepScreenshot(tabId: string, base64Png: string): string;
  /** Closes the headless tabs one Session owns; a shown tab is the person's and stays. */
  closeHeadlessOwnedBy(sessionId: string): string[];
  /** The hold doors (VC-239); see {@link BrowserTabHost.hold} and its siblings. */
  hold(tabId: string, holder: BrowserSessionHolder): BrowserHoldOutcome;
  releaseHold(tabId: string, holder: BrowserSessionHolder, why?: BrowserHoldEnd): void;
  releaseAllHeldBy(holder: BrowserSessionHolder, why: BrowserHoldEnd): string[];
  forgetSession(holder: BrowserSessionHolder): void;
}

/**
 * The port as the desktop builds it: the runtime's port with the hold pair
 * always present, plus the one lifecycle door the adapter drives that the
 * runtime never sees — a turn ending.
 */
export interface AgentBrowserPort extends RuntimeBrowserPort {
  acquire(input: { tabId: string; signal: AbortSignal }): Promise<RuntimeBrowserHoldOutcome>;
  release(input: { tabId: string; signal: AbortSignal }): Promise<{ tabId: string }>;
  /** The Session's turn completed or was interrupted: every hold it has ends now. */
  turnEnded(): void;
  dispose(): void;
}

export interface AgentBrowserPortOptions {
  host: AgentBrowserHost;
  /** The Session's product scope, fixed at attachment and never the model's to name. */
  scope: { projectId: string; ticketId: string | null };
  /**
   * Who this port serves (VC-239): the Session and the attachment it runs
   * under. A hold is taken in this name and judged against it; the port never
   * learns it from the model.
   *
   * Its `sessionId` is also the OWNER every tab this port opens is stamped
   * with, and the identity visibility is judged by (VC-238). The two facts sit
   * on one identity because they are the same Session — but they are not the
   * same claim: ownership outlives the attachment and the hold does not.
   */
  session: BrowserSessionHolder;
  /**
   * Whether tabs owned by ANOTHER Session are visible to this one. Absent
   * means no: a Session sees the person's tabs and its own. This is a seam for
   * VC-9's parent/child rule, not a rule of its own.
   */
  sharesTabsOf?: (ownerSessionId: string) => boolean;
  /**
   * The Session cursor for one tab, or nothing (VC-239). Production binds the
   * overlay, which draws only over the on-screen tab and answers at once for
   * any other; tests and a build with no overlay pass nothing and pay nothing.
   */
  cursorFor?: (tabId: string) => TabCursorDriver | undefined;
  /** The CDP wire for one live tab — production binds `webContents.debugger`. */
  transportFor: (tabId: string) => CdpTransport;
  /** Resolves when the tab has settled enough to read; must honour the signal. */
  waitForLoad: (tabId: string, signal: AbortSignal, mode?: BrowserLoadWaitMode) => Promise<void>;
  /**
   * Holds one tab's engine at foreground pace and returns the release —
   * production binds {@link BrowserTabHost.holdAwake}. Chromium throttles a
   * hidden tab's timers, rendering and loads, and a Session keeps driving its
   * tabs after the person switches workspaces (VC-252); the port takes a hold
   * the first time it drives a tab and keeps it until the tab leaves scope or
   * the attachment ends, so background work never depends on which workspace
   * is on screen.
   */
  holdAwake: (tabId: string) => () => void;
}

/**
 * The production CDP wire: one tab's `webContents.debugger`, Electron's
 * app-private protocol client. Attaching here — rather than ever passing
 * `--remote-debugging-port` — is the load-bearing security decision this
 * feature rests on: there is no loopback endpoint, so no other local process
 * can reach this tab or the app's own privileged renderer through one.
 * Attachment is lazy and re-checked per send, because DevTools sharing the
 * target can drop it between calls.
 */
export function debuggerTransport(contents: WebContents): CdpTransport {
  const wire = contents.debugger;
  let initialized = false;
  let disposed = false;
  const assertLive = (): void => {
    if (disposed) throw new Error("The Browser Tab debugger transport was disposed");
  };
  const ensureReady = async (): Promise<void> => {
    assertLive();
    if (initialized && wire.isAttached()) return;
    initialized = false;
    try {
      if (!wire.isAttached()) wire.attach("1.3");
      await wire.sendCommand("Accessibility.enable");
      assertLive();
      await wire.sendCommand("DOM.enable");
      assertLive();
      await wire.sendCommand("Page.enable");
      assertLive();
      initialized = true;
    } catch {
      assertLive();
      throw new BrowserRefusal(
        "browser.debugger-unavailable",
        "Browser control is unavailable while another debugger owns this tab. Close its DevTools and retry.",
      );
    }
  };
  return {
    ensureReady,
    send: async (method, params) => {
      await ensureReady();
      assertLive();
      return wire.sendCommand(method, params);
    },
    dispose: () => {
      // Attachment, not initialization, is what has to be given back. An
      // `ensureReady` that attached and then failed or was withdrawn leaves
      // `initialized` false over a live attachment, and while Chromium's
      // debugger owns the tab the person cannot open their own DevTools on it.
      disposed = true;
      if (!wire.isAttached()) return;
      initialized = false;
      try {
        wire.detach();
      } catch {
        // The target may already be disappearing. Disposal owns no user
        // operation to fail; the WebContents teardown finishes the job.
      }
    },
  };
}

/**
 * The production load-wait: settle when the tab stops loading, when the bound
 * falls, or when the caller withdraws — whichever is first. Resolution, never
 * rejection: a page still loading at the bound is a page a snapshot can
 * honestly describe as it stands, and a withdrawn wait belongs to a turn that
 * is already gone.
 */
export type BrowserLoadWaitMode = "current" | "possible-navigation" | "required-navigation";

export function loadWaiter(
  webContentsOf: (tabId: string) => Pick<WebContents, "isLoading" | "on" | "removeListener">,
  timeoutMs = 10_000,
  navigationGraceMs = 50,
): (tabId: string, signal: AbortSignal, mode?: BrowserLoadWaitMode) => Promise<void> {
  return async (tabId, signal, mode = "current") => {
    const contents = webContentsOf(tabId);
    const loading = contents.isLoading();
    if ((!loading && mode === "current") || signal.aborted) return;
    await new Promise<void>((resolve) => {
      let grace: ReturnType<typeof setTimeout> | undefined;
      const started = (): void => {
        if (grace !== undefined) clearTimeout(grace);
      };
      const finish = (): void => {
        clearTimeout(timer);
        if (grace !== undefined) clearTimeout(grace);
        contents.removeListener("did-start-loading", started);
        contents.removeListener("did-stop-loading", finish);
        contents.removeListener("destroyed", finish);
        contents.removeListener("render-process-gone", finish);
        signal.removeEventListener("abort", finish);
        resolve();
      };
      const timer = setTimeout(finish, timeoutMs);
      contents.on("did-start-loading", started);
      contents.on("did-stop-loading", finish);
      contents.on("destroyed", finish);
      contents.on("render-process-gone", finish);
      signal.addEventListener("abort", finish, { once: true });
      // Close BOTH gaps: a load can start or finish during listener install,
      // and a withdrawal can precede its abort listener too.
      if (signal.aborted) finish();
      else if (contents.isLoading()) started();
      else if (loading) finish();
      else if (mode === "possible-navigation") grace = setTimeout(finish, navigationGraceMs);
    });
  };
}

/**
 * The tab facts every answer carries (VC-238): what the model's text cannot
 * say and the renderer may not infer — which tab, whose it is, and whether its
 * page is broken. One place, so a snapshot, a screenshot, a console read and a
 * refusal all describe the same tab the same way.
 */
function pageOf(tab: BrowserTabState): RuntimeBrowserPage {
  return {
    tabId: tab.tabId,
    url: tab.url,
    title: tab.title,
    ownerSessionId: tab.ownerSessionId,
    error: tab.error,
  };
}

/**
 * What the desktop's composition needs of the live host beyond
 * {@link AgentBrowserHost}: each tab's `webContents` for the CDP wire and the
 * load waiter, and the wake hold against background throttling (VC-252).
 */
export interface DesktopBrowserHost extends AgentBrowserHost {
  webContentsOf(tabId: string): WebContents;
  holdAwake(tabId: string): () => void;
}

/**
 * The port as the desktop composes it over one host: the app-private
 * debugger as the CDP wire, the host's own load waiter and wake hold, and
 * the Session cursor for the tab on screen. ONE factory for every caller —
 * the adapter's attach path and the smoke's probe alike — so an option added
 * here reaches both, and the smoke can never drift into testing a port that
 * is not the one Sessions get.
 */
export function desktopBrowserPort(input: {
  host: DesktopBrowserHost;
  scope: AgentBrowserPortOptions["scope"];
  session: BrowserSessionHolder;
  cursorFor: AgentBrowserPortOptions["cursorFor"];
  /** VC-9's parent/child seam, when the composition has one to offer (VC-238). */
  sharesTabsOf?: AgentBrowserPortOptions["sharesTabsOf"];
}): AgentBrowserPort {
  const { host } = input;
  return createAgentBrowserPort({
    host,
    scope: input.scope,
    session: input.session,
    ...(input.sharesTabsOf === undefined ? {} : { sharesTabsOf: input.sharesTabsOf }),
    transportFor: (tabId) => debuggerTransport(host.webContentsOf(tabId)),
    waitForLoad: loadWaiter((tabId) => host.webContentsOf(tabId)),
    holdAwake: (tabId) => host.holdAwake(tabId),
    cursorFor: input.cursorFor,
  });
}

/** The runtime's view of a holder, from the host's: the same record, with "is it me" answered. */
function runtimeHolder(
  holder: BrowserTabHolder | null,
  self: BrowserSessionHolder,
): RuntimeBrowserHolder {
  if (holder === null) return null;
  if (holder.kind === "person") return { kind: "person" };
  return {
    kind: "session",
    sessionId: holder.sessionId,
    self: holder.sessionId === self.sessionId,
  };
}

/** The refusal a write on somebody else's tab gets: the holder, and the way out. */
function heldRefusal(tabId: string, holder: BrowserTabHolder): BrowserRefusal {
  if (holder.kind === "person") {
    return new BrowserRefusal(
      "browser.person-has-tab",
      `The person has taken Browser Tab ${JSON.stringify(tabId)}: wait for them to hand it back, or open your own tab with browser_navigate and no tabId.`,
    );
  }
  return new BrowserRefusal(
    "browser.tab-held",
    `Browser Tab ${JSON.stringify(tabId)} is held by ${holder.name} (Session ${holder.sessionId}): open your own tab with browser_navigate and no tabId, or wait and try again.`,
  );
}

export function createAgentBrowserPort(options: AgentBrowserPortOptions): AgentBrowserPort {
  const lifetime = new AbortController();
  const owner = JSON.stringify([options.session.sessionId, options.session.attachmentId]);

  /** Adds the attachment lifetime to every caller-owned cancellation signal. */
  const scoped =
    <I extends { signal: AbortSignal }, O>(
      run: (input: I) => Promise<O>,
    ): ((input: I) => Promise<O>) =>
    async (input) => {
      const signal = AbortSignal.any([input.signal, lifetime.signal]);
      signal.throwIfAborted();
      return await run({ ...input, signal });
    };

  /**
   * Every operation that can touch a tab runs in the host-wide per-tab queue.
   * The controller is lazy so hold-only work and pre-load navigation do not
   * attach Chromium's debugger before they need it.
   */
  const scheduled = async <T>(
    tabId: string,
    signal: AbortSignal,
    operation: (controller: () => Promise<BrowserTabController>) => Promise<T>,
  ): Promise<T> => {
    const cursor = options.cursorFor?.(tabId);
    return await options.host.agentOperations.run({
      tabId,
      owner,
      signal,
      factory: {
        transport: () => options.transportFor(tabId),
        ...(cursor === undefined ? {} : { cursor }),
      },
      operation: async (context) => await operation(context.controller),
    });
  };

  /** One live wake lease per driven tab; released with the tab's scope or the attachment. */
  const wakes = new Map<string, () => void>();
  const session = options.session;

  const keepAwake = (tabId: string): void => {
    if (!wakes.has(tabId)) wakes.set(tabId, options.holdAwake(tabId));
  };

  const releaseWake = (tabId: string): void => {
    const release = wakes.get(tabId);
    wakes.delete(tabId);
    release?.();
  };

  /**
   * Runs one call against a resolved tab, and tells any refusal inside it
   * which page it was aimed at. A refusal raised deeper — a stale generation
   * in the controller, an unknown ref — knows the rule but not the tab, and
   * without this the transcript row would name a bare `e5` and no page.
   */
  const refusalsOn = async <T>(tab: BrowserTabState, run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (error) {
      throw error instanceof BrowserRefusal ? error.onPage(pageOf(tab)) : error;
    }
  };

  const ownedHere = (tab: BrowserTabState): boolean =>
    tab.ownerSessionId === session.sessionId ||
    (tab.ownerSessionId !== null && options.sharesTabsOf?.(tab.ownerSessionId) === true);

  /** The Session's visible slice of the registry, by the scope rule above. */
  const visible = (): BrowserTabState[] =>
    options.host
      .list({ projectId: options.scope.projectId })
      .filter((tab) => tab.createdBy === "user" || ownedHere(tab));

  const resolve = (tabId: string): BrowserTabState => {
    const tab = visible().find((candidate) => candidate.tabId === tabId);
    if (tab === undefined) {
      releaseWake(tabId);
      throw new BrowserRefusal(
        "browser.unknown-tab",
        `No Browser Tab ${JSON.stringify(tabId)} is open to this Session: list tabs with browser_tabs, or open one with browser_navigate.`,
      );
    }
    return tab;
  };

  /**
   * Rule 2: a write takes the hold or is refused. The host decides; this
   * only words the refusal. Called before every write and by `acquire`.
   */
  const heldTabs = new Set<string>();
  const takeHold = (tab: BrowserTabState): BrowserTabState => {
    const outcome = options.host.hold(tab.tabId, session);
    if (outcome.kind === "refused") throw heldRefusal(tab.tabId, outcome.holder);
    heldTabs.add(tab.tabId);
    return outcome.tab;
  };

  /** The attachment's controller, generation-synced to the host's count. */
  const syncedController = async (
    tab: BrowserTabState,
    controller: () => Promise<BrowserTabController>,
    signal: AbortSignal,
  ): Promise<BrowserTabController> => {
    const ready = await controller();
    signal.throwIfAborted();
    ready.syncGeneration(resolve(tab.tabId).generation);
    return ready;
  };

  /**
   * The page after a change, for the person: photographed once the load the
   * change started has settled, so the frame shows the result rather than the
   * moment before it. A read (`snapshot`) changes nothing and takes none.
   */
  const pictureAfterChange = async (
    tabId: string,
    changed: boolean,
    signal: AbortSignal,
  ): Promise<string | null> => (changed ? await options.host.capturePicture(tabId, signal) : null);

  const snapshotOf = async (
    tabId: string,
    signal: AbortSignal,
    controller: () => Promise<BrowserTabController>,
    waitMode: BrowserLoadWaitMode = "current",
    changed = false,
  ): Promise<RuntimeBrowserSnapshot> => {
    // Scope before waiting: an out-of-scope id must not gain a loading-timing
    // oracle, and a cancelled call must not attach Chromium's debugger.
    resolve(tabId);
    signal.throwIfAborted();
    // Hold before waiting: a hidden tab's load only settles the wait below if
    // its engine runs at foreground pace while nobody is watching it.
    keepAwake(tabId);
    await options.waitForLoad(tabId, signal, waitMode);
    signal.throwIfAborted();
    const tab = resolve(tabId);
    const ready = await syncedController(tab, controller, signal);
    const printed = await ready.snapshot(signal);
    const picture = await pictureAfterChange(tab.tabId, changed, signal);
    signal.throwIfAborted();
    // Re-read after the capture, and without refusing: a load that failed
    // while this call waited is the one fact a successful-looking snapshot
    // would otherwise hide (§9), and a tab that closed in the same gap should
    // still answer with the page it described rather than become a refusal.
    const settled = visible().find((candidate) => candidate.tabId === tabId) ?? tab;
    return {
      ...pageOf(settled),
      snapshotText: printed.text,
      generation: printed.generation,
      truncated: printed.truncated,
      picture,
    };
  };

  const steer = (
    tabId: string | undefined,
    navigation: RuntimeBrowserNavigation,
  ): { tabId: string; waitMode: BrowserLoadWaitMode } => {
    if (navigation.kind === "url" && !isAllowedBrowserUrl(navigation.url)) {
      throw new BrowserRefusal(
        "browser.navigation-policy",
        "Browser Tabs open http and https targets only; nothing else was navigated.",
      );
    }
    if (tabId === undefined) {
      if (navigation.kind !== "url") {
        throw new BrowserRefusal(
          "browser.unknown-tab",
          "History moves need a tabId: back, forward and reload belong to one tab.",
        );
      }
      try {
        const born = options.host.open({
          url: navigation.url,
          projectId: options.scope.projectId,
          ticketId: options.scope.ticketId,
          createdBy: "session",
          // Owned by this Session from birth (VC-238), and held by it from
          // birth (VC-239) — two facts, both true, neither implying the other.
          ownerSessionId: session.sessionId,
        });
        // Rule 3: a tab this Session opens is its own from birth. Nobody else
        // can have reached it between the open and this line.
        takeHold(born);
        return { tabId: born.tabId, waitMode: "required-navigation" };
      } catch (error) {
        // Two caps, two rule names, so a person reading the transcript can
        // tell which one fired: the project's, or this Session's own.
        if (error instanceof BrowserSessionTabLimitError) {
          throw new BrowserRefusal("browser.session-tab-limit", error.message);
        }
        if (!(error instanceof BrowserTabLimitError)) throw error;
        throw new BrowserRefusal("browser.tab-limit", error.message);
      }
    }
    // Every history move and every address-bar-style navigation is a write.
    const tab = takeHold(resolve(tabId));
    switch (navigation.kind) {
      case "url":
        return {
          tabId: options.host.navigate(tab.tabId, navigation.url).tabId,
          waitMode: "required-navigation",
        };
      case "back": {
        const moved = options.host.back(tab.tabId);
        return {
          tabId: moved.tabId,
          waitMode: moved.generation > tab.generation ? "required-navigation" : "current",
        };
      }
      case "forward": {
        const moved = options.host.forward(tab.tabId);
        return {
          tabId: moved.tabId,
          waitMode: moved.generation > tab.generation ? "required-navigation" : "current",
        };
      }
      case "reload":
        return {
          tabId: options.host.reload(tab.tabId).tabId,
          waitMode: "required-navigation",
        };
    }
  };

  const port: AgentBrowserPort = {
    tabs: async (input) => {
      input.signal.throwIfAborted();
      return {
        tabs: visible().map((tab) => ({
          tabId: tab.tabId,
          url: tab.url,
          title: tab.title,
          createdBy: tab.createdBy,
          ownerSessionId: tab.ownerSessionId,
          heldBy: runtimeHolder(tab.heldBy, session),
        })),
      };
    },
    navigate: async (input) => {
      input.signal.throwIfAborted();
      if (input.tabId === undefined) {
        const steered = steer(undefined, input.navigation);
        return await scheduled(steered.tabId, input.signal, async (controller) =>
          snapshotOf(steered.tabId, input.signal, controller, steered.waitMode, true),
        );
      }

      // Named quietly rather than resolved: a refused navigation should still
      // say which tab it was aimed at, but WHICH refusal fires first is
      // `steer`'s order to keep — the target policy is judged before the host
      // sees anything, unknown tab or not.
      const aimed = visible().find((candidate) => candidate.tabId === input.tabId);
      if (aimed === undefined) {
        // This can only throw. Running it now avoids creating host queue state
        // for a tab the Session is not allowed to know exists.
        steer(input.tabId, input.navigation);
        throw new Error("Unreachable Browser navigation");
      }
      return await refusalsOn(aimed, async () =>
        scheduled(input.tabId!, input.signal, async (controller) => {
          const steered = steer(input.tabId, input.navigation);
          return await snapshotOf(steered.tabId, input.signal, controller, steered.waitMode, true);
        }),
      );
    },
    snapshot: async (input) => {
      const tab = resolve(input.tabId);
      return await refusalsOn(tab, async () =>
        scheduled(input.tabId, input.signal, async (controller) =>
          snapshotOf(input.tabId, input.signal, controller),
        ),
      );
    },
    act: async (input): Promise<RuntimeBrowserActResult> => {
      input.signal.throwIfAborted();
      const aimed = resolve(input.tabId);
      return await refusalsOn(aimed, async () =>
        scheduled(input.tabId, input.signal, async (controller) => {
          const tab = takeHold(resolve(input.tabId));
          keepAwake(tab.tabId);
          const ready = await syncedController(tab, controller, input.signal);
          const acted = await ready.act(
            {
              generation: input.generation,
              kind: input.kind,
              ...(input.ref === undefined ? {} : { ref: input.ref }),
              ...(input.text === undefined ? {} : { text: input.text }),
              ...(input.key === undefined ? {} : { key: input.key }),
              ...(input.direction === undefined ? {} : { direction: input.direction }),
              ...(input.waitMs === undefined ? {} : { waitMs: input.waitMs }),
            },
            input.signal,
          );
          const snap = await snapshotOf(
            input.tabId,
            input.signal,
            controller,
            "possible-navigation",
            true,
          );
          return { ...snap, target: acted.target };
        }),
      );
    },
    screenshot: async (input) => {
      input.signal.throwIfAborted();
      const aimed = resolve(input.tabId);
      return await refusalsOn(aimed, async () =>
        scheduled(input.tabId, input.signal, async (controller) => {
          const tab = resolve(input.tabId);
          keepAwake(tab.tabId);
          const ready = await syncedController(tab, controller, input.signal);
          const shot = await ready.screenshot(input.signal);
          input.signal.throwIfAborted();
          // The model's picture is the person's too: kept, not re-captured.
          const picture = options.host.keepScreenshot(tab.tabId, shot.base64Png);
          return { ...pageOf(resolve(tab.tabId)), picture, ...shot };
        }),
      );
    },
    console: async (input) => {
      input.signal.throwIfAborted();
      const tab = resolve(input.tabId);
      const record = options.host.consoleOf(tab.tabId);
      return {
        ...pageOf(tab),
        messages: record.messages,
        truncated: record.truncated,
      };
    },
    acquire: async (input) => {
      input.signal.throwIfAborted();
      resolve(input.tabId);
      return await scheduled(input.tabId, input.signal, async () => {
        const tab = resolve(input.tabId);
        const outcome = options.host.hold(tab.tabId, session);
        if (outcome.kind === "held") {
          heldTabs.add(tab.tabId);
          return { kind: "held" as const, tabId: tab.tabId };
        }
        // Never null here: a refusal always names who has it.
        const holder = runtimeHolder(outcome.holder, session) as NonNullable<RuntimeBrowserHolder>;
        return { kind: "refused" as const, tabId: tab.tabId, holder };
      });
    },
    release: async (input) => {
      input.signal.throwIfAborted();
      resolve(input.tabId);
      return await scheduled(input.tabId, input.signal, async () => {
        const tab = resolve(input.tabId);
        options.host.releaseHold(tab.tabId, session, "release");
        heldTabs.delete(tab.tabId);
        return { tabId: tab.tabId };
      });
    },
    turnEnded: () => {
      // Put each release behind work already queued for that tab. A new turn's
      // work queues behind this barrier and therefore takes a fresh hold.
      const ending = [...heldTabs];
      heldTabs.clear();
      for (const tabId of ending) {
        options.host.agentOperations.afterCurrent(tabId, () => {
          options.host.releaseHold(tabId, session, "turn-end");
        });
      }
    },
    dispose: () => {
      if (lifetime.signal.aborted) return;
      lifetime.abort(new Error("The Browser port was disposed with its Session attachment"));
      heldTabs.clear();
      options.host.agentOperations.releaseOwner(owner, () => {
        for (const release of wakes.values()) release();
        wakes.clear();
        // Holds go with the attachment, and the Session leaves the colour
        // wheel; the host does both in one door.
        options.host.forgetSession(session);
        // Then the tabs themselves. A headless tab's life is bound to the
        // attachment (VC-238): nobody can see it, so nothing but this Session
        // could ever close it. Shown tabs are the person's and outlive it.
        // After forgetSession, so a closing tab's hold is already gone.
        options.host.closeHeadlessOwnedBy(session.sessionId);
      });
    },
  };
  return {
    ...port,
    tabs: scoped(port.tabs),
    navigate: scoped(port.navigate),
    snapshot: scoped(port.snapshot),
    act: scoped(port.act),
    screenshot: scoped(port.screenshot),
    console: scoped(port.console),
    acquire: scoped(port.acquire),
    release: scoped(port.release),
  };
}
