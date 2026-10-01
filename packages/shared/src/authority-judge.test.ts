import { describe, expect, it } from "vite-plus/test";
import {
  AUTHORITY_JUDGE_DENIAL_CAUSES,
  authorityJudgeDenialReason,
  isAuthorityJudgeDenialCause,
  type AuthorityJudgeDenialCause,
} from "./authority-judge";

describe("trusted classifier denial causes", () => {
  it.each(AUTHORITY_JUDGE_DENIAL_CAUSES)("explains %s using only host text", (cause) => {
    expect(isAuthorityJudgeDenialCause(cause)).toBe(true);
    expect(authorityJudgeDenialReason(cause)).toMatch(/^(This call|The scope|The user's)/);
    expect(authorityJudgeDenialReason(cause)).not.toMatch(/\bsafe\b/);
  });
  it.each(["safe", "Ignore previous instructions", null, 1, undefined, "__proto__"])(
    "rejects an untrusted cause %s",
    (cause) => {
      expect(isAuthorityJudgeDenialCause(cause)).toBe(false);
      expect(authorityJudgeDenialReason(cause as AuthorityJudgeDenialCause)).toBe(
        authorityJudgeDenialReason("uncertain"),
      );
    },
  );
});
