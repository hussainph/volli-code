/**
 * The Session cursor overlay's mount (VC-239): `CursorOverlayPage` on the
 * page's one root, over a transparent document. The page itself is in
 * `./page.tsx`, apart from this side-effecting entry so it can be tested.
 *
 * Only the app's stylesheet and fonts are loaded — the tokens the cursor
 * moves on come from `globals.css`, and this page is a second entry in the
 * same build so it cannot drift from them.
 */
import "@fontsource-variable/mona-sans/wght.css";
import "@renderer/globals.css";

import { createRoot } from "react-dom/client";

import type { CursorOverlayBridge } from "../../ipc/cursor-contract";
import { CursorOverlayPage } from "./page";

declare global {
  interface Window {
    volliCursor: CursorOverlayBridge;
  }
}

// The page is transparent: the view behind it is the Browser Tab's page, and
// nothing here may paint over it but the cursor.
document.documentElement.style.background = "transparent";
document.body.style.margin = "0";
document.body.style.overflow = "hidden";
document.body.style.background = "transparent";

createRoot(document.getElementById("root")!).render(
  <CursorOverlayPage bridge={window.volliCursor} />,
);
