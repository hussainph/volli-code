/**
 * Settings → Hosts (VC-700 PR 3; VC-615 flow 7): its key, and its rail entry
 * under Services. Only with the `cloud` experiment on (`settingsGroups`'s
 * `hosts` option); with it off the category does not exist.
 */
import { HardDrivesIcon } from "@phosphor-icons/react/dist/csr/HardDrives";

import { HOSTS_CATEGORY_KEY } from "@renderer/components/hosts/host-entry";

import type { PrefCategory } from "./kit";
import { HostsPane } from "./panes/hosts-pane";

export function hostsCategory(): PrefCategory {
  return {
    key: HOSTS_CATEGORY_KEY,
    label: "Hosts",
    icon: HardDrivesIcon,
    keywords: [
      "host",
      "hosts",
      "remote",
      "server",
      "ssh",
      "add a host",
      "manage hosts",
      "this mac",
      "rename",
      "forget",
      "forget host",
      "device",
      "devices",
      "paired devices",
      "pair",
      "name",
      "system",
      "version",
      "connection",
      "runs as",
      "starts",
      "projects",
      "agents share your account",
      "account",
    ],
    content: <HostsPane />,
  };
}
