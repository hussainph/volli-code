/**
 * VC-700 PR 3: the shipped Add-a-host Checklist and Settings → Hosts, staged
 * with the `cloud` flag on and a scripted desktop main behind them. The
 * VC-615 `#host-add` and `#host-manage` scratches (PR #745) are the design;
 * this one is for reviewing the port.
 *
 * Scenarios: Straight through; Unknown host key; Needs a sudo password (or
 * "Install for my account only", which lands a user-mode host whose agents
 * share your account); An older Volli host is there; Already paired; The
 * host's identity changed; A Mac (finishes with "Starts when you log in" and
 * "Agents share your account"); Can't reach it (a failure, then Try again);
 * Hosts file from a newer Volli (read-only: no Add, Rename or Forget).
 * Settings → Hosts below lists This Mac and every host; open one for its
 * page (facts, projects, devices with a revoked one last) and Forget.
 *
 * Pick a scenario, then "Add a host…". The script plays main's part: it
 * opens with one replay, moves step by step, stops on the scenario's question
 * or failure, and carries on when it is answered or retried. A flow that
 * finishes lands its host in Settings → Hosts below. Nothing reaches SSH or
 * main: the API is `createFakeRemoteHostsApi`, driven by timers.
 */
import * as React from "react";
import type { AddHostLogLine, AddHostStepId, AddHostView, RemoteHost } from "@volli/shared";

import { HostsChrome } from "@renderer/components/hosts/hosts-chrome";
import { openAddHostSheet } from "@renderer/components/hosts/host-entry";
import { HostsPane } from "@renderer/components/settings/panes/hosts-pane";
import { TooltipProvider } from "@renderer/components/ui/tooltip";
import { useExperimentsStore } from "@renderer/stores/experiments";
import { setRemoteHostsApi, useRemoteHostsStore } from "@renderer/stores/remote-hosts";
import {
  createFakeRemoteHostsApi,
  flowView,
  registryHost,
} from "@renderer/stores/remote-hosts.test-support";

export const title = "Add a host — the shipped Checklist and Settings → Hosts";
export const note =
  "VC-700 PR 3: the real sheet and pane over a scripted main (every question, a failure, a Mac, read-only)";

type Scenario =
  | "happy"
  | "host-key"
  | "sudo"
  | "existing"
  | "paired"
  | "identity"
  | "mac"
  | "fails"
  | "read-only";

const SCENARIOS: readonly { value: Scenario; label: string }[] = [
  { value: "happy", label: "Straight through" },
  { value: "host-key", label: "Unknown host key" },
  { value: "sudo", label: "Needs a sudo password (or: my account only)" },
  { value: "existing", label: "An older Volli host is there" },
  { value: "paired", label: "Already paired with this Mac" },
  { value: "identity", label: "The host’s identity changed" },
  { value: "mac", label: "A Mac (starts at login, runs as you)" },
  { value: "fails", label: "Can’t reach it (then retry)" },
  { value: "read-only", label: "Hosts file from a newer Volli" },
];

const STEPS: readonly AddHostStepId[] = [
  "connect",
  "probe",
  "deliver",
  "install",
  "start",
  "enroll",
  "link",
];

const STEP_MS = 650;
const READ_ONLY = "This Mac’s hosts file is from a newer Volli.";

const EXISTING: RemoteHost = registryHost({
  id: "6f6a3a8e-2b1c-4d5e-8f90-1a2b3c4d5e6f",
  name: "hetzner-1",
  target: "deploy@hetzner-1",
});

const line = (message: string, fields: AddHostLogLine["fields"] = {}): AddHostLogLine => ({
  at: new Date().toISOString(),
  level: "info",
  message,
  fields,
});

