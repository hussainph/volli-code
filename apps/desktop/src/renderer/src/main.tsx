import "@fontsource-variable/geist-mono/wght.css";
import "@fontsource-variable/mona-sans/wght.css";
import "./globals.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { errorMessage } from "@volli/shared";
import { WarningCircleIcon } from "@phosphor-icons/react/dist/csr/WarningCircle";

import App from "./App";
import { boot } from "./lib/boot";
import { initTerminalAppearance } from "./terminal/appearance";

/** Full-window failure panel — mirrors the app's empty-state styling (see files-page.tsx). */
function BootErrorPanel({ error }: { error: string }) {
  return (
    <div className="flex h-svh w-full flex-col items-center justify-center gap-2 bg-background text-center">
      <WarningCircleIcon weight="fill" className="size-8 text-muted-foreground" />
      <h2 className="text-lg font-semibold text-foreground">Volli couldn't load its data</h2>
      <p className="max-w-md text-sm text-muted-foreground">{error}</p>
    </div>
  );
}

async function main() {
  const root = createRoot(document.getElementById("root")!);

  // Kick off the Ghostty-config fetch immediately, CONCURRENT with boot() —
  // it has no dependency on the SQLite bootstrap, and gating it behind the
  // boot round-trip needlessly widens the window where a terminal's first
  // paint lands on the token fallback (they re-theme live either way).
  void initTerminalAppearance();

  // boot() returns { ok: false } for a failed bootstrap; the catch covers the
  // unexpected throw (e.g. a corrupt pref blob exploding during rehydrate) so
  // a boot failure can never strand a blank window.
  let result: Awaited<ReturnType<typeof boot>>;
  try {
    result = await boot();
  } catch (error) {
    result = { ok: false, error: errorMessage(error) };
  }
  if (!result.ok) {
    root.render(<BootErrorPanel error={result.error} />);
    return;
  }

  root.render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void main();
