/**
 * VC-576: the host chip, its switcher, the connection Island, the chip's
 * badge and "Running on" — the shipped components, staged over the real app
 * window with the `cloud` flag on and a fake host source behind them.
 *
 * The VC-615 `#host-health` scratch (PR #745) is the design this ports; this
 * one is for reviewing the port. Pick a state in the lab bar: Voltaic runs on
 * hetzner-1, Atlas on This Mac, Harbor on mac-mini. Retry now and Update host
 * are scripted the way a host would answer: a retry comes back (or stays
 * down), an update downloads, restarts and lands with its toast.
 */
import * as React from "react";

import { AppShell } from "@renderer/components/app-shell";
import { RunningOnLabel } from "@renderer/components/hosts/running-on-label";
import { useExperimentsStore } from "@renderer/stores/experiments";
import {
  THIS_MAC_HOST,
  THIS_MAC_HOST_ID,
  useHostConnectionStore,
  type HostRecord,
} from "@renderer/stores/host-connection";
import {
  createFakeHostSource,
  hostSnapshot,
  remoteHost,
  type FakeHostCall,
  type FakeHostSource,
} from "@renderer/stores/host-sources";

import { appApi, seedApp } from "../seed";

export const title = "Host connection — chip, switcher, Island, Running on";
export const note = "VC-576: the shipped host surfaces over the real shell, fed by a fake source";
export const viewport = "window" as const;
/**
 * The app's own stubs plus what this window reaches on load and when a
 * Session opens. Left unstubbed, their failure toasts sat over the Island this
 * scratch exists to show, and a Session's stream died on a bridge the fake
 * could not spread (`bridge.request is not a function`).
 */
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
  // What opening a Session reaches. Empty, and quiet, rather than a toast
  // apiece over the composer and the Island above it.
  sessions: {
    ...(appApi["sessions"] as object),
    setRead: () => Promise.resolve({ ok: true, read: { unreadSince: null } }),
  },
  files: {
    ...(appApi["files"] as object),
    index: () => Promise.resolve({ ok: true, files: [], truncated: false }),
    promptTemplates: () => Promise.resolve({ ok: true, templates: [], skills: [] }),
  },
  // An opened ticket's Activity feed: empty and quiet.
  tickets: {
    ...(appApi["tickets"] as object),
    events: () => Promise.resolve({ ok: true, events: [] }),
  },
  comments: { list: () => Promise.resolve({ ok: true, comments: [] }) },
  attachments: {
    list: () => Promise.resolve({ ok: true, blobs: [] }),
    materialized: () => Promise.resolve({ ok: true, links: [] }),
  },
  // The Session RPC bridge, named so the client's `{ ...bridge }` keeps its
  // members. There is no host behind the lab, so a Session's stream is
  // acknowledged and then stays quiet, and a query waits: the Session reads
  // as still loading — the truth here — instead of toasting a lost stream
  // over the composer this scratch is reviewing.
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
const MINI = "host-mini";
const APP_VERSION = "0.3.0";

type Scenario =
  | "online"
  | "reconnecting"
  | "offline"
  | "update"
  | "too-old"
  | "refusing"
  | "newer"
  | "sign-in"
  | "refused"
  | "flag-off";

const SCENARIOS: readonly { value: Scenario; label: string }[] = [
  { value: "online", label: "Online" },
  { value: "reconnecting", label: "Reconnecting (blip)" },
  { value: "offline", label: "Offline → read-only" },
  { value: "update", label: "Host older · update available" },
  { value: "too-old", label: "Host too old to connect" },
  { value: "refusing", label: "Database from a newer Volli" },
  { value: "newer", label: "Host newer than this app" },
  { value: "sign-in", label: "Sign-in expired on host" },
  { value: "refused", label: "Host refuses this Mac" },
  { value: "flag-off", label: "Flag off (nothing renders)" },
];

