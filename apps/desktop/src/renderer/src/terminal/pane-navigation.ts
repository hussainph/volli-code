import type { SessionLayout } from "@renderer/stores/sessions";

export type TerminalFocusDirection = "left" | "right" | "up" | "down";

interface PaneBounds {
  sessionId: string;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

type DirectionMetrics = readonly [primaryGap: number, crossGap: number, centerDistance: number];

/**
 * Find the visually adjacent split leaf in one direction. Split ratios are
 * respected, so nested/uneven layouts navigate by geometry rather than tree
 * insertion order. Returns null at an outer edge (navigation never wraps).
 */
export function adjacentPaneId(
  layout: SessionLayout,
  activePaneId: string,
  direction: TerminalFocusDirection,
): string | null {
  const panes: PaneBounds[] = [];
  collectPaneBounds(layout, { minX: 0, minY: 0, maxX: 1, maxY: 1 }, panes);
  const active = panes.find((pane) => pane.sessionId === activePaneId);
  if (active === undefined) return null;

  let best: { id: string; metrics: DirectionMetrics } | null = null;
  for (const candidate of panes) {
    if (candidate.sessionId === activePaneId) continue;
    const metrics = directionalMetrics(active, candidate, direction);
    if (metrics === null) continue;
    if (best === null || compareMetrics(metrics, best.metrics) < 0) {
      best = { id: candidate.sessionId, metrics };
    }
  }
  return best?.id ?? null;
}

function collectPaneBounds(
  layout: SessionLayout,
  bounds: Omit<PaneBounds, "sessionId">,
  panes: PaneBounds[],
): void {
  if (layout.kind === "pane") {
    panes.push({ sessionId: layout.sessionId, ...bounds });
    return;
  }

  if (layout.direction === "vertical") {
    const splitX = bounds.minX + (bounds.maxX - bounds.minX) * layout.ratio;
    collectPaneBounds(layout.first, { ...bounds, maxX: splitX }, panes);
    collectPaneBounds(layout.second, { ...bounds, minX: splitX }, panes);
    return;
  }

  const splitY = bounds.minY + (bounds.maxY - bounds.minY) * layout.ratio;
  collectPaneBounds(layout.first, { ...bounds, maxY: splitY }, panes);
  collectPaneBounds(layout.second, { ...bounds, minY: splitY }, panes);
}

function directionalMetrics(
  active: PaneBounds,
  candidate: PaneBounds,
  direction: TerminalFocusDirection,
): DirectionMetrics | null {
  if (direction === "left") {
    if (candidate.maxX > active.minX) return null;
    return [
      active.minX - candidate.maxX,
      intervalGap(active.minY, active.maxY, candidate.minY, candidate.maxY),
      Math.abs(center(active.minY, active.maxY) - center(candidate.minY, candidate.maxY)),
    ];
  }
  if (direction === "right") {
    if (candidate.minX < active.maxX) return null;
    return [
      candidate.minX - active.maxX,
      intervalGap(active.minY, active.maxY, candidate.minY, candidate.maxY),
      Math.abs(center(active.minY, active.maxY) - center(candidate.minY, candidate.maxY)),
    ];
  }
  if (direction === "up") {
    if (candidate.maxY > active.minY) return null;
    return [
      active.minY - candidate.maxY,
      intervalGap(active.minX, active.maxX, candidate.minX, candidate.maxX),
      Math.abs(center(active.minX, active.maxX) - center(candidate.minX, candidate.maxX)),
    ];
  }
  if (candidate.minY < active.maxY) return null;
  return [
    candidate.minY - active.maxY,
    intervalGap(active.minX, active.maxX, candidate.minX, candidate.maxX),
    Math.abs(center(active.minX, active.maxX) - center(candidate.minX, candidate.maxX)),
  ];
}

function intervalGap(aMin: number, aMax: number, bMin: number, bMax: number): number {
  if (aMax < bMin) return bMin - aMax;
  if (bMax < aMin) return aMin - bMax;
  return 0;
}

const center = (min: number, max: number): number => (min + max) / 2;

function compareMetrics(a: DirectionMetrics, b: DirectionMetrics): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}
