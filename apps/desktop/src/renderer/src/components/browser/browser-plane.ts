import type { BrowserTabBounds, BrowserTabSetBoundsInput, Result } from "../../../../ipc/contract";

/** The Browser preload subset that owns native-view placement and visibility. */
export interface BrowserPlaneGateway {
  setBounds(input: BrowserTabSetBoundsInput): Promise<Result>;
  show(input: { tabId: string }): Promise<Result>;
  hide(input: { tabId: string }): Promise<Result>;
}

interface BrowserPlaneRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Renderer-owned animation-frame clock, injected so placement stays DOM-free and testable. */
export interface BrowserPlaneFrameScheduler {
  request(callback: () => void): number;
  cancel(handle: number): void;
}

/**
 * A lazy read keeps repeated ResizeObserver notifications from forcing layout
 * before their animation-frame batch knows which observation is the latest.
 */
export type BrowserPlaneBoundsReader = () => BrowserPlaneRect;

function measuredBounds(rect: BrowserPlaneRect): BrowserTabBounds {
  return {
    x: Math.max(0, Math.round(rect.x)),
    y: Math.max(0, Math.round(rect.y)),
    width: Math.max(0, Math.round(rect.width)),
    height: Math.max(0, Math.round(rect.height)),
  };
}

/**
 * Imperative lifecycle for one native Browser Tab plane.
 *
 * React owns when the plane exists; this controller owns the ordered messages
 * that fact implies. Keeping it DOM-free makes the meaningful contract testable:
 * bounds land before show, same-frame observations collapse to their latest
 * value, and every visible plane hides before its owner disappears.
 */
export class BrowserPlaneController {
  private pendingBounds: BrowserPlaneBoundsReader | null = null;
  private boundsFrame: number | null = null;
  private visibility: "unknown" | "visible" | "hidden" = "unknown";
  private disposed = false;

  constructor(
    private readonly tabId: string,
    private readonly gateway: BrowserPlaneGateway,
    private readonly onError: (message: string) => void,
    private readonly scheduler: BrowserPlaneFrameScheduler,
  ) {}

  /**
   * Keeps only the latest observation and reads/sends it on the next animation
   * frame. A sidebar transition, split drag or window resize may notify more
   * than once before paint; none of those intermediate rectangles should force
   * layout or cross IPC merely to be superseded in the same frame.
   */
  reportBounds(readBounds: BrowserPlaneBoundsReader): void {
    if (this.disposed) return;
    this.pendingBounds = readBounds;
    if (this.boundsFrame !== null) return;
    this.boundsFrame = this.scheduler.request(() => {
      this.boundsFrame = null;
      this.flushBounds();
    });
  }

  /**
   * Answers when main has acted, not when React decided. A caller restoring the
   * plane from under frozen pixels has to know the native view is actually back
   * before it stops painting them, or it paints the themed background into the
   * gap — the flicker that made overlays worse than the hole they replaced.
   * Already-in-that-state settles at once: there is nothing to wait for.
   */
  setVisible(visible: boolean): Promise<void> {
    if (this.disposed) return Promise.resolve();
    const next = visible ? "visible" : "hidden";
    if (this.visibility === next) return Promise.resolve();
    // The first show cannot wait for the scheduled frame: main must receive
    // real geometry before it attaches a native surface over renderer pixels.
    // Later observations remain frame-coalesced.
    if (visible) this.flushBounds();
    this.visibility = next;
    return this.run(
      visible ? this.gateway.show({ tabId: this.tabId }) : this.gateway.hide({ tabId: this.tabId }),
      visible ? "show Browser Tab" : "hide Browser Tab",
    );
  }

  dispose(): void {
    if (this.disposed) return;
    if (this.boundsFrame !== null) {
      this.scheduler.cancel(this.boundsFrame);
      this.boundsFrame = null;
    }
    this.pendingBounds = null;
    if (this.visibility === "visible") {
      // A failed cleanup can leave remote pixels covering the app after React
      // believes the tab is gone. Report this one even after disposal; late
      // failures from older placement/show calls remain irrelevant once their
      // surface has disappeared.
      this.run(this.gateway.hide({ tabId: this.tabId }), "hide Browser Tab", true);
    }
    this.visibility = "hidden";
    this.disposed = true;
  }

  private flushBounds(): void {
    if (this.disposed) return;
    if (this.boundsFrame !== null) {
      this.scheduler.cancel(this.boundsFrame);
      this.boundsFrame = null;
    }
    const readBounds = this.pendingBounds;
    this.pendingBounds = null;
    if (readBounds === null) return;
    const bounds = measuredBounds(readBounds());
    // Main owns exact-bound deduplication because only it sees every placement
    // path (including the page/DevTools split and the initial staged viewport).
    // Caching here can suppress the write that restores a main-moved view to
    // this renderer plane.
    this.run(this.gateway.setBounds({ tabId: this.tabId, bounds }), "place Browser Tab");
  }

  private run(
    operation: Promise<Result>,
    label: string,
    reportAfterDispose = false,
  ): Promise<void> {
    return operation
      .then((result) => {
        if ((!this.disposed || reportAfterDispose) && !result.ok) {
          this.onError(`Could not ${label}: ${result.error}`);
        }
      })
      .catch((error: unknown) => {
        if (this.disposed && !reportAfterDispose) return;
        const detail = error instanceof Error ? error.message : String(error);
        this.onError(`Could not ${label}: ${detail}`);
      });
  }
}
