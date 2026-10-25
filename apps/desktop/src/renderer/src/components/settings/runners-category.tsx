/**
 * Settings → Runners (VC-895): its rail entry under Services, after Account.
 * Only in a Volli Cloud launch (`settingsGroups`'s `runners` option); in any
 * other launch the category does not exist.
 */
import { HardDrivesIcon } from "@phosphor-icons/react/dist/csr/HardDrives";

import type { PrefCategory } from "./kit";
import { RunnersPane } from "./panes/runners-pane";

export const RUNNERS_CATEGORY_KEY = "runners";

export function runnersCategory(): PrefCategory {
  return {
    key: RUNNERS_CATEGORY_KEY,
    label: "Runners",
    icon: HardDrivesIcon,
    keywords: [
      "runner",
      "runners",
      "this mac",
      "volli cloud",
      "cloud",
      "machine",
      "linux",
      "rename",
      "remove",
      "online",
      "offline",
      "asleep",
      "volli is closed",
      "updating",
      "removed",
      "used from two places",
      "add this mac again",
      "try again",
    ],
    content: <RunnersPane />,
  };
}
