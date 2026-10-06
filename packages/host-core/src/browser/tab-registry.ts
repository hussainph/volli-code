/**
 * The policy half of every Browser backend (VC-561): the registry of product
 * tabs, who owns each (VC-238), who holds each (VC-239), the caps, the console
 * record, pictures and traces. One implementation, so an agent's refs,
 * generations and refusals cannot depend on which engine renders the page.
 *
 * A backend extends it with its engine: how a tab is created, navigated and
 * closed, what its live chrome reads, how it is kept awake and taken off
 * screen, its CDP wire and its pictures. Desktop's `BrowserTabHost` is one
 * (`WebContentsView`s). The base never reaches an engine itself; it asks
 * through the abstract members below, at exactly the points the desktop host
 * read its `webContents` before this was split out of it.
 */
import {
  pickSessionColor,
  shortSessionId,
  type BrowserTabBounds,
  type BrowserTabHolder,
  type BrowserTabPresentation,
  type BrowserTabState,
  type BrowserTrace,
  type RuntimeBrowserConsoleMessage,
} from "@volli/shared";

import { BrowserAgentCoordinator } from "./agent-coordinator";
import {
  BROWSER_MAX_TABS_PER_PROJECT,
  BROWSER_MAX_TABS_PER_SESSION,
  BROWSER_URL_MAX_CHARS,
  BrowserSessionTabLimitError,
  BrowserTabLimitError,
  type BrowserBackend,
  type BrowserHoldEnd,
  type BrowserHoldEvent,
  type BrowserHoldOutcome,
  type BrowserLoadWaitMode,
  type BrowserSessionHolder,
  type BrowserTabCreateOptions,
} from "./backend";
import type { CdpTransport } from "./cdp-controller";
import type { BrowserPictureStore } from "./picture-store";
import type { BrowserTraceStepInput, BrowserTraceStore } from "./trace-store";
import { hostLogger } from "../log/root";

const log = hostLogger("browser");

export const BROWSER_TITLE_MAX_CHARS = 512;
export const BROWSER_ERROR_MAX_CHARS = 1_024;
export const BROWSER_CONSOLE_MAX_MESSAGES = 100;
export const BROWSER_CONSOLE_MAX_CHARS = 30_000;

/** Keeps page-owned chrome facts bounded and on one renderer/model-owned line. */
function boundedBrowserTitle(title: string): string {
  return title.replace(/\s+/g, " ").trim().slice(0, BROWSER_TITLE_MAX_CHARS);
}

function boundedBrowserUrl(url: string): string {
  return url.slice(0, BROWSER_URL_MAX_CHARS);
}

/** A notice needs a nameable host, never a URL path or query. */
function browserHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function boundedBrowserError(error: string | null): string | null {
  return error === null
    ? null
    : error.replace(/\s+/g, " ").trim().slice(0, BROWSER_ERROR_MAX_CHARS);
}

/**
 * What the registry needs of its host, whatever the engine. A backend's own
 * dependencies extend this with its construction surfaces.
 */
export interface BrowserTabRegistryPorts {
  createId: () => string;
  publishState: (event: BrowserTabState) => void;
  publishClosed: (tabId: string) => void;
  /** Where captured pixels wait for the card that shows them (VC-238). */
  pictures: BrowserPictureStore;
  /**
   * Where a Session's steps in its own tabs are recorded for replay (VC-453).
   * Absent means nothing is recorded — most tests, and a build with no disk.
   */
  traces?: BrowserTraceStore;
  /** The clock the interaction window is measured against; production passes none. */
  now?: () => number;
  /**
   * A Session's display name for the holder record (VC-239). Asynchronous
   * because the title lives in the Session Engine's projection; the hold is
   * published at once under a placeholder and again when the name lands.
   * Absent, or `null` from it, leaves the placeholder — a hold never waits on
   * a name.
   */
  sessionName?: (sessionId: string) => Promise<string | null>;
}

/** The chrome facts a tab's engine reports live; {@link BrowserTabRegistry.publish} reads them. */
export type BrowserTabChrome = Pick<
  BrowserTabState,
  "url" | "title" | "loading" | "canGoBack" | "canGoForward"
>;

