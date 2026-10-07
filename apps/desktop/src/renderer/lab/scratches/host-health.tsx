/**
 * VC-719: a host's state on screen is the truth about the host, not a guess
 * from its projects. The shipped surfaces (chip, switcher, Island, Running
 * on) over the real app window, fed by a fake source whose fixture records
 * carry the engine's own health: a host with no projects reads connecting,
 * offline or ready from its own link — never open by default — a live tunnel
 * with hostd down reads offline with the reason, an SSH failure names the
 * key, a lost hosts stream says so instead of emptying, and a project the
 * host no longer knows offers Forget.
 *
 * Fixture data only: the links are `HostLinkView`s worded the way the engine
 * and the remote source say them, so the copy here is the copy the app
 * shows. `host-connection.tsx` stages the rest of the state vocabulary.
 */
import * as React from "react";

import { AppShell } from "@renderer/components/app-shell";
import { RunningOnLabel } from "@renderer/components/hosts/running-on-label";
import { useExperimentsStore } from "@renderer/stores/experiments";
import { setRemoteHostsApi } from "@renderer/stores/remote-hosts";
import { createFakeRemoteHostsApi } from "@renderer/stores/remote-hosts.test-support";
import {
  OPEN_LINK,
  THIS_MAC_HOST,
  THIS_MAC_HOST_ID,
  useHostConnectionStore,
  type HostLinkView,
  type HostSourceSnapshot,
} from "@renderer/stores/host-connection";
import {
  createFakeHostSource,
  remoteHost,
  type FakeHostSource,
} from "@renderer/stores/host-sources";

import { appApi, seedApp } from "../seed";

export const title = "Host health — the engine's truth about a host";
export const note =
  "VC-719: no-project and hostd-down hosts read truthfully; failures name their reason";
export const viewport = "window" as const;

/** The app's own stubs, so the shell mounts quiet (see `host-connection.tsx`). */
export const api = {
  ...appApi,
  projects: {
    syncRoots: () => Promise.resolve(),
    checkFolder: (projectId: string) =>
      Promise.resolve({ ok: true, path: `/lab/${projectId}`, state: "present" }),
  },
  shells: { list: () => Promise.resolve({ ok: true, shells: [] }) },
  browser: { list: () => Promise.resolve({ ok: true, tabs: [] }) },
  automations: {
    list: () => Promise.resolve({ ok: true, automations: [] }),
    armings: () => Promise.resolve({ ok: true, armings: [] }),
    columnOrders: () => Promise.resolve({ ok: true, orders: [] }),
    enablement: () => Promise.resolve({ ok: true, enabledAutomationIds: [] }),
    runsForTicket: () => Promise.resolve({ ok: true, runs: [] }),
  },
  notifications: { setActiveTarget: () => {} },
  sessions: {
    ...(appApi["sessions"] as object),
    setRead: () => Promise.resolve({ ok: true, read: { unreadSince: null } }),
  },
  files: {
    ...(appApi["files"] as object),
    index: () => Promise.resolve({ ok: true, files: [], truncated: false }),
    promptTemplates: () => Promise.resolve({ ok: true, templates: [], skills: [] }),
  },
  tickets: {
    ...(appApi["tickets"] as object),
    events: () => Promise.resolve({ ok: true, events: [] }),
  },
  comments: { list: () => Promise.resolve({ ok: true, comments: [] }) },
  attachments: {
    list: () => Promise.resolve({ ok: true, blobs: [] }),
    materialized: () => Promise.resolve({ ok: true, links: [] }),
  },
  sessionRpc: {
    request: (request: { type: string }) =>
      request.type === "subscription"
        ? Promise.resolve({
            ok: true,
            subscriptionId: `lab-${Math.random().toString(36).slice(2)}`,
          })
        : new Promise(() => {}),
    onEvent: () => () => {},
    cancel: () => {},
  },
};
export const seed = seedApp;

const HETZNER = "host-hetzner";
const FARM = "host-farm";
const FRA = "host-fra";
const APP_VERSION = "0.3.0";

/* The engine's own words, as its health probe and the remote source say them
 * (`remote-hosts-health.ts`, `failures.ts`, `remote-host-source.ts`). */
const hostdDown = (host: string): string => `Volli isn't answering on ${host}.`;
const keyUnloaded = (host: string): string =>
  `${host} didn't accept a key from this Mac. Load yours: ssh-add --apple-use-keychain`;
