/** Trusted host vocabulary for a classifier flag, never model-generated prose. */
export const AUTHORITY_JUDGE_DENIAL_CAUSES = [
  "unauthorized",
  "uncertain",
  "destructive",
  "disclosure",
  "security",
  "external",
] as const;
export type AuthorityJudgeDenialCause = (typeof AUTHORITY_JUDGE_DENIAL_CAUSES)[number];

export function isAuthorityJudgeDenialCause(value: unknown): value is AuthorityJudgeDenialCause {
  return AUTHORITY_JUDGE_DENIAL_CAUSES.some((cause) => cause === value);
}

const REASONS: Readonly<Record<AuthorityJudgeDenialCause, string>> = {
  unauthorized:
    "The user's messages do not clearly authorise this entire call and its side effects.",
  uncertain:
    "The scope or consequences of this call are not clear enough to proceed automatically.",
  destructive: "This call could irreversibly change or delete important data or work.",
  disclosure: "This call could disclose private data or credentials outside the intended boundary.",
  security: "This call could weaken security safeguards or create persistent access.",
  external: "This call could change shared or external systems with material consequences.",
};

/** Also fails closed if an untyped host hands us an unknown cause. */
export function authorityJudgeDenialReason(cause: AuthorityJudgeDenialCause): string {
  return REASONS[isAuthorityJudgeDenialCause(cause) ? cause : "uncertain"];
}