/** Where the scenario stops before it can finish, once; `null` runs straight through. */
function stopFor(scenario: Scenario, step: AddHostStepId): Partial<AddHostView> | null {
  if (scenario === "host-key" && step === "connect") {
    return {
      status: "question",
      question: {
        id: "q1",
        kind: "host-key",
        step: "connect",
        offer: {
          entries: ["box ssh-ed25519 AAAAC3Nza…"],
          fingerprints: [{ type: "ED25519", fingerprint: "SHA256:k3Vq9bS0nq2lKc0sZ7uA1XcB" }],
        },
      },
    };
  }
  if (scenario === "sudo" && step === "install") {
    return {
      status: "question",
      question: {
        id: "q1",
        kind: "sudo-password",
        step: "install",
        reason: "install",
        command: "sudo volli-hostd install --system",
        retry: false,
      },
    };
  }
  if (scenario === "existing" && step === "probe") {
    return {
      status: "question",
      question: {
        id: "q1",
        kind: "existing-hostd",
        step: "probe",
        version: "0.2.4",
        mode: "system",
        adoptable: true,
      },
    };
  }
  if (scenario === "paired" && step === "probe") {
    return {
      status: "question",
      question: {
        id: "q1",
        kind: "already-paired",
        step: "probe",
        hostId: "6f6a3a8e-2b1c-4d5e-8f90-1a2b3c4d5e6f",
      },
    };
  }
  if (scenario === "identity" && step === "enroll") {
    return {
      status: "question",
      question: {
        id: "q1",
        kind: "identity-changed",
        step: "enroll",
        pinned: "6f6a3a8e-2b1c-4d5e-8f90-1a2b3c4d5e6f",
        hostId: "7f6a3a8e-2b1c-4d5e-8f90-1a2b3c4d5e6f",
      },
    };
  }
  if (scenario === "fails" && step === "connect") {
    return {
      status: "failed",
      failure: {
        code: "unreachable",
        step: "connect",
        line: "Couldn’t reach deploy@box",
        recovery: { action: "retry", label: "Try again", from: "connect" },
        detail: "ssh: connect to host box port 22: Connection refused",
      },
    };
  }
  return null;
}

