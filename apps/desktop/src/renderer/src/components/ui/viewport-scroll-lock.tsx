import { RemoveScrollBar } from "react-remove-scroll-bar";

/**
 * The Electron shell is a fixed viewport; reading surfaces own their scrollports.
 * Keep the same scrollbar stylesheet Radix uses resident at that boundary,
 * rather than inserting/removing a global stylesheet on every menu/dialog open.
 * Modal wheel, pointer and focus guards remain owned by their Radix surfaces.
 */
export function ViewportScrollLock() {
  return <RemoveScrollBar />;
}
