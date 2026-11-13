/**
 * The schema-upgrade window's mount (VC-1105). Only the app's stylesheet and
 * fonts are loaded; the page itself is in `./page.tsx`, apart from this
 * side-effecting entry so it can be tested.
 */
import "@fontsource-variable/mona-sans/wght.css";
import "@renderer/globals.css";

import { createRoot } from "react-dom/client";

import { UpdatingPage, updatingAppearance } from "./page";

// The window's background is the canvas main painted it with; the page adds
// only its line, in the mode main named.
const appearance = updatingAppearance(window.location.search);
if (appearance !== null) document.documentElement.classList.add(appearance);
document.documentElement.style.background = "transparent";
document.body.style.margin = "0";
document.body.style.background = "transparent";

createRoot(document.getElementById("root")!).render(<UpdatingPage />);