export default function HostAddLiveScratch() {
  const [scenario, setScenario] = React.useState<Scenario>("host-key");
  const scenarioRef = React.useRef(scenario);
  scenarioRef.current = scenario;

  React.useEffect(() => {
    const before = useExperimentsStore.getState().snapshot;
    useExperimentsStore.setState({
      snapshot: { cloud: { enabled: true, source: "storage" } } as never,
    });
    const api = createFakeRemoteHostsApi();
    const timers: number[] = [];
    const later = (ms: number, act: () => void) => {
      timers.push(window.setTimeout(act, ms));
    };
    let flows = 0;
    /** Each flow's next step, and whether its one stop has been answered. */
    const progress = new Map<
      string,
      { at: number; answered: boolean; target: string; userMode: boolean }
    >();

    const run = (flowId: string) => {
      const flow = progress.get(flowId);
      if (flow === undefined) return;
      const step = STEPS[flow.at];
      const target = flow.target;
      if (step === undefined) {
        const mac = scenarioRef.current === "mac";
        // A Mac always runs as the person; Linux does when they chose their account only.
        const user = mac || flow.userMode;
        const host = registryHost({
          id: `0f6a3a8e-2b1c-4d5e-8f90-${String(flows).padStart(12, "0")}`,
          name: target,
          target,
          os: mac ? "macos" : "linux",
          mode: user ? "user" : "system",
          agentsShareAccount: user,
        });
        api.devicesOf.set(host.id, [
          {
            deviceId: host.deviceId,
            name: "This MacBook Pro",
            fingerprint: "SHA256:mac",
            enrolledAt: new Date().toISOString(),
            via: "ssh",
            revokedAt: null,
            thisMac: true,
          },
        ]);
        const store = useRemoteHostsStore.getState();
        store.setHosts([...store.hosts, host], store.readOnly);
        api.emit(flowId, { kind: "log", flowId, line: line("host added") });
        api.emit(flowId, {
          kind: "view",
          view: flowView({
            flowId,
            target,
            name: target,
            status: "done",
            done: 7,
            hostId: host.id,
            startup: mac ? `Starts when you log in to ${target}` : null,
          }),
        });
        return;
      }
      const stop = flow.answered ? null : stopFor(scenarioRef.current, step);
      if (stop !== null) {
        // As main shows a stop: a question waits on its step (running), a failure fails it.
        const view = flowView({ flowId, target, name: target, done: flow.at, at: step, ...stop });
        api.emit(flowId, {
          kind: "view",
          view:
            stop.status === "failed"
              ? { ...view, steps: view.steps.with(flow.at, { id: step, status: "failed" }) }
              : view,
        });
        return;
      }
      api.emit(flowId, { kind: "log", flowId, line: line("step started", { step }) });
      api.emit(flowId, {
        kind: "view",
        view: flowView({ flowId, target, name: target, done: flow.at, at: step }),
      });
      later(STEP_MS, () => {
        api.emit(flowId, { kind: "log", flowId, line: line("step finished", { step }) });
        flow.at += 1;
        run(flowId);
      });
    };

    const resume = (flowId: string) => {
      const flow = progress.get(flowId);
      if (flow === undefined) return;
      flow.answered = true;
      later(200, () => run(flowId));
    };

    const scripted: typeof api = {
      ...api,
      startAdd(input) {
        if (scenarioRef.current === "read-only") return Promise.reject(new Error(READ_ONLY));
        flows += 1;
        const flowId = `flow-${flows}`;
        progress.set(flowId, { at: 0, answered: false, target: input.target, userMode: false });
        // As main does: one replay first, then each change.
        later(120, () => {
          api.emit(flowId, {
            kind: "replay",
            view: flowView({ flowId, target: input.target, name: input.target }),
            log: [],
            omitted: 0,
          });
          run(flowId);
        });
        return Promise.resolve({ flowId });
      },
      answerAdd(flowId, questionId, answer) {
        const flow = progress.get(flowId);
        if (flow !== undefined && answer.kind === "user-install") flow.userMode = true;
        resume(flowId);
        return api.answerAdd(flowId, questionId, answer);
      },
      sudoPassword(flowId, questionId, password) {
        resume(flowId);
        return api.sudoPassword(flowId, questionId, password);
      },
      retryAdd(flowId, from) {
        resume(flowId);
        return api.retryAdd(flowId, from);
      },
      cancelAdd(flowId) {
        progress.delete(flowId);
        return api.cancelAdd(flowId);
      },
      forget(hostId) {
        const store = useRemoteHostsStore.getState();
        store.setHosts(
          store.hosts.filter((host) => host.id !== hostId),
          store.readOnly,
        );
        return api.forget(hostId);
      },
    };
    api.devicesOf.set(EXISTING.id, [
      {
        deviceId: EXISTING.deviceId,
        name: "This MacBook Pro",
        fingerprint: "SHA256:mac",
        enrolledAt: "2026-10-03T00:00:00Z",
        via: "ssh",
        revokedAt: null,
        thisMac: true,
      },
      {
        deviceId: "8e8d9c0b-1a2f-4e3d-9c4b-5a6f7e8d9c0b",
        name: "Old laptop",
        fingerprint: "SHA256:old",
        enrolledAt: "2026-09-01T00:00:00Z",
        via: "ssh",
        revokedAt: "2026-09-02T00:00:00Z",
        thisMac: false,
      },
    ]);
    setRemoteHostsApi(scripted);
    return () => {
      for (const timer of timers) window.clearTimeout(timer);
      setRemoteHostsApi(null);
      useRemoteHostsStore.getState().setHosts([], null);
      useExperimentsStore.setState({ snapshot: before });
    };
  }, []);

  React.useEffect(() => {
    const store = useRemoteHostsStore.getState();
    store.setHosts(
      store.hosts.length === 0 ? [EXISTING] : store.hosts,
      scenario === "read-only" ? READ_ONLY : null,
    );
  }, [scenario]);

  return (
    // The app mounts this once at its root; Settings → Hosts' back button needs it.
    <TooltipProvider>
      <div className="flex flex-col gap-6">
        <div className="flex flex-wrap items-center gap-3 text-ui">
          <label className="flex items-center gap-2">
            Scenario
            <select
              className="rounded-md border border-border bg-background px-2 py-1"
              value={scenario}
              onChange={(event) => setScenario(event.target.value as Scenario)}
            >
              {SCENARIOS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="rounded-md border border-border px-3 py-1 hover:bg-muted"
            onClick={() => openAddHostSheet()}
          >
            Add a host…
          </button>
        </div>
        <HostsChrome />
        <div className="max-w-2xl">
          <HostsPane />
        </div>
      </div>
    </TooltipProvider>
  );
}
