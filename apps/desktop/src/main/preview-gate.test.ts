import { describe, expect, it, vi } from "vite-plus/test";
import { previewAccountGranted, previewAtLaunch } from "./preview-gate";

describe("stable preview launch gate", () => {
  it("never touches the marker or saved sign-in for non-stable or unconfigured launches", async () => {
    const readMarker = vi.fn();
    const restoreAccount = vi.fn();
    for (const [stable, configured] of [
      [false, false],
      [false, true],
      [true, false],
    ]) {
      expect(
        await previewAtLaunch({
          stable: stable!,
          configured: configured!,
          readMarker,
          restoreAccount,
        }),
      ).toBe(false);
    }
    expect(readMarker).not.toHaveBeenCalled();
    expect(restoreAccount).not.toHaveBeenCalled();
  });
  it("requires deliberate sign-in and a fresh matching backend grant", async () => {
    const restoreAccount = vi.fn(async () => "alice");
    expect(
      await previewAtLaunch({
        stable: true,
        configured: true,
        readMarker: () => null,
        restoreAccount,
      }),
    ).toBe(false);
    expect(restoreAccount).not.toHaveBeenCalled();
    for (const userId of ["alice", "bob", null]) {
      expect(
        await previewAtLaunch({
          stable: true,
          configured: true,
          readMarker: () => ({ userId: "alice" }),
          restoreAccount: async () => userId,
        }),
      ).toBe(userId === "alice");
    }
    expect(
      await previewAtLaunch({
        stable: true,
        configured: true,
        readMarker: () => ({ userId: "alice" }),
        restoreAccount: async () => {
          throw new Error("offline");
        },
      }),
    ).toBe(false);
  });
});

it("requires an explicit grant for an active account", () => {
  for (const previewAccess of ["granted", "waitlisted", "future", undefined]) {
    for (const status of ["active", "deletion_pending", "deleted", undefined]) {
      for (const previewAgreementAccepted of [true, false, undefined]) {
        expect(previewAccountGranted({ previewAccess, status, previewAgreementAccepted })).toBe(
          previewAccess === "granted" && status === "active" && previewAgreementAccepted === true,
        );
      }
    }
  }
});

it("opens local within the launch deadline even if account I/O never finishes", async () => {
  vi.useFakeTimers();
  try {
    const launch = previewAtLaunch({
      stable: true,
      configured: true,
      readMarker: () => ({ userId: "alice" }),
      restoreAccount: () => new Promise(() => {}),
      deadlineMs: 2_000,
    });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await launch).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});
