// @vitest-environment jsdom
/**
 * Settings → Integrations against the three outcomes of an app scan (VC-287).
 *
 * "Volli found no supported apps on this Mac." is a claim about the Mac, so it
 * belongs to exactly one outcome: a scan that ran to the end and found none.
 * A scan that could not run says something else and offers the one recovery.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { ExternalApp, ExternalAppListResult } from "../../../../../ipc/contract";
import {
  ExternalAppsProvider,
  useExternalAppDiscovery,
} from "@renderer/components/files/external-app-discovery";
import { useUiStore } from "@renderer/stores/ui";

import { IntegrationsPane } from "./integrations-pane";

const TERMINAL: ExternalApp = { id: "terminal", label: "Terminal", kind: "terminal" };
const SCAN_FAILED = "Couldn't check which apps are installed on this Mac.";
const NO_APPS = "Volli found no supported apps on this Mac.";

let root: Root | null = null;
let container: HTMLElement | null = null;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  useUiStore.setState({ defaultExternalAppId: null });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  root = null;
  container?.remove();
  container = null;
  vi.unstubAllGlobals();
});

/**
 * What main answers right now. A handle rather than a queue because opening
 * Settings deliberately looks again — the pane's own mount scan supersedes the
 * provider's boot scan — so the test says what the machine reports, not how
 * many times it is asked.
 */
function bridge(answer: ExternalAppListResult | Error) {
  const current = { answer };
  const listExternalApps = vi.fn(async (): Promise<ExternalAppListResult> => {
    if (current.answer instanceof Error) throw current.answer;
    return current.answer;
  });
  vi.stubGlobal("api", {
    files: { listExternalApps },
    appState: { set: vi.fn(async () => ({ ok: true }) as const) },
  });
  return {
    listExternalApps,
    answers: (next: ExternalAppListResult | Error) => {
      current.answer = next;
    },
  };
}

/**
 * Opens the pane inside the app-wide provider, and hands back the same rescan
 * every other Files surface would see — the way a refresh reaches this pane
 * without a click on its own Try again.
 */
async function open(): Promise<{ rescan: () => void }> {
  const handle = { rescan: () => {} };
  function Elsewhere() {
    handle.rescan = useExternalAppDiscovery().rescan;
    return null;
  }
  await act(async () => {
    root?.render(
      <ExternalAppsProvider>
        <Elsewhere />
        <IntegrationsPane />
      </ExternalAppsProvider>,
    );
  });
  return handle;
}

function text(): string {
  return container?.textContent ?? "";
}

function tryAgain(): HTMLButtonElement {
  const button = [...(container?.querySelectorAll("button") ?? [])].find(
    (candidate) => candidate.textContent?.trim() === "Try again",
  );
  if (button === undefined) throw new Error(`no Try again button in: ${text()}`);
  return button as HTMLButtonElement;
}

describe("IntegrationsPane", () => {
  it("offers one Try again when the scan could not run", async () => {
    const main = bridge({ ok: false, error: SCAN_FAILED });

    await open();

    expect(text()).toContain(SCAN_FAILED);
    expect(text()).not.toContain(NO_APPS);
    expect(container?.querySelector("[role='alert']")).not.toBeNull();
    // One recovery action, not one per row.
    expect(
      [...(container?.querySelectorAll("button") ?? [])].filter(
        (button) => button.textContent?.trim() === "Try again",
      ),
    ).toHaveLength(1);

    const before = main.listExternalApps.mock.calls.length;
    main.answers({ ok: true, apps: [TERMINAL] });
    await act(async () => tryAgain().click());

    expect(main.listExternalApps.mock.calls.length).toBeGreaterThan(before);
    expect(text()).toContain("Terminal");
    expect(text()).not.toContain(SCAN_FAILED);
  });

  it("keeps showing the chosen default while a scan is failing", async () => {
    const main = bridge({ ok: true, apps: [TERMINAL] });
    useUiStore.setState({ defaultExternalAppId: "terminal" });

    const handle = await open();
    main.answers(new Error("osascript exited with 1"));
    await act(async () => handle.rescan());

    // The preference is intact, so the control must not quietly read back as
    // "Ask every time" — that looks like the choice was thrown away.
    expect(container?.querySelector("#open-files-in")?.textContent).toBe("Terminal");
    expect(text()).toContain("osascript exited with 1");
    expect(useUiStore.getState().defaultExternalAppId).toBe("terminal");
  });

  it("says the Mac has no supported apps only after a completed scan", async () => {
    bridge({ ok: true, apps: [] });

    await open();

    expect(text()).toContain(NO_APPS);
  });

  it("lists the apps a completed scan found", async () => {
    bridge({ ok: true, apps: [TERMINAL, { id: "zed", label: "Zed", kind: "editor" }] });

    await open();

    expect(text()).toContain("Terminal");
    expect(text()).toContain("Zed");
    expect(text()).not.toContain(NO_APPS);
  });
});