function hetzner(scenario: Scenario, now: number): Partial<Omit<HostRecord, "id" | "name">> {
  const base = { liveSessions: 2, version: APP_VERSION, update: null, expiredSignIns: [] };
  switch (scenario) {
    case "reconnecting":
      return { ...base, link: { status: "reconnecting" } };
    case "offline":
      return { ...base, link: { status: "offline", since: now, retryAt: now + 8_000 } };
    case "update":
      return {
        ...base,
        version: "0.2.4",
        link: { status: "version-skewed", availableVersion: APP_VERSION },
      };
    case "too-old":
      return {
        ...base,
        version: "0.1.8",
        link: { status: "incompatible", reason: "host-too-old", requiredVersion: APP_VERSION },
      };
    case "refusing":
      return {
        ...base,
        version: "0.2.9",
        link: { status: "incompatible", reason: "database-too-new" },
      };
    case "newer":
      return {
        ...base,
        version: "0.4.0",
        link: { status: "incompatible", reason: "host-too-new" },
      };
    case "sign-in":
      return {
        ...base,
        link: { status: "open" },
        expiredSignIns: [{ providerId: "anthropic", name: "Claude" }],
      };
    case "refused":
      return { ...base, link: { status: "incompatible", reason: "refused" } };
    case "online":
    case "flag-off":
      return { ...base, link: { status: "open" } };
  }
}

export default function HostConnectionScratch() {
  const [scenario, setScenario] = React.useState<Scenario>("offline");
  const [retrySucceeds, setRetrySucceeds] = React.useState(true);
  const retryRef = React.useRef(retrySucceeds);
  retryRef.current = retrySucceeds;
  const timers = React.useRef<number[]>([]);

  const source = React.useMemo<FakeHostSource>(() => {
    const later = (ms: number, act: () => void) => {
      timers.current.push(window.setTimeout(act, ms));
    };
    const onCall = (call: FakeHostCall, fake: FakeHostSource) => {
      if (call.kind === "retry") {
        fake.setHost(call.hostId, { link: { status: "reconnecting" } });
        later(1_600, () => {
          if (retryRef.current) {
            fake.setHost(call.hostId, { link: { status: "open" } });
          } else {
            const now = Date.now();
            fake.setHost(call.hostId, {
              link: { status: "offline", since: now, retryAt: now + 16_000 },
            });
          }
        });
      } else if (call.kind === "updateHost") {
        if (call.when === "when-idle") {
          fake.setHost(call.hostId, { update: { status: "scheduled" } });
          return;
        }
        let progress = 0;
        const step = () => {
          progress = Math.min(1, progress + 0.08);
          fake.setHost(call.hostId, {
            update: { status: "running", progress, targetVersion: APP_VERSION },
          });
          if (progress < 1) later(140, step);
          else
            later(1_100, () =>
              fake.setHost(call.hostId, {
                update: null,
                version: APP_VERSION,
                link: { status: "open" },
              }),
            );
        };
        step();
      } else if (call.kind === "cancelScheduledUpdate") {
        fake.setHost(call.hostId, { update: null });
      } else {
        fake.setHost(call.hostId, { expiredSignIns: [] });
      }
    };
    return createFakeHostSource(
      hostSnapshot(
        [
          remoteHost(HETZNER, "hetzner-1", hetzner("offline", Date.now())),
          remoteHost(MINI, "mac-mini", {
            os: "macos",
            link: { status: "offline", since: Date.now() - 2 * 3_600_000, retryAt: null },
          }),
        ],
        { "prj-voltaic": HETZNER, "prj-harbor": MINI },
      ),
      onCall,
    );
  }, []);

  React.useEffect(() => {
    const local = createFakeHostSource(
      hostSnapshot([THIS_MAC_HOST], {
        "prj-voltaic": THIS_MAC_HOST_ID,
        "prj-atlas": THIS_MAC_HOST_ID,
        "prj-harbor": THIS_MAC_HOST_ID,
      }),
    );
    const detachLocal = useHostConnectionStore.getState().attach(local);
    const detachRemote = useHostConnectionStore.getState().attach(source);
    const pending = timers.current;
    return () => {
      detachLocal();
      detachRemote();
      for (const id of pending) window.clearTimeout(id);
      useExperimentsStore.setState({ snapshot: null });
    };
  }, [source]);

  React.useEffect(() => {
    useExperimentsStore.setState({
      snapshot: { cloud: { enabled: scenario !== "flag-off", source: "storage" } },
    });
    source.setHost(HETZNER, hetzner(scenario, Date.now()));
  }, [scenario, source]);

  return (
    <div className="relative h-svh w-full">
      <AppShell />
      <div className="fixed bottom-20 left-20 z-[9998] flex flex-col items-start gap-2 rounded-xl border border-border bg-popover p-2 font-mono text-label text-muted-foreground uppercase shadow-overlay">
        <span>Lab · hetzner-1 serves Voltaic</span>
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
        <label className="flex items-center gap-2 normal-case">
          <input
            type="checkbox"
            checked={retrySucceeds}
            onChange={(event) => setRetrySucceeds(event.target.checked)}
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
