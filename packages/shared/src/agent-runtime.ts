/** Product-owned Session and model policy consumed by the Agent Runtime. */

export type SessionRole = "project" | "ticket" | "subagent";

/** Ticket Sessions persist Auto authority in the first Pi migration slice. */
export interface AuthoritySnapshot {
  mode: "auto";
}

/** Volli's reasoning policy, independent of any provider's type names. */
export type ReasoningLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** The selected model access for one Session attachment. */
export interface ModelSelection {
  providerId: string;
  modelId: string;
  reasoningLevel: ReasoningLevel;
}
