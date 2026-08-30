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

function measuredBounds(rect: BrowserPlaneRect): BrowserTabBounds {
  return {
    x: Math.max(0, Math.round(rect.x)),
    y: Math.max(0, Math.round(rect.y)),
    width: Math.max(0, Math.round(rect.width)),
    height: Math.max(0, Math.round(rect.height)),
  };
}

function sameBounds(left: BrowserTabBounds | null, right: BrowserTabBounds): boolean {
  return (
    left !== null &&
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height
  );
}

/**
 * Imperative lifecycle for one native Browser Tab plane.
 *
 * React owns when the plane exists; this controller owns the ordered messages
 * that fact implies. Keeping it DOM-free makes the meaningful contract testable:
 * bounds land before show, duplicate observations are quiet, and every visible
 * plane hides before its owner disappears.
 */
export class BrowserPlaneController {
  private bounds: BrowserTabBounds | null = null;
  private visibility: "unknown" | "visible" | "hidden" = "unknown";
  private disposed = false;

  constructor(
    private readonly tabId: string,
    private readonly gateway: BrowserPlaneGateway,
    private readonly onError: (message: string) => void,
  ) {}

  reportBounds(rect: BrowserPlaneRect): void {
    if (this.disposed) return;
    const bounds = measuredBounds(rect);
    if (sameBounds(this.bounds, bounds)) return;
    this.bounds = bounds;
    this.run(this.gateway.setBounds({ tabId: this.tabId, bounds }), "place Browser Tab");
  }

  setVisible(visible: boolean): void {
    if (this.disposed) return;
    const next = visible ? "visible" : "hidden";
    if (this.visibility === next) return;
    this.visibility = next;
    this.run(
      visible ? this.gateway.show({ tabId: this.tabId }) : this.gateway.hide({ tabId: this.tabId }),
      visible ? "show Browser Tab" : "hide Browser Tab",
    );
  }

  dispose(): void {
    if (this.disposed) return;
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

  private run(operation: Promise<Result>, label: string, reportAfterDispose = false): void {
    void operation
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
