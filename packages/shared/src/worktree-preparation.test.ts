import { describe, expect, it } from "vite-plus/test";
import {
  isWorktreePreparationAttention,
  WORKTREE_PREPARATION_FAILED,
} from "./worktree-preparation";

describe("isWorktreePreparationAttention (VC-1015)", () => {
  const refusal = `${WORKTREE_PREPARATION_FAILED} at /w/VC-1 — A worktree already exists at /w/VC-1 on branch volli/VC-2-other; this ticket's branch is volli/VC-1-ship.`;

  it("reads a start whose worktree could not be prepared", () => {
    expect(isWorktreePreparationAttention({ kind: "configuration_invalid", detail: refusal })).toBe(
      true,
    );
  });

  it("leaves every other configuration failure to Settings", () => {
    expect(
      isWorktreePreparationAttention({
        kind: "configuration_invalid",
        detail: "Model openai/gpt is not available.",
      }),
    ).toBe(false);
    expect(isWorktreePreparationAttention({ kind: "configuration_invalid", detail: null })).toBe(
      false,
    );
  });

  it("reads no other kind, whatever its detail says", () => {
    expect(isWorktreePreparationAttention({ kind: "adapter_unrecoverable", detail: refusal })).toBe(
      false,
    );
  });
});
