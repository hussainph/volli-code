import { useEffect } from "react";

import { installOverlayScrollbars } from "@renderer/lib/scroll-thumb/overlay-scrollbars";

/**
 * The app's overlay scroll thumb for this window's document. Mounted once per
 * window root (the app shell and the Settings window); see
 * `lib/scroll-thumb/overlay-scrollbars.ts`.
 */
export function useOverlayScrollbars() {
  useEffect(() => installOverlayScrollbars(document), []);
}
