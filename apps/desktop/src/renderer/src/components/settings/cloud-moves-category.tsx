import { CloudUploadIcon } from "@renderer/components/ui/icon";

import { CloudMovesSettings } from "@renderer/components/cloud-moves/cloud-moves";
import type { PrefCategory } from "./kit";

export function cloudMovesCategory(): PrefCategory {
  return {
    key: "volli-cloud",
    label: "Volli Cloud",
    icon: CloudUploadIcon,
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
