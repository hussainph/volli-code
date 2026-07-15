import type { TerminalBusyResult } from "@volli/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { busySessionInfo, describeBusy } from "./close-guard";

const busyMock = vi.fn<(sessionId: string) => Promise<TerminalBusyResult>>();

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("window", { api: { terminal: { busy: busyMock } } });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("busySessionInfo", () => {
  it("collects only sessions reporting ok + busy with a process name", async () => {
    busyMock.mockImplementation(async (sessionId) => {
      if (sessionId === "a") return { ok: true, busy: true, process: "claude" };
      if (sessionId === "b") return { ok: true, busy: false, process: null };
      return { ok: true, busy: true, process: "node" };
    });

    expect(await busySessionInfo(["a", "b", "c"])).toEqual([
      { sessionId: "a", process: "claude" },
      { sessionId: "c", process: "node" },
    ]);
  });

  it("treats a busy result with a null process as not busy", async () => {
    // Defensive: busy:true should carry a name, but a null name is unusable copy.
    busyMock.mockResolvedValue({ ok: true, busy: true, process: null });

    expect(await busySessionInfo(["a"])).toEqual([]);
  });

  it("treats an ok:false probe as not busy (fail-open)", async () => {
    busyMock.mockResolvedValue({ ok: false, error: "no such session" });

    expect(await busySessionInfo(["a"])).toEqual([]);
  });

  it("treats a rejected probe as not busy (fail-open)", async () => {
    busyMock.mockRejectedValue(new Error("ipc down"));

    expect(await busySessionInfo(["a"])).toEqual([]);
  });

  it("keeps busy sessions even when a sibling probe rejects", async () => {
    busyMock.mockImplementation(async (sessionId) => {
      if (sessionId === "boom") throw new Error("ipc down");
      return { ok: true, busy: true, process: "pnpm" };
    });

    expect(await busySessionInfo(["boom", "ok"])).toEqual([{ sessionId: "ok", process: "pnpm" }]);
  });

  it("returns an empty array for no ids without probing", async () => {
    expect(await busySessionInfo([])).toEqual([]);
    expect(busyMock).not.toHaveBeenCalled();
  });
});

describe("describeBusy", () => {
  it("names the single running process and pluralizes 'it'", () => {
    expect(describeBusy(["claude"], ". Closing will end")).toBe(
      "“claude” is still running. Closing will end it.",
    );
  });

  it("counts the busy sessions and lists deduped names for multiple", () => {
    expect(describeBusy(["claude", "pnpm"], ". Closing will end")).toBe(
      "2 terminals are still running (claude, pnpm). Closing will end them.",
    );
  });

  it("dedupes repeated process names while keeping the session count", () => {
    expect(describeBusy(["node", "node"], ". Closing will end")).toBe(
      "2 terminals are still running (node). Closing will end them.",
    );
  });

  it("threads the caller's tail clause (archive / project-removal wording)", () => {
    expect(describeBusy(["claude"], ". Archiving will end")).toBe(
      "“claude” is still running. Archiving will end it.",
    );
    expect(describeBusy(["claude", "pnpm"], " — removing the project will end")).toBe(
      "2 terminals are still running (claude, pnpm) — removing the project will end them.",
    );
  });
});
