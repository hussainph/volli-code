/**
 * "Choose the folder…" (VC-895 N2-3): a Volli Cloud project's one recovery
 * when this Mac has no checkout for it, beside the controls that start its
 * Sessions. It draws nothing otherwise: in a local launch, when the folder is
 * known, or before this Mac is a runner (Settings → Runners owns that).
 */
import { FolderOpenIcon } from "@phosphor-icons/react/dist/csr/FolderOpen";

import { Button } from "@renderer/components/ui/button";
import { useProjectsStore } from "@renderer/stores/projects";

import { useCloudCheckout, type CloudCheckoutRpc } from "./use-cloud-checkout";

export function CloudCheckoutControl({
  projectId,
  rpc,
  cloud,
}: {
  projectId: string;
  /** A test's tier client and launch; production reads both itself. */
  rpc?: CloudCheckoutRpc;
  cloud?: boolean;
}) {
  const view = useCloudCheckout(projectId, {
    ...(rpc === undefined ? {} : { rpc }),
    ...(cloud === undefined ? {} : { cloud }),
  });
  const name = useProjectsStore(
    (state) => state.projects.find((project) => project.id === projectId)?.name ?? null,
  );
  if (view.kind === "none") return null;
  const label = `Choose the folder for ${name ?? "this project"} on this Mac`;
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      title={label}
      aria-label={label}
      disabled={view.choosing}
      onClick={() => void view.choose()}
    >
      <FolderOpenIcon />
      Choose the folder…
    </Button>
  );
}
