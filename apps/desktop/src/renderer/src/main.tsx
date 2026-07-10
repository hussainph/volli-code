import "@fontsource-variable/geist-mono/wght.css";
import "@fontsource-variable/mona-sans/wght.css";
import "./globals.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
