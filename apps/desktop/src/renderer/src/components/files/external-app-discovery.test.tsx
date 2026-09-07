// @vitest-environment jsdom
/**
 * The one discovery state Files and Integrations share (VC-287).
 *
 * The defect this file exists to hold shut is not the JXA stream bug itself
 * but its second half: a scan that could not run was rendered as a scan that
 * completed and found nothing. So the interesting assertions here are all
 * about the FAILED branch — that it keeps the apps a previous scan confirmed,
 * that it never reconciles the saved default from a result it does not have,
 * and that it is distinguishable from an empty list.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { ExternalApp, ExternalAppListResult } from "../../../../ipc/contract";
import { useUiStore } from "@renderer/stores/ui";
import {
  ExternalAppsProvider,
  useExternalAppDiscovery,
  useExternalApps,
} from "./external-app-discovery";
import {
  nextExternalAppDiscovery,
  type ExternalAppDiscovery,
} from "./external-app-discovery-model";

const TERMINAL: ExternalApp = { id: "terminal", label: "Terminal", kind: "terminal" };
const ZED: ExternalApp = { id: "zed", label: "Zed", kind: "editor" };

describe("nextExternalAppDiscovery", () => {
  it("keeps the last confirmed apps when a scan fails", () => {
    const confirmed: ExternalAppDiscovery = { status: "ready", apps: [TERMINAL, ZED] };

    const failed = nextExternalAppDiscovery(confirmed, {
      kind: "failed",
      message: "Couldn't check which apps are installed on this Mac.",
    });

    expect(failed).toEqual({
      status: "failed",
      apps: [TERMINAL, ZED],
      message: "Couldn't check which apps are installed on this Mac.",
    });
  });

  it("replaces the list only from a completed scan", () => {
    const failed: ExternalAppDiscovery = {
      status: "failed",
      apps: [TERMINAL],
      message: "boom",
    };

    expect(nextExternalAppDiscovery(failed, { kind: "scanned", apps: [ZED] })).toEqual({
      status: "ready",
      apps: [ZED],
    });
    expect(nextExternalAppDiscovery(failed, { kind: "scanned", apps: [] })).toEqual({
      status: "ready",
      apps: [],
    });
  });

  it("holds the confirmed apps on screen while a rescan is in flight", () => {
    const confirmed: ExternalAppDiscovery = { status: "ready", apps: [TERMINAL] };

    expect(nextExternalAppDiscovery(confirmed, { kind: "started" })).toEqual({
      status: "scanning",
      apps: [TERMINAL],
    });
  });
});

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

/** A queue of answers, one per `listExternalApps()` call, in call order. */
function bridge(answers: readonly (ExternalAppListResult | Error)[]) {
  const calls = { count: 0 };
  const listExternalApps = vi.fn(async (): Promise<ExternalAppListResult> => {
    const answer = answers[calls.count] ?? answers.at(-1);
    calls.count += 1;
    if (answer instanceof Error) throw answer;
    return answer as ExternalAppListResult;
  });
  vi.stubGlobal("api", {
    files: { listExternalApps },
    appState: { set: vi.fn(async () => ({ ok: true }) as const) },
  });
  return { listExternalApps, calls };
}

interface Probe {
  apps: readonly ExternalApp[];
  discovery: ExternalAppDiscovery;
  rescan: () => void;
}

async function mount(): Promise<() => Probe> {
  const seen: Probe[] = [];
  function Reader() {
    const apps = useExternalApps();
    const { discovery, rescan } = useExternalAppDiscovery();
    seen.push({ apps, discovery, rescan });
    return null;
  }
  await act(async () => {
    root?.render(
      <ExternalAppsProvider>
        <Reader />
      </ExternalAppsProvider>,
    );
  });
  return () => seen.at(-1)!;
}

describe("ExternalAppsProvider", () => {
  it("publishes a completed scan to every Files surface", async () => {
    bridge([{ ok: true, apps: [TERMINAL, ZED] }]);

    const latest = await mount();

    expect(latest().discovery.status).toBe("ready");
    expect(latest().apps).toEqual([TERMINAL, ZED]);
  });

  it("keeps confirmed apps and the saved default when a refresh fails", async () => {
    bridge([{ ok: true, apps: [TERMINAL, ZED] }, new Error("osascript exited with 1")]);
    useUiStore.setState({ defaultExternalAppId: "zed" });

    const latest = await mount();
    await act(async () => latest().rescan());

    // A failed inspection says nothing about what is installed: the menu keeps
    // what it knows and the preference is not reconciled away.
    expect(latest().apps).toEqual([TERMINAL, ZED]);
    expect(latest().discovery.status).toBe("failed");
    expect(useUiStore.getState().defaultExternalAppId).toBe("zed");
  });

  it("keeps the saved default when the scan comes back as a refused result", async () => {
    bridge([
      { ok: true, apps: [ZED] },
      { ok: false, error: "Couldn't check which apps are installed on this Mac." },
    ]);
    useUiStore.setState({ defaultExternalAppId: "zed" });

    const latest = await mount();
    await act(async () => latest().rescan());

    const discovery = latest().discovery;
    expect(discovery.status).toBe("failed");
    expect(discovery.status === "failed" ? discovery.message : "").toBe(
      "Couldn't check which apps are installed on this Mac.",
    );
    expect(latest().apps).toEqual([ZED]);
    expect(useUiStore.getState().defaultExternalAppId).toBe("zed");
  });

  it("does not call a first failure a completed empty scan", async () => {
    bridge([new Error("Launch Services unavailable")]);
    useUiStore.setState({ defaultExternalAppId: "terminal" });

    const latest = await mount();

    // Finder is still the safe fallback below (no apps), but the state itself
    // must not read as "this Mac has no supported apps".
    expect(latest().apps).toEqual([]);
    expect(latest().discovery.status).toBe("failed");
    expect(useUiStore.getState().defaultExternalAppId).toBe("terminal");
  });

  it("drops a slow scan that a newer rescan has superseded", async () => {
    // The reducer alone cannot hold this line: a stale `scanned` would replace
    // a newer answer with an older one. The request token has to drop it, and
    // the reconcile must not run on the dropped evidence either.
    const { promise: first, resolve: answerFirst } = Promise.withResolvers<ExternalAppListResult>();
    const listExternalApps = vi
      .fn<() => Promise<ExternalAppListResult>>()
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce({ ok: true, apps: [TERMINAL, ZED] });
    vi.stubGlobal("api", {
      files: { listExternalApps },
      appState: { set: vi.fn(async () => ({ ok: true }) as const) },
    });
    useUiStore.setState({ defaultExternalAppId: "zed" });

    const latest = await mount();
    expect(latest().discovery.status).toBe("scanning");
    await act(async () => latest().rescan());
    expect(latest().apps).toEqual([TERMINAL, ZED]);
    expect(latest().discovery.status).toBe("ready");

    // The boot scan answers late and without Zed. Applied, it would shorten
    // the menu AND reconcile the saved default away; dropped, neither moves.
    await act(async () => {
      answerFirst({ ok: true, apps: [TERMINAL] });
      await first;
    });
    expect(latest().apps).toEqual([TERMINAL, ZED]);
    expect(latest().discovery.status).toBe("ready");
    expect(useUiStore.getState().defaultExternalAppId).toBe("zed");
  });

  it("reconciles a default whose app a completed scan no longer finds", async () => {
    bridge([{ ok: true, apps: [TERMINAL] }]);
    useUiStore.setState({ defaultExternalAppId: "zed" });

    await mount();

    expect(useUiStore.getState().defaultExternalAppId).toBeNull();
  });
});