const STREAM_LOST = "Couldn’t read host state: connection failed";

type Scenario = "no-projects" | "hostd-stopped" | "ssh-key" | "stream-lost" | "project-gone";

const SCENARIOS: readonly { value: Scenario; label: string }[] = [
  { value: "no-projects", label: "No projects — connecting · offline · ready" },
  { value: "hostd-stopped", label: "Tunnel up, Volli host not answering" },
  { value: "ssh-key", label: "SSH key not loaded" },
  { value: "stream-lost", label: "Hosts stream failed" },
  { value: "project-gone", label: "Project left the host — Forget" },
];

const HINTS: Readonly<Record<Scenario, string>> = {
  "no-projects":
    "Open the chip: nyc-1 connecting, mac-farm offline, fra-1 ready — none guessed from projects.",
  "hostd-stopped":
    "The tunnel is up; hostd is not. The reason sits under the host in the switcher.",
  "ssh-key": "The key isn't loaded, so Retry lands back offline with the same line.",
  "stream-lost":
    "The switcher says so at the top; hosts read offline instead of emptying. Its Retry re-subscribes.",
  "project-gone": "The host is fine; this project isn't on it any more. The Island offers Forget.",
};

/**
 * hetzner-1 serving Voltaic with one whole-box link: the engine's health for
 * the host, and every Workspace on it reads the same while the box is down.
 */
function serving(hostId: string, name: string, link: HostLinkView): HostSourceSnapshot {
  return {
    hosts: [remoteHost(hostId, name, { version: APP_VERSION, link })],
    projects: { "prj-voltaic": { hostId, link } },
  };
}

/** The honest arrangement for a scenario, rebuilt fresh (its `since` is now). */
function arrangement(scenario: Scenario): HostSourceSnapshot {
  const now = Date.now();
  switch (scenario) {
    case "no-projects":
      // Three hosts, no projects anywhere: each link is the engine's own.
      return {
        hosts: [
          remoteHost(FRA, "fra-1", { version: APP_VERSION, link: { status: "open" } }),
          remoteHost(FARM, "mac-farm", {
            os: "macos",
            link: { status: "offline", since: now - 2 * 3_600_000, retryAt: null },
          }),
          remoteHost(HETZNER, "nyc-1", { link: { status: "connecting" } }),
        ],
        projects: {},
      };
    case "hostd-stopped":
      return serving(HETZNER, "hetzner-1", {
        status: "offline",
        since: now - 30_000,
        retryAt: null,
        detail: hostdDown("hetzner-1"),
      });
    case "ssh-key":
      return serving(HETZNER, "hetzner-1", {
        status: "offline",
        since: now - 10_000,
        retryAt: null,
        detail: keyUnloaded("hetzner-1"),
      });
    case "stream-lost":
      // What the source held before the stream died; `fail` loses it below.
      return serving(HETZNER, "hetzner-1", { status: "open" });
    case "project-gone":
      return {
        hosts: [
          remoteHost(HETZNER, "hetzner-1", { version: APP_VERSION, link: { status: "open" } }),
        ],
        projects: {
          "prj-voltaic": {
            hostId: HETZNER,
            link: {
              status: "incompatible",
              reason: "refused",
              refusalCode: "workspace-unknown",
              workspaceId: "prj-voltaic",
            },
          },
        },
      };
  }
}

/** A snapshot losing its stream: hosts kept, every link offline with why. */
function failed(snapshot: HostSourceSnapshot, message: string): HostSourceSnapshot {
  const link: HostLinkView = {
    status: "offline",
    since: Date.now(),
    retryAt: null,
    detail: message,
  };
  return {
    hosts: snapshot.hosts.map((host) => ({ ...host, link })),
    projects: Object.fromEntries(
      Object.entries(snapshot.projects).map(([id, claim]) => [id, { ...claim, link }]),
    ),
    error: message,
  };
}

/** Where a Retry lands, scripted the way a host would answer. */
function afterRetry(scenario: Scenario, healed: boolean): HostLinkView {
  const now = Date.now();
  if (healed && scenario !== "ssh-key") return { status: "open" };
  switch (scenario) {
    case "hostd-stopped":
      return { status: "offline", since: now, retryAt: null, detail: hostdDown("hetzner-1") };
    case "ssh-key":
      return { status: "offline", since: now, retryAt: null, detail: keyUnloaded("hetzner-1") };
    case "stream-lost":
      return { status: "offline", since: now, retryAt: null, detail: STREAM_LOST };
    case "no-projects":
    case "project-gone":
      return { status: "offline", since: now, retryAt: null };
  }
}

