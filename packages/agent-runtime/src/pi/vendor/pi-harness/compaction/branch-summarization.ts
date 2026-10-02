import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { FileOperations } from "./utils";

/** Pi 0.99.2 shape retained only to decode persisted legacy lane summary operations. */
export interface BranchPreparation {
  /** Messages selected for the branch summary. */
  messages: AgentMessage[];
  /** File operations extracted from the branch. */
  fileOps: FileOperations;
  /** Estimated token count for selected messages. */
  totalTokens: number;
}
