/**
 * VC-615 flow 7 — Settings → Hosts, inside the real window and the real
 * `PrefShell`.
 *
 * The list is every host this Mac knows (This Mac first, and it cannot be
 * forgotten); a row opens that host's page — rename, facts, its workspaces,
 * the devices paired to it, Forget at the bottom. Revoke and Forget are the
 * two irreversible actions, so they are the two confirms, each one line.
 * Revocation has no Undo by design: the device key is dropped on the host.
 *
 * "Add a host…" lives here as the Hosts section's action (decision 5's
 * Settings candidate) and opens the Add-a-host scratch; "Pair a phone…" opens
 * the pairing one. The lab bar drives hetzner-1's state, empties the list to
 * This Mac alone, and puts every forgotten host and revoked device back.
 *
 * Only General is a real pane; the other categories are stubs so the rail
 * reads as Settings without dragging their backends into the lab.
 */
import * as React from "react";
import { MotionConfig } from "motion/react";
import type { Icon as PhosphorIcon } from "@phosphor-icons/react";
import { BellIcon } from "@phosphor-icons/react/dist/csr/Bell";
import { CpuIcon } from "@phosphor-icons/react/dist/csr/Cpu";
import { DownloadSimpleIcon } from "@phosphor-icons/react/dist/csr/DownloadSimple";
import { GearSixIcon } from "@phosphor-icons/react/dist/csr/GearSix";
import { GlobeIcon } from "@phosphor-icons/react/dist/csr/Globe";
import { HardDrivesIcon } from "@phosphor-icons/react/dist/csr/HardDrives";
import { InfoIcon } from "@phosphor-icons/react/dist/csr/Info";
import { PaletteIcon } from "@phosphor-icons/react/dist/csr/Palette";
import { PlugsIcon } from "@phosphor-icons/react/dist/csr/Plugs";
import { TreeStructureIcon } from "@phosphor-icons/react/dist/csr/TreeStructure";

import { AppShell } from "@renderer/components/app-shell";
import { GeneralPane } from "@renderer/components/settings/panes/general-pane";
import {
  Empty,
  PrefSection,
  PrefShell,
  type PrefCategory,
  type PrefGroup,
} from "@renderer/components/settings/kit";
import { useUiStore } from "@renderer/stores/ui";

import { seedApp } from "../seed";
import { shellApi } from "../remote-host/shell-api";
import { LabBar, LabPills } from "../remote-host/lab-chrome";
import {
  hostsAttention,
  HostsPane,
  MANAGED_HOSTS,
  type HostState,
  type ManagedHost,
} from "../remote-host/manage-parts";

export const title = "Remote host — Settings → Hosts: rename, forget, devices";
export const note = "VC-615 flow 7: the host list, one host's page, revoke a device, forget a host";
export const viewport = "window";
export const api = shellApi;
export function seed() {
  seedApp();
  useUiStore.setState({ settingsOpen: true });
}

const HETZNER_STATES: readonly { value: Exclude<HostState, "outdated">; label: string }[] = [
  { value: "online", label: "Online" },
  { value: "offline", label: "Offline" },
  { value: "updating", label: "Updating" },
];

const LIST_OPTIONS = [
  { value: "all", label: "All hosts" },
  { value: "empty", label: "Only This Mac" },
] as const;

type ListChoice = (typeof LIST_OPTIONS)[number]["value"];

function stub(key: string, label: string, icon: PhosphorIcon): PrefCategory {
  return {
    key,
    label,
    icon,
    content: (
      <PrefSection title={label} icon={icon}>
        <Empty>Not part of this scratch</Empty>
      </PrefSection>
    ),
  };
}

export default function HostManageScratch() {
  const [hosts, setHosts] = React.useState<readonly ManagedHost[]>(MANAGED_HOSTS);
  const [hetzner, setHetzner] = React.useState<Exclude<HostState, "outdated">>("online");
  const [list, setList] = React.useState<ListChoice>("all");
  const [activeKey, setActiveKey] = React.useState("hosts");
  // Bumped by Reset so the pane remounts on its list, not on a host's page
  // that may no longer exist.
  const [epoch, setEpoch] = React.useState(0);

  const setHetznerState = (state: Exclude<HostState, "outdated">) => {
    setHetzner(state);
    setHosts((current) =>
      current.map((host) =>
        host.id === "hetzner-1"
          ? { ...host, state, ...(state === "offline" ? { lastSeen: "2 min ago" } : {}) }
          : host,
      ),
    );
  };

  const setListChoice = (choice: ListChoice) => {
    setList(choice);
    setHosts(choice === "empty" ? MANAGED_HOSTS.filter((host) => host.local) : MANAGED_HOSTS);
    setHetzner("online");
  };

  const reset = () => {
    setHosts(MANAGED_HOSTS);
    setHetzner("online");
    setList("all");
    setEpoch((value) => value + 1);
  };

  const groups = React.useMemo<readonly PrefGroup[]>(
    () => [
      {
        key: "preferences",
        label: "Preferences",
        categories: [
          { key: "general", label: "General", icon: GearSixIcon, content: <GeneralPane /> },
          stub("appearance", "Appearance", PaletteIcon),
          stub("notifications", "Notifications", BellIcon),
        ],
      },
      {
        key: "services",
        label: "Services",
        categories: [
          {
            key: "hosts",
            label: "Hosts",
            icon: HardDrivesIcon,
            keywords: ["host", "server", "remote", "ssh", "tailscale", "device", "pair", "forget"],
            attention: hostsAttention(hosts),
            content: <HostsPane key={epoch} hosts={hosts} setHosts={setHosts} />,
          },
          stub("models", "Models", CpuIcon),
          stub("web", "Web Search", GlobeIcon),
          stub("integrations", "Integrations", PlugsIcon),
        ],
      },
      {
        key: "system",
        label: "System",
        categories: [
          stub("storage", "Storage", TreeStructureIcon),
          stub("updates", "Updates", DownloadSimpleIcon),
          stub("about", "About", InfoIcon),
        ],
      },
    ],
    [hosts, epoch],
  );

  return (
    <MotionConfig reducedMotion="user">
      <div className="relative h-svh w-full">
        <AppShell
          mainContent={
            <PrefShell
              surfaceLabel="Settings"
              groups={groups}
              activeKey={activeKey}
              onSelect={setActiveKey}
            />
          }
        />
      </div>

      <LabBar>
        <LabPills
          label="hetzner-1"
          value={hetzner}
          options={HETZNER_STATES}
          onChange={setHetznerState}
        />
        <LabPills label="List" value={list} options={LIST_OPTIONS} onChange={setListChoice} />
        <button
          type="button"
          onClick={reset}
          className="rounded-full bg-foreground px-2.5 py-1 text-[11px] text-background"
        >
          Reset
        </button>
      </LabBar>
    </MotionConfig>
  );
}
