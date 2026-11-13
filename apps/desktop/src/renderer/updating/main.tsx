/**
 * The mount of the page a launch shows while its database work runs (VC-1105,
 * VC-1203). Only the app's stylesheet and fonts are loaded; the page itself is
 * in `./page.tsx`, apart from this side-effecting entry so it can be tested.
 */
import "@fontsource-variable/mona-sans/wght.css";
import "@renderer/globals.css";

import { createRoot } from "react-dom/client";

import { UpdatingPage, updatingAppearance, updatingBackground, updatingWork } from "./page";

// The page is the window's own background, as main named it: left
// transparent, Chromium paints its default canvas for the mode instead. The
// page adds only its line, in the mode main named.
const appearance = updatingAppearance(window.location.search);
if (appearance !== null) document.documentElement.classList.add(appearance);
document.documentElement.style.background =
  updatingBackground(window.location.search) ?? "transparent";
document.body.style.margin = "0";
document.body.style.background = "transparent";

createRoot(document.getElementById("root")!).render(
  <UpdatingPage work={updatingWork(window.location.search)} />,
);
