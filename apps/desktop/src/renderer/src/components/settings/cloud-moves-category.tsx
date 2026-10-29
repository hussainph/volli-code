import { CloudArrowUpIcon } from "@phosphor-icons/react/dist/csr/CloudArrowUp";
import { CloudMovesSettings } from "@renderer/components/cloud-moves/cloud-moves";
import type { PrefCategory } from "./kit";

export function cloudMovesCategory(): PrefCategory {
  return {
    key: "volli-cloud",
    label: "Volli Cloud",
    icon: CloudArrowUpIcon,
    keywords: [
      "move projects to volli cloud",
      "move all projects",
      "local projects",
      "moves",
      "progress and local copies",
      "go back to local",
    ],
    content: <CloudMovesSettings />,
  };
}
