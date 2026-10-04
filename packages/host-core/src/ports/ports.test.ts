import { describe, expect, expectTypeOf, it, vi } from "vite-plus/test";
import {
  ClientCapabilityUnavailableError,
  clientCapabilities,
  HEADLESS_ATTENTION,
  isClientCapabilityUnavailable,
  NO_POWER_EVENTS,
  type ClientCapabilityPort,
} from "./index";

function refusal(run: () => unknown): ClientCapabilityUnavailableError {
  try {
    run();
  } catch (error) {
    if (isClientCapabilityUnavailable(error)) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("client capabilities on a headless host", () => {
  const headless = clientCapabilities(undefined);

  it("refuses every request with a typed error that says what was asked and why not", async () => {
    const link = await headless.openExternal("https://example.com").then(
      () => null,
      (error: unknown) => error,
    );
    expect(link).toBeInstanceOf(ClientCapabilityUnavailableError);
    expect(link).toMatchObject({
      name: "ClientCapabilityUnavailableError",
      code: "client-capability-unavailable",
      capability: "open-external",
      message: "Opening a link needs the Volli desktop app, and this host is running without one.",
    });
    expect(refusal(() => headless.revealInFolder("/tmp/a"))).toMatchObject({
      capability: "reveal-in-folder",
      message:
        "Revealing a file needs the Volli desktop app, and this host is running without one.",
    });
    await expect(headless.writeClipboardText("x")).rejects.toMatchObject({
      capability: "clipboard",
    });
    await expect(headless.readClipboardText()).rejects.toMatchObject({
      capability: "clipboard",
      message:
        "Using the clipboard needs the Volli desktop app, and this host is running without one.",
    });
    await expect(headless.showMenu([{ kind: "separator" }])).rejects.toMatchObject({
      capability: "menu",
      message: "Showing a menu needs the Volli desktop app, and this host is running without one.",
    });
  });

  it("tells a refusal apart from any other failure", () => {
    expect(isClientCapabilityUnavailable(new ClientCapabilityUnavailableError("menu"))).toBe(true);
    expect(isClientCapabilityUnavailable(new Error("Showing a menu needs"))).toBe(false);
    expect(isClientCapabilityUnavailable(undefined)).toBe(false);
  });

  it("hands a client's own port through untouched", () => {
    const client: ClientCapabilityPort = {
      openExternal: vi.fn(() => Promise.resolve()),
      revealInFolder: vi.fn(),
      writeClipboardText: vi.fn(() => Promise.resolve()),
      readClipboardText: vi.fn(() => Promise.resolve("")),
      showMenu: vi.fn(() => Promise.resolve(null)),
    };
    expect(clientCapabilities(client)).toBe(client);
  });
});

describe("headless attention and power", () => {
  it("delivers nothing and reports nothing in front of anyone", () => {
    expect(
      HEADLESS_ATTENTION.deliver({ producer: "agent-notify", title: "t", body: "b", target: null }),
    ).toEqual({ delivered: false, reason: "unsupported" });
    expect(HEADLESS_ATTENTION.focusedSessionIds().size).toBe(0);
  });

  it("never announces sleep or wake", () => {
    const listener = vi.fn();
    expect(NO_POWER_EVENTS.on("resume", listener)).toBeUndefined();
    expect(NO_POWER_EVENTS.removeListener("resume", listener)).toBeUndefined();
    expect(listener).not.toHaveBeenCalled();
  });
});

// A subscription's payload must never accidentally fan out to every client.
it("keeps subscription events off the broadcast port at the type boundary", () => {
  expectTypeOf<
    Extract<
      Parameters<import("./events").HostEventBus["publish"]>[0],
      "file-changed" | "dir-changed" | "worktree-changed" | "worktree-watch-error"
    >
  >().toEqualTypeOf<never>();
  expectTypeOf<Parameters<import("./events").HostClientEventSink["publish"]>[0]>().toEqualTypeOf<
    "file-changed" | "dir-changed" | "worktree-changed" | "worktree-watch-error"
  >();
});
