import { branchTip, value as sessionValue } from "@earendil-works/pi-agent-core";

/** The one Pi branch Volli reads and writes. */
export const MAIN_BRANCH = "main";

/** The durable attachment identity stored beside the Pi branch tip. */
export interface SidecarIdentity {
  volliSessionId: string;
  volliThreadId: string;
  volliAttachmentId: string;
}

/** The value-store address shared by new sidecars and the legacy migration. */
export const SIDECAR_IDENTITY = sessionValue<SidecarIdentity>("volli.identity.v1");

/** The value-store address that makes the main branch visible to Pi 0.85.0. */
export const MAIN_BRANCH_TIP = branchTip(MAIN_BRANCH);
