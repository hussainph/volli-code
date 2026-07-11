import "@fontsource-variable/geist-mono/wght.css";
import "@fontsource-variable/mona-sans/wght.css";
import "./globals.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { initTerminalAppearance } from "./terminal/appearance";

// Kick off the Ghostty-config fetch before any terminal exists — engines read
// the resolved appearance synchronously, so the earlier this lands the fewer
// sessions boot on the token fallback (they re-theme live either way).
void initTerminalAppearance();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
