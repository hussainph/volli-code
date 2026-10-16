// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import HostAddLiveScratch from "./host-add-live";
import LogViewerScratch from "./log-viewer";

// Exercise the scratch banners, not the production components beneath them.
// Static rendering also leaves the lab's scripted effects and timers unstarted.
vi.mock("@renderer/components/hosts/hosts-chrome", () => ({ HostsChrome: () => null }));
vi.mock("@renderer/components/settings/panes/hosts-pane", () => ({ HostsPane: () => null }));
vi.mock("@renderer/components/logs/log-viewer", () => ({
  LogViewer: () => null,
  LogStream: () => null,
}));
vi.mock("@renderer/lib/app-state-storage", () => ({
  appStateStorage: { getItem: () => null, setItem() {}, removeItem() {} },
}));

describe("simulated wiring banners", () => {
  it.each([
    {
      name: "log viewer",
      Scratch: LogViewerScratch,
      detail:
        "Real log viewer and relay adapter over fixture logs and an in-memory host link; no live host connection.",
    },
    {
      name: "Add a host",
      Scratch: HostAddLiveScratch,
      detail: "Shipped Checklist and Hosts pane over scripted flow events; no SSH or main process.",
    },
  ])("labels the $name fixture boundary before its controls", ({ Scratch, detail }) => {
    const root = document.createElement("div");
    root.innerHTML = renderToStaticMarkup(<Scratch />);
    const banner = root.querySelector('section[aria-label="Simulated wiring"]');
    expect(banner?.querySelector("h2")?.textContent).toBe("Simulated wiring");
    expect(banner?.querySelector("p")?.textContent?.replace(/\s+/g, " ").trim()).toBe(detail);
    expect(banner?.parentElement?.firstElementChild).toBe(banner);
  });
});
