/**
 * VC-710: "Open a project on <host>…", the shipped sheet over a scripted
 * desktop main, with the `cloud` flag on.
 *
 * Scenarios: A host with projects (Open; one already open here offers Close);
 * A fresh host (no projects: New project…); No operator token yet (the one
 * command, with Copy); Agents share your account (a user install: no New
 * project…); Can't reach it (then Try again); and New project… refused, then
 * made (the first create answers the operator-token refusal with its command,
 * the next clones and opens); a clone that needs your sudo password (asked
 * in the sheet, wrong once, then made); and a private repo with no token
 * yet (its line sends you to Sign-ins on the host).
 *
 * Pick a scenario, then "Open a project on hetzner-1…", or "New project…".
 * The script answers after a short wait, as SSH would. Nothing reaches SSH or
 * main: the API is `createFakeRemoteHostsApi`.
 */
import * as React from "react";
import type { RemoteHostProject, RemoteHostProjects } from "@volli/shared";

import { HostsChrome } from "@renderer/components/hosts/hosts-chrome";
import { TooltipProvider } from "@renderer/components/ui/tooltip";
import { useExperimentsStore } from "@renderer/stores/experiments";
import { setRemoteHostsApi, useRemoteHostsStore } from "@renderer/stores/remote-hosts";
import { createFakeRemoteHostsApi, registryHost } from "@renderer/stores/remote-hosts.test-support";

export const title = "Open a project on a host — list, open, create";
export const note =
  "VC-710: the real sheet over a scripted main (projects, empty, operator token, user install, unreachable, a refused then made create)";

type Scenario =
  | "projects"
  | "fresh"
  | "operator"
  | "user"
  | "unreachable"
  | "create"
  | "sudo"
  | "token";

const SCENARIOS: readonly { value: Scenario; label: string }[] = [
  { value: "projects", label: "A host with projects" },
  { value: "fresh", label: "A fresh host (no projects)" },
  { value: "operator", label: "No operator token yet" },
  { value: "user", label: "Agents share your account" },
  { value: "unreachable", label: "Can’t reach it (then retry)" },
  { value: "create", label: "New project… refused, then made" },
  { value: "sudo", label: "Clone needs your sudo password (wrong once)" },
  { value: "token", label: "Private repo, no token yet" },
];

const HOST = registryHost({
  id: "6f6a3a8e-2b1c-4d5e-8f90-1a2b3c4d5e6f",
  name: "hetzner-1",
  target: "deploy@hetzner-1",
  system: "Ubuntu 24.04.1 LTS",
  arch: "x86-64",
});

const PROJECTS: readonly RemoteHostProject[] = [
  {
    id: "1a2b3c4d-0000-4000-8000-000000000001",
    name: "Acme API",
    prefix: "AA",
    path: "/srv/volli/acme-api",
    tickets: 14,
  },
  {
    id: "1a2b3c4d-0000-4000-8000-000000000002",
    name: "Website",
    prefix: "WE",
    path: "/srv/volli/website",
    tickets: 1,
  },
];

const COMMAND = "sudo volli-hostd operator-token --for 'deploy'";

const wait = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

function listingFor(scenario: Scenario): Omit<RemoteHostProjects, "hostId"> | Error {
  switch (scenario) {
    case "projects":
      return { projects: PROJECTS, adds: { kind: "ready" } };
    case "fresh":
    case "create":
    case "sudo":
    case "token":
      return { projects: [], adds: { kind: "ready" } };
    case "operator":
      return { projects: [], adds: { kind: "needs-operator", command: COMMAND } };
    case "user":
      return { projects: [], adds: { kind: "user-install" } };
    case "unreachable":
      return new Error("Couldn't reach hetzner-1.");
  }
}

export default function HostOpenProjectScratch() {
  const [scenario, setScenario] = React.useState<Scenario>("projects");
  const scenarioRef = React.useRef(scenario);
  scenarioRef.current = scenario;

  React.useEffect(() => {
    const before = useExperimentsStore.getState().snapshot;
    useExperimentsStore.setState({
      snapshot: { ...before, cloud: { enabled: true, source: "storage" } },
    });
    const api = createFakeRemoteHostsApi();
    let creates = 0;
    let unreachableReads = 0;
    const scripted: typeof api = {
      ...api,
      async projects(hostId) {
        await wait(700);
        const current = scenarioRef.current;
        // Unreachable once; "Try again" then reads the host.
        if (current === "unreachable" && unreachableReads++ % 2 === 0) {
          throw new Error("Couldn't reach hetzner-1.");
        }
        const listing = listingFor(current === "unreachable" ? "projects" : current);
        if (listing instanceof Error) throw listing;
        return { hostId, ...listing };
      },
      async createProject(input) {
        await wait(input.gitUrl === undefined ? 600 : 1600);
        creates += 1;
        if (scenarioRef.current === "create" && creates % 2 === 1) {
          return {
            ok: false,
            failure: {
              code: "not-operator",
              message:
                "This Mac can’t add projects on hetzner-1 yet. Run this there once, then try again.",
              command: COMMAND,
            },
          };
        }
        if (scenarioRef.current === "sudo" && input.gitUrl !== undefined) {
          // Asked, then a wrong one, then made.
          if (input.sudoPassword === undefined) {
            return {
              ok: false,
              failure: {
                code: "needs-password",
                message:
                  "Cloning on hetzner-1 runs as its volli account: enter your password on hetzner-1 to go on.",
                command: null,
              },
            };
          }
          if (creates % 3 === 2) {
            return {
              ok: false,
              failure: {
                code: "wrong-password",
                message: "That password didn’t work on hetzner-1.",
                command: null,
              },
            };
          }
        }
        if (scenarioRef.current === "token" && input.gitUrl !== undefined) {
          return {
            ok: false,
            failure: {
              code: "needs-credential",
              message: "Add a GitHub token in Sign-ins on hetzner-1, then try again.",
              command: null,
            },
          };
        }
        return api.createProject(input);
      },
      async openWorkspace(hostId, workspaceId) {
        await wait(200);
        return api.openWorkspace(hostId, workspaceId);
      },
    };
    setRemoteHostsApi(scripted);
    useRemoteHostsStore.getState().setHosts([HOST]);
    return () => {
      setRemoteHostsApi(null);
      useRemoteHostsStore.getState().closeProjectSheet();
      useRemoteHostsStore.getState().setHosts([], null);
      useExperimentsStore.setState({ snapshot: before });
    };
  }, []);

  const open = (start: "list" | "new") =>
    useRemoteHostsStore.getState().openProjectSheet(HOST.id, start);

  return (
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
            onClick={() => open("list")}
          >
            Open a project on hetzner-1…
          </button>
          <button
            type="button"
            className="rounded-md border border-border px-3 py-1 hover:bg-muted"
            onClick={() => open("new")}
          >
            New project…
          </button>
        </div>
        <HostsChrome />
      </div>
    </TooltipProvider>
  );
}