export default function HostHealthScratch() {
  const [scenario, setScenario] = React.useState<Scenario>("hostd-stopped");
  const [retryHeals, setRetryHeals] = React.useState(true);
  const scenarioRef = React.useRef(scenario);
  scenarioRef.current = scenario;
  const healRef = React.useRef(retryHeals);
  healRef.current = retryHeals;
  const timers = React.useRef<number[]>([]);

  const source = React.useMemo<
    FakeHostSource & { fail(message: string): void; retrySubscription(): void }
  >(() => {
    const later = (ms: number, act: () => void) => {
      timers.current.push(window.setTimeout(act, ms));
    };
    const fake = createFakeHostSource(arrangement(scenarioRef.current), (call, it) => {
      if (call.kind !== "retry") return;
      it.setHost(call.hostId, { link: { status: "reconnecting" } });
      later(1_600, () => {
        it.setHost(call.hostId, { link: afterRetry(scenarioRef.current, healRef.current) });
      });
    });
    return {
      ...fake,
      fail: (message: string) => fake.set(failed(fake.getSnapshot(), message)),
      // The switcher's "Retry now" for the source: a re-subscribe that works.
      retrySubscription: () => fake.set(arrangement(scenarioRef.current)),
    };
  }, []);

  React.useEffect(() => {
    // This Mac answers for the rest of the board; a remote claim outranks it.
    const local = createFakeHostSource({
      hosts: [THIS_MAC_HOST],
      projects: Object.fromEntries(
        ["prj-voltaic", "prj-atlas", "prj-harbor"].map((id) => [
          id,
          { hostId: THIS_MAC_HOST_ID, link: OPEN_LINK },
        ]),
      ),
    });
    const detachLocal = useHostConnectionStore.getState().attach(local);
    const detachRemote = useHostConnectionStore.getState().attach(source);
    setRemoteHostsApi({
      ...createFakeRemoteHostsApi(),
      closeWorkspace(hostId, workspaceId) {
        const snapshot = source.getSnapshot();
        source.set({
          ...snapshot,
          projects: Object.fromEntries(
            Object.entries(snapshot.projects).filter(
              ([id, claim]) => id !== workspaceId || claim.hostId !== hostId,
            ),
          ),
        });
        return Promise.resolve(null);
      },
    });
    const pending = timers.current;
    return () => {
      detachLocal();
      detachRemote();
      setRemoteHostsApi(null);
      for (const id of pending) window.clearTimeout(id);
      useExperimentsStore.setState({ snapshot: null });
    };
  }, [source]);

  React.useEffect(() => {
    for (const id of timers.current) window.clearTimeout(id);
    timers.current.length = 0;
    scenarioRef.current = scenario;
    useExperimentsStore.setState({
      snapshot: { cloud: { enabled: true, source: "storage" } },
    });
    if (scenario === "stream-lost") source.fail(STREAM_LOST);
    else source.set(arrangement(scenario));
  }, [scenario, source]);

  return (
    <div className="relative h-svh w-full">
      <AppShell />
      <div className="fixed bottom-20 left-20 z-[9998] flex max-w-sm flex-col items-start gap-2 rounded-xl border border-border bg-popover p-2 font-mono text-label text-muted-foreground uppercase shadow-overlay">
        <span>Lab · VC-719 · hetzner-1 serves Voltaic</span>
        <select
          aria-label="Host state"
          value={scenario}
          onChange={(event) => setScenario(event.target.value as Scenario)}
          className="rounded-md border border-border bg-background px-2 py-1 text-ui normal-case"
        >
          {SCENARIOS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <span className="normal-case">{HINTS[scenario]}</span>
        <label className="flex items-center gap-2 normal-case">
          <input
            type="checkbox"
            checked={retryHeals}
            onChange={(event) => setRetryHeals(event.target.checked)}
          />
          Retry comes back
        </label>
        <span className="flex items-center gap-2 normal-case">
          Label: <RunningOnLabel projectId="prj-voltaic" className="font-sans" />
        </span>
      </div>
    </div>
  );
}
