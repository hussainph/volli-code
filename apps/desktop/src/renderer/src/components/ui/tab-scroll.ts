/**
 * The one mouse-wheel convention a horizontally overflowing tab strip owns.
 *
 * A trackpad's sideways gesture already supplies a dominant `deltaX`, which
 * the browser can scroll natively. A mouse wheel needs Shift held to say the
 * same thing — matching the board canvas without hijacking ordinary vertical
 * scrolling elsewhere in the workspace.
 */
export interface TabWheelInput {
  readonly deltaX: number;
  readonly deltaY: number;
  readonly shiftKey: boolean;
}

export function tabWheelScrollDelta({ deltaX, deltaY, shiftKey }: TabWheelInput): number | null {
  if (!shiftKey || deltaY === 0 || Math.abs(deltaX) > Math.abs(deltaY)) return null;
  return deltaY;
}

/** The small DOM seam the strip's native wheel listener needs. */
export interface TabScrollport {
  readonly clientWidth: number;
  readonly scrollWidth: number;
  scrollLeft: number;
}

export interface TabWheelEvent extends TabWheelInput {
  preventDefault(): void;
}

/**
 * Apply a Shift+wheel gesture only when tabs actually overflow.
 *
 * Returning whether the event was claimed keeps the boundary explicit: a
 * short strip and every non-horizontal intent remain the browser's to handle.
 */
export function scrollTabsWithWheel(scrollport: TabScrollport, event: TabWheelEvent): boolean {
  const delta = tabWheelScrollDelta(event);
  if (delta === null || scrollport.scrollWidth <= scrollport.clientWidth) return false;
  event.preventDefault();
  scrollport.scrollLeft += delta;
  return true;
}
