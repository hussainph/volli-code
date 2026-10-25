/** Session writes are not wired to the runner inbox yet. Board writes are unaffected. */
import { toast } from "sonner";
import { launchStore } from "@renderer/stores/launch";
import { guardWrite, useCanWrite } from "@renderer/components/hosts/use-hosts";

export { CLOUD_SESSION_UNAVAILABLE as CLOUD_SESSION_READ_ONLY } from "./cloud-session-view";
import { CLOUD_SESSION_UNAVAILABLE as CLOUD_SESSION_READ_ONLY } from "./cloud-session-view";

export function useCanWriteSession(projectId: string | null): boolean {
  const hostWritable = useCanWrite(projectId);
  return launchStore() !== "cloud" && hostWritable;
}

export function guardSessionWrite(projectId: string | null): boolean {
  if (launchStore() !== "cloud") return guardWrite(projectId);
  toast(CLOUD_SESSION_READ_ONLY, { id: "cloud-session-read-only" });
  return false;
}
