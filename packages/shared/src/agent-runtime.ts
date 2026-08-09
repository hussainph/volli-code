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

/** Whether the singular Agent Runtime can truthfully use one account or model. */
export type ModelAccessState = "available" | "authentication-required" | "unavailable";

/** Sanitized hint about how use of one provider is billed. */
export type ModelAccessBillingSource =
  | "subscription"
  | "api-key"
  | "gateway"
  | "local"
  | "ambient"
  | "unknown";

/** Product recovery vocabulary. Runtime-native login detail stays behind the host seam. */
export interface ModelAccessRecovery {
  kind: "external-sign-in" | "retry";
}

/** One provider account as the renderer may see it. Never contains credentials. */
export interface ModelAccessProvider {
  id: string;
  label: string;
  state: ModelAccessState;
  accountLabel: string | null;
  billingSource: ModelAccessBillingSource;
  recovery: ModelAccessRecovery | null;
}

/** One model the runtime knows, qualified by current account availability. */
export interface ModelAccessModel {
  providerId: string;
  modelId: string;
  label: string;
  state: ModelAccessState;
  reasoningLevels: readonly ReasoningLevel[];
}

/** The complete sanitized Model Access view at one observation time. */
export interface ModelAccessSnapshot {
  observedAt: number;
  providers: readonly ModelAccessProvider[];
  models: readonly ModelAccessModel[];
}