/** The registry's record of one tab. A backend's entry extends it with its engine's handles. */
export interface BrowserTabRecord {
  state: BrowserTabState;
  console: RuntimeBrowserConsoleMessage[];
  consoleTruncated: boolean;
  /** Live agent holds against background throttling; see {@link BrowserTabRegistry.holdAwake}. */
  wakeLeases: number;
  /**
   * Whose turn it is to drive this tab (VC-239): the Session's claim with its
   * attachment, the person, or nobody. The renderer-facing projection of it
   * is `state.heldBy`, kept in step by {@link BrowserTabRegistry.publishHold}.
   *
   * Orthogonal to `state.ownerSessionId` (VC-238), which says whose tab this
   * is rather than whose turn it is: a headless tab can be held, and a hold
   * never moves ownership.
   */
  hold: { kind: "session"; holder: BrowserSessionHolder } | { kind: "person" } | null;
}

/**
 * Registry identity, ownership, holds and state publication for every live
 * tab of one backend, so neither a client nor the engine can become the
 * authority for which product tab an operation targets.
 */
export abstract class BrowserTabRegistry<
  E extends BrowserTabRecord,
  D extends BrowserTabRegistryPorts = BrowserTabRegistryPorts,
> implements BrowserBackend {
  protected readonly tabs = new Map<string, E>();
  /** Shared Browser tool queues and CDP wire lifetimes, keyed by tab. */
  readonly agentOperations = new BrowserAgentCoordinator();
  private readonly holdListeners = new Set<(event: BrowserHoldEvent) => void>();
  /**
   * The colour each live holding Session was handed, assigned on its first
   * hold against the colours then in use and never revisited — so a Session
   * keeps its colour for as long as it lives whoever comes or goes after it.
   * Pruned when the Session's attachment ends ({@link forgetSession}), so the
   * wheel is not blocked by Sessions nobody will see again.
   */
  private readonly sessionColors = new Map<string, string>();
  /** Names learned from {@link BrowserTabRegistryPorts.sessionName}, so a second hold does not ask twice. */
  private readonly sessionNames = new Map<string, string>();

  /** `D` is the backend's own dependencies, which extend the registry's. */
  constructor(protected readonly deps: D) {}

  // ---- the engine, as each backend answers it ------------------------------

  /** Creates one tab, born headless when a Session opens it; visibility is a separate act. */
  abstract open(input: BrowserTabCreateOptions): BrowserTabState;
  /** Closes and forgets one product tab without allowing page unload code to veto it. */
  abstract close(tabId: string): void;
  /** Navigates one tab, through the product door's policy. */
  abstract navigate(tabId: string, url: string): BrowserTabState;
  abstract back(tabId: string): BrowserTabState;
  abstract forward(tabId: string): BrowserTabState;
  abstract reload(tabId: string): BrowserTabState;
  /** Closes every tab, when the host or its window goes away. */
  abstract closeAll(): void;
  /** The tab's viewport; see {@link BrowserBackend.setBounds}. */
  abstract setBounds(tabId: string, bounds: BrowserTabBounds): void;
  /** A picture of the tab for the transcript card after an agent changed it, or null when the backend declined to look. */
  abstract capturePicture(tabId: string, signal?: AbortSignal): Promise<string | null>;
  /** The CDP wire for one live tab; see {@link BrowserBackend.transportFor}. */
  abstract transportFor(tabId: string): CdpTransport;
  /** Settles when the tab is readable; see {@link BrowserBackend.waitForLoad}. */
  abstract waitForLoad(
    tabId: string,
    signal: AbortSignal,
    mode?: BrowserLoadWaitMode,
  ): Promise<void>;
  /** The engine's live chrome facts for one tab, read on every publish. */
  protected abstract liveChrome(entry: E): BrowserTabChrome;
  /** Foreground pace while `entry.wakeLeases` is above zero, the engine's own thrift once it is not. */
  protected abstract applyWakePolicy(entry: E): void;
  /**
   * Takes one tab off any screen a person could see it on. A backend with
   * nothing on screen has nothing to do; one that cannot keep the tab whole
   * off screen raises rather than leaving it quietly broken.
   */
  protected abstract goOffScreen(entry: E): void;

  protected requireTab(tabId: string): E {
    const entry = this.tabs.get(tabId);
    if (entry === undefined) throw new Error("Unknown Browser Tab");
    return entry;
  }

  /**
   * Why agent Browser calls are refused right now, or null when they are not
   * (VC-577). Set when the desktop closes every window for menu-bar mode: the
   * tabs went with them, and a turn that keeps running must be told so in
   * words, not left waiting on a tab or a stage window that cannot exist.
   */
  private closedReason: string | null = null;

  unavailableReason(): string | null {
    return this.closedReason;
  }

  /** Close every tab and refuse agent Browser calls with `reason` until {@link reopenForAgents}. */
  closeAllForAgents(reason: string): void {
    this.closedReason = reason;
    this.closeAll();
  }

  /** A window is back: agents may open tabs again. */
  reopenForAgents(): void {
    this.closedReason = null;
  }

  /**
   * Live tabs a Session is using: born to one, or held by one right now. What
   * closing every tab would take away from running agents (VC-577).
   */
  sessionTabCount(): number {
    let count = 0;
    for (const entry of this.tabs.values()) {
      if (entry.state.ownerSessionId !== null || entry.hold?.kind === "session") count += 1;
    }
    return count;
  }

  /** The holder as the renderer sees it, for the overlay's label and colour. */
  heldBy(tabId: string): BrowserTabHolder | null {
    const entry = this.tabs.get(tabId);
    return entry === undefined ? null : this.holderOf(entry);
  }

  /**
   * Whether one more tab may open under `input`'s provenance. Two counters,
   * never one: a person's tabs are bounded per project and an agent's per
   * Session, so neither population can exhaust the other's allowance.
   */
  protected hasCapacity(input: BrowserTabCreateOptions): boolean {
    let count = 0;
    if (input.createdBy === "user") {
      for (const entry of this.tabs.values()) {
        if (entry.state.projectId === input.projectId && entry.state.createdBy === "user") {
          count += 1;
        }
      }
      return count < BROWSER_MAX_TABS_PER_PROJECT;
    }
    // Headless only. A tab the person previewed or promoted is theirs to close
    // (§6) and outlives this Session, so counting it here would let a person's
    // own act — Show — lock the agent out of the allowance the cap exists to
    // guarantee it. The cap bounds what an agent may hold unseen, nothing else.
    for (const entry of this.tabs.values()) {
      if (
        entry.state.ownerSessionId === input.ownerSessionId &&
        entry.state.presentation === "headless"
      ) {
        count += 1;
      }
    }
    return count < BROWSER_MAX_TABS_PER_SESSION;
  }

  protected assertCapacity(input: BrowserTabCreateOptions): void {
    if (this.hasCapacity(input)) return;
    throw input.createdBy === "user"
      ? new BrowserTabLimitError()
      : new BrowserSessionTabLimitError();
  }

  protected recordConsole(entry: E, message: RuntimeBrowserConsoleMessage): void {
    const text = message.text.slice(0, BROWSER_CONSOLE_MAX_CHARS);
    if (text.length !== message.text.length) entry.consoleTruncated = true;
    entry.console.push({ ...message, text });

    let chars = entry.console.reduce((total, one) => total + one.text.length, 0);
    while (
      entry.console.length > BROWSER_CONSOLE_MAX_MESSAGES ||
      chars > BROWSER_CONSOLE_MAX_CHARS
    ) {
      const removed = entry.console.shift();
      chars -= removed?.text.length ?? 0;
      entry.consoleTruncated = true;
    }
  }

  protected beginProductNavigation(entry: E, url?: string): void {
    this.publish(entry, {
      error: null,
      generation: entry.state.generation + 1,
      loading: true,
      ...(url === undefined ? {} : { url }),
    });
  }

  /**
   * A new tab's state, before its engine has said anything about it. Ownership
   * is decided here (VC-238): a Session's tab names its owner and is born
   * headless; a person's tab has no owner and sits in the strip.
   */
  protected newTabState(tabId: string, input: BrowserTabCreateOptions): BrowserTabState {
    return {
      tabId,
      projectId: input.projectId,
      ticketId: input.ticketId,
      createdBy: input.createdBy,
      ownerSessionId: input.createdBy === "session" ? input.ownerSessionId : null,
      // Agent tabs are born headless; only a person can reveal one (VC-238).
      presentation: input.createdBy === "session" ? "headless" : "tab",
      url: input.url,
      title: "",
      loading: true,
      error: null,
      canGoBack: false,
      canGoForward: false,
      generation: 0,
      heldBy: null,
    };
  }

  // ---- holds (VC-239) -----------------------------------------------------

  /** The renderer-facing holder for one entry's hold, with the Session's name and colour resolved. */
  private holderOf(entry: E): BrowserTabHolder | null {
    const hold = entry.hold;
    if (hold === null) return null;
    if (hold.kind === "person") return { kind: "person" };
    const { sessionId } = hold.holder;
    return {
      kind: "session",
      sessionId,
      name: this.sessionNames.get(sessionId) ?? `Session ${shortSessionId(sessionId)}`,
      color: this.sessionColors.get(sessionId) ?? pickSessionColor(sessionId, []),
    };
  }

  /** A Session's colour, assigned on its first hold and sticky from then on. */
  private colorFor(sessionId: string): string {
    let color = this.sessionColors.get(sessionId);
    if (color === undefined) {
      color = pickSessionColor(sessionId, this.sessionColors.values());
      this.sessionColors.set(sessionId, color);
    }
    return color;
  }

  /** Re-derives `state.heldBy` from the entry's hold and pushes the tab. */
  private publishHold(entry: E): void {
    entry.state = { ...entry.state, heldBy: this.holderOf(entry) };
    this.deps.publishState({ ...entry.state });
  }

  private emitHold(event: BrowserHoldEvent): void {
    for (const listener of this.holdListeners) listener(event);
  }

  /** Learns a Session's name once, then republishes every tab it holds under it. */
  private learnSessionName(sessionId: string): void {
    if (this.sessionNames.has(sessionId) || this.deps.sessionName === undefined) return;
    void this.deps.sessionName(sessionId).then(
      (name) => {
        if (name === null || name.trim() === "") return;
        this.sessionNames.set(sessionId, name.trim());
        for (const entry of this.tabs.values()) {
          if (entry.hold?.kind === "session" && entry.hold.holder.sessionId === sessionId) {
            this.publishHold(entry);
          }
        }
      },
      () => {
        // The placeholder stands. Nobody asked for the name and nothing waits
        // on it; a hold is not a user operation that can fail on a lookup.
      },
    );
  }

  private static sameHolder(a: BrowserSessionHolder, b: BrowserSessionHolder): boolean {
    return a.sessionId === b.sessionId && a.attachmentId === b.attachmentId;
  }

  /**
   * Rule 2 and rule 3 in one door: a write on a free tab takes the hold, a
   * write on one's own hold keeps it, and a write on anybody else's is
   * refused with the holder named. The port calls this before every write;
   * `browser_acquire` calls it on its own. Never throws for a judged
   * outcome — the refusal is an answer, and the port words it.
   */
  hold(tabId: string, holder: BrowserSessionHolder): BrowserHoldOutcome {
    const entry = this.requireTab(tabId);
    const current = entry.hold;
    if (current !== null) {
      if (current.kind === "session" && BrowserTabRegistry.sameHolder(current.holder, holder)) {
        return { kind: "held", tab: { ...entry.state } };
      }
      return { kind: "refused", holder: this.holderOf(entry)! };
    }
    entry.hold = { kind: "session", holder };
    this.colorFor(holder.sessionId);
    this.learnSessionName(holder.sessionId);
    this.publishHold(entry);
    this.emitHold({ kind: "taken", tabId, holder });
    return { kind: "held", tab: { ...entry.state } };
  }

  /**
   * Ends one Session's hold on one tab. Only the holder can: a release from
   * anyone else is a no-op rather than a refusal, because "you do not hold
   * this" is already the end state the caller asked for. An unknown tab is
   * the same no-op — a closed tab's hold went with it.
   */
  releaseHold(tabId: string, holder: BrowserSessionHolder, why: BrowserHoldEnd = "release"): void {
    const entry = this.tabs.get(tabId);
    if (entry === undefined || entry.hold === null || entry.hold.kind !== "session") return;
    if (!BrowserTabRegistry.sameHolder(entry.hold.holder, holder)) return;
    entry.hold = null;
    this.publishHold(entry);
    this.emitHold({ kind: "released", tabId, holder, why });
  }

  /** Every hold one attachment has, ended at once: a turn end or the attachment's end. */
  releaseAllHeldBy(holder: BrowserSessionHolder, why: BrowserHoldEnd): string[] {
    const released: string[] = [];
    for (const [tabId, entry] of this.tabs) {
      if (entry.hold?.kind !== "session") continue;
      if (!BrowserTabRegistry.sameHolder(entry.hold.holder, holder)) continue;
      this.releaseHold(tabId, holder, why);
      released.push(tabId);
    }
    return released;
  }

  /**
   * An attachment is over: its holds go, and its Session leaves the colour
   * order so the wheel is not blocked by a Session nobody will see again. A
   * later attachment of the same Session arrives as new and may take another
   * slot — the colour is stable for as long as the Session holds, which is
   * the life the cursor is drawn for.
   *
   * Holds are keyed by attachment and colours by Session, so the two can
   * disagree for a moment: while one attachment of a Session is torn down
   * another may already hold a tab. The colour stays until nothing of the
   * Session holds anything, or a live holder would lose its colour mid-hold
   * and re-pick one that could collide.
   */
  forgetSession(holder: BrowserSessionHolder): void {
    this.releaseAllHeldBy(holder, "attachment-end");
    for (const entry of this.tabs.values()) {
      if (entry.hold?.kind === "session" && entry.hold.holder.sessionId === holder.sessionId) {
        return;
      }
    }
    this.sessionColors.delete(holder.sessionId);
    this.sessionNames.delete(holder.sessionId);
  }

  /**
   * Rule 7: the person takes the tab now. Whoever held it is displaced and
   * named back, so the caller can tell that Session in-band rather than let
   * it learn by failing. Taking over a free tab or one the person already
   * holds is the same end state and reports nobody displaced.
   */
  takeOver(tabId: string): { tab: BrowserTabState; displaced: BrowserSessionHolder | null } {
    const entry = this.requireTab(tabId);
    const displaced = entry.hold?.kind === "session" ? entry.hold.holder : null;
    entry.hold = { kind: "person" };
    this.publishHold(entry);
    if (displaced !== null) {
      this.emitHold({ kind: "released", tabId, holder: displaced, why: "takeover" });
    }
    this.emitHold({
      kind: "person-took",
      tabId,
      tabTitle: entry.state.title,
      tabHostname: browserHostname(entry.state.url),
      displaced,
    });
    return { tab: { ...entry.state }, displaced };
  }

  /** The person gives the tab back: free, and a Session may hold it on its next write. */
  handBack(tabId: string): BrowserTabState {
    const entry = this.requireTab(tabId);
    if (entry.hold?.kind === "person") {
      entry.hold = null;
      this.publishHold(entry);
      this.emitHold({ kind: "person-handed-back", tabId });
    }
    return { ...entry.state };
  }

  /**
   * The person asks the holding Session to release when it is safe. The hold
   * stays; the request is an event for whoever relays it in-band. Nothing to
   * ask on a tab no Session holds.
   */
  askToLeave(tabId: string): BrowserSessionHolder | null {
    const entry = this.requireTab(tabId);
    if (entry.hold?.kind !== "session") return null;
    const holder = entry.hold.holder;
    this.emitHold({
      kind: "ask-to-leave",
      tabId,
      tabTitle: entry.state.title,
      tabHostname: browserHostname(entry.state.url),
      holder,
    });
    return holder;
  }

  /** Whether one attachment holds a tab — the port's own bookkeeping check. */
  isHeldBy(tabId: string, holder: BrowserSessionHolder): boolean {
    const hold = this.tabs.get(tabId)?.hold;
    return hold?.kind === "session" && BrowserTabRegistry.sameHolder(hold.holder, holder);
  }

  /** Hold changes, for the cursor overlay and the steer notices. Returns the unsubscribe. */
  onHoldChange(listener: (event: BrowserHoldEvent) => void): () => void {
    this.holdListeners.add(listener);
    return () => {
      this.holdListeners.delete(listener);
    };
  }

  protected publish(
    entry: E,
    update: Partial<
      Pick<BrowserTabState, "error" | "generation" | "loading" | "presentation" | "title" | "url">
    > = {},
  ): void {
    const live = this.liveChrome(entry);
    const next = {
      ...entry.state,
      url: live.url || entry.state.url,
      title: live.title,
      loading: live.loading,
      canGoBack: live.canGoBack,
      canGoForward: live.canGoForward,
      ...update,
    };
    // URL and title are page-owned bytes. They cross IPC and can enter a model
    // result, so the Browser host — not each consumer — owns their bounds.
    entry.state = {
      ...next,
      url: boundedBrowserUrl(next.url),
      title: boundedBrowserTitle(next.title),
      error: boundedBrowserError(next.error),
    };
    this.deps.publishState({ ...entry.state });
  }

  protected now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** A closed tab's hold goes with it; the holder hears so its own bookkeeping can drop the tab. */
  private endHoldOnClose(tabId: string, entry: E): void {
    const hold = entry.hold;
    entry.hold = null;
    if (hold?.kind === "session") {
      this.emitHold({ kind: "released", tabId, holder: hold.holder, why: "closed" });
    }
  }

  /**
   * Drops one tab from the registry and tells everyone watching. The native
   * side is the caller's, because the two teardown paths differ on whether
   * Chromium can still be asked anything about the view.
   */
  protected forgetEntry(tabId: string, entry: E): void {
    this.tabs.delete(tabId);
    this.agentOperations.closeTab(tabId);
    this.endHoldOnClose(tabId, entry);
    this.deps.publishClosed(tabId);
  }

  /**
   * Where a Session's tab is drawn (VC-238): headless, pinned as the owning
   * chat's preview, or promoted into the strip. Main owns the value and the
   * renderer asks; a person's tab is always in the strip and refuses here.
   *
   * Nothing the agent sees moves. Owner, generation, URL, cookies and the
   * wake hold are untouched — the renderer's plane controller attaches the
   * native view for the surface that now draws it, exactly as it does for a
   * person's tab, so the overlay-freeze rule holds for every presentation.
   *
   * One preview per owning Session: a chat has one pinned pane, so previewing
   * a second tab returns the first to headless rather than leaving two tabs
   * both claiming a pane only one can occupy.
   */
  setPresentation(tabId: string, presentation: BrowserTabPresentation): BrowserTabState {
    const entry = this.requireTab(tabId);
    if (entry.state.createdBy === "user") {
      throw new Error("Only a Session's Browser Tab can be hidden or previewed");
    }
    if (presentation === "preview") {
      for (const other of this.tabs.values()) {
        if (
          other !== entry &&
          other.state.ownerSessionId === entry.state.ownerSessionId &&
          other.state.presentation === "preview"
        ) {
          // The host must take the old preview off screen immediately, just
          // as an explicit Hide does; do not wait for a client to unmount it.
          this.goOffScreen(other);
          this.publish(other, { presentation: "headless" });
        }
      }
    }
    // Off screen before publishing: a tab going headless is drawn nowhere a
    // person can look, and the host is the one that knows it. The renderer's
    // plane controller emits its own hide as the pane unmounts, but that
    // arrives after the state push, and until it did the page would still be
    // over the window. Off screen is a place, not nowhere — a headless tab is
    // still captured and clicked (VC-278) — so a backend that cannot put the
    // tab there raises rather than returning a tab whose page has quietly
    // stopped answering.
    if (presentation === "headless") this.goOffScreen(entry);
    if (entry.state.presentation !== presentation) this.publish(entry, { presentation });
    return { ...entry.state };
  }

  /**
   * Keeps the PNG a `browser_screenshot` call produced, so the picture the
   * model asked for is also the person's to look at later. The engine already
   * rendered these bytes for the model; storing them costs no second capture.
   */
  keepScreenshot(tabId: string, base64Png: string): string {
    const entry = this.requireTab(tabId);
    // The controller already rejects an empty answer from the engine; this is
    // the same rule at the store's door, so no path mints an id for no pixels.
    if (base64Png.length === 0) throw new Error("Refusing to keep an empty Browser Tab screenshot");
    return this.deps.pictures.put({
      tabId,
      generation: entry.state.generation,
      mime: "image/png",
      bytes: Buffer.from(base64Png, "base64"),
      // A picture that outlives this launch is attributable: whose Session
      // asked for it, so the bytes on disk are never anonymous.
      ownerSessionId: entry.state.ownerSessionId,
      persist: true,
    });
  }

  /**
   * The renderer's one read of a picture: a data URL, or null for an id this
   * host never minted. A capture the live set has let go of still answers
   * when a Browser Trace kept its frame (VC-453) — the card's picture and the
   * replay's frame are one id, so a reopened chat shows both.
   */
  pictureOf(pictureId: string): string | null {
    return (
      this.deps.pictures.dataUrl(pictureId) ?? this.deps.traces?.frameDataUrl(pictureId) ?? null
    );
  }

  /**
   * Records one settled call against a tab into the acting Session's trace for
   * the tab (VC-453) — or nothing, when the tab is not a Session's. A tab the
   * person created is never recorded, even while a Session holds it: their
   * pages carry their sign-ins, and the live card is all the evidence those
   * get. A tab that has already closed cannot be judged, so it is not
   * recorded either.
   *
   * Background enrichment of a call that has already answered: a trace that
   * cannot be written owes the tool call nothing, and no person is waiting on
   * it, so a failure is logged and the call's own result stands.
   */
  recordTraceStep(step: BrowserTraceStepInput): void {
    const traces = this.deps.traces;
    const entry = this.tabs.get(step.tabId);
    if (traces === undefined || entry === undefined || entry.state.createdBy !== "session") return;
    try {
      traces.record(step);
    } catch (error) {
      log.warn("browser trace step was not recorded", { tabId: step.tabId, error });
    }
  }

  /** A Session's kept Browser Traces, oldest first; empty when nothing was recorded. */
  tracesOf(sessionId: string): BrowserTrace[] {
    return this.deps.traces?.tracesOf(sessionId) ?? [];
  }

  /**
   * Keeps one tab's engine at foreground pace while an agent drives it
   * (VC-252); the backend's {@link applyWakePolicy} says what that means for
   * its engine. A lease spans the driving attachment, not one tool call.
   *
   * Returns the release. Releasing twice releases once, and a hold on a tab
   * that is unknown or has since closed releases into nothing — wakefulness
   * is resource policy, never a user operation to fail.
   */
  holdAwake(tabId: string): () => void {
    const entry = this.tabs.get(tabId);
    if (entry === undefined) return () => undefined;
    entry.wakeLeases += 1;
    if (entry.wakeLeases === 1) this.applyWakePolicy(entry);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      // A closed tab was already forgotten; its contents are tearing down and
      // owe no throttling answer.
      if (this.tabs.get(tabId) !== entry) return;
      entry.wakeLeases -= 1;
      if (entry.wakeLeases === 0) this.applyWakePolicy(entry);
    };
  }

  /** Page console and renderer-failure evidence recorded from the moment the tab exists. */
  consoleOf(tabId: string): {
    messages: RuntimeBrowserConsoleMessage[];
    truncated: boolean;
  } {
    const entry = this.requireTab(tabId);
    return {
      messages: entry.console.map((message) => ({ ...message })),
      truncated: entry.consoleTruncated,
    };
  }

  /**
   * Closes the headless tabs one Session owns, when its attachment ends
   * (VC-238). A tab a person has shown — previewed or promoted — is theirs to
   * close and survives the Session, the trade Claude Code's Chrome integration
   * makes too: pages you may still be reading stay open. Returns what closed.
   */
  closeHeadlessOwnedBy(sessionId: string): string[] {
    return this.closeHeadlessWhere((state) => state.ownerSessionId === sessionId);
  }

  /** Closes every headless agent tab of one Ticket, when the Ticket is archived. */
  closeHeadlessForTicket(ticketId: string): string[] {
    return this.closeHeadlessWhere((state) => state.ticketId === ticketId);
  }

  private closeHeadlessWhere(matches: (state: BrowserTabState) => boolean): string[] {
    const closing: string[] = [];
    for (const entry of this.tabs.values()) {
      if (entry.state.presentation === "headless" && matches(entry.state)) {
        closing.push(entry.state.tabId);
      }
    }
    for (const tabId of closing) this.close(tabId);
    return closing;
  }

  /** Lists only the caller's product scope, never Chromium's positional view order. */
  list(scope: { projectId: string; ticketId?: string }): BrowserTabState[] {
    const result: BrowserTabState[] = [];
    for (const entry of this.tabs.values()) {
      if (entry.state.projectId !== scope.projectId) continue;
      if (scope.ticketId !== undefined && entry.state.ticketId !== scope.ticketId) continue;
      result.push({ ...entry.state });
    }
    return result;
  }
}
