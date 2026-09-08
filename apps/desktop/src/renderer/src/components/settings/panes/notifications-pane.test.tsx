// @vitest-environment jsdom
/**
 * Settings → Notifications as a person uses it (VC-295 round 2).
 *
 * The static render says the switches exist; these say what they DO — which is
 * the half that was a preview for two tickets. Four behaviours carry the
 * acceptance criteria: the stored record is what the page shows, an accepted
 * write shows the accepted value, a refused write leaves the switch alone and
 * says so, and a delivery the system reported as failed is on screen with the
 * route that fixes it.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type {
  NotificationSettingsResult,
  NotificationSettingsView,
} from "../../../../../ipc/contract";

vi.mock("@renderer/lib/toast", () => ({ toastError: vi.fn() }));
import { toastError } from "@renderer/lib/toast";

import { NotificationsPane } from "./notifications-pane";

const ALL_ON: NotificationSettingsView = {
  preferences: {
    enabled: true,
    events: { "needs-you": true, finished: true, swept: true, update: true },
  },
  supported: true,
  deliveryFailure: null,
};

let container: HTMLDivElement;
let root: Root;
let settings: () => Promise<NotificationSettingsResult>;
let set: (event: string | null, enabled: boolean) => Promise<NotificationSettingsResult>;
let writes: { event: string | null; enabled: boolean }[];

/** Installs the one bridge namespace this pane touches. */
function stubApi(): void {
  (globalThis as { window?: unknown }).window = globalThis;
  (globalThis as unknown as { api: unknown }).api = {
    notifications: {
      settings: () => settings(),
      set: (event: string | null, enabled: boolean) => {
        writes.push({ event, enabled });
        return set(event, enabled);
      },
    },
  };
}

async function render(): Promise<void> {
  await act(async () => {
    root.render(<NotificationsPane />);
  });
}

/** The switch a row's label names, as a `role=switch` element. */
function switchFor(id: string): HTMLButtonElement {
  const element = container.querySelector<HTMLButtonElement>(`#${id}`);
  if (element === null) throw new Error(`no switch ${id}`);
  return element;
}

beforeEach(() => {
  writes = [];
  settings = () => Promise.resolve({ ok: true, settings: ALL_ON });
  set = () => Promise.resolve({ ok: true, settings: ALL_ON });
  stubApi();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  vi.mocked(toastError).mockClear();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("NotificationsPane", () => {
  it("shows the stored record once it has been read, and only then", async () => {
    // Never a position the database has not confirmed: before the read lands
    // the switches are off and inoperable, which is what "show the accepted
    // value" means for a page whose value lives in another process.
    let resolveRead: (result: NotificationSettingsResult) => void = () => {};
    settings = () =>
      new Promise<NotificationSettingsResult>((resolve) => {
        resolveRead = resolve;
      });
    await render();

    expect(switchFor("notify-me").getAttribute("aria-checked")).toBe("false");
    expect(switchFor("notify-me").disabled).toBe(true);

    await act(async () => {
      resolveRead({
        ok: true,
        settings: {
          ...ALL_ON,
          preferences: { enabled: true, events: { ...ALL_ON.preferences.events, swept: false } },
        },
      });
    });

    expect(switchFor("notify-me").getAttribute("aria-checked")).toBe("true");
    expect(switchFor("notify-swept").getAttribute("aria-checked")).toBe("false");
    expect(switchFor("notify-needs-you").getAttribute("aria-checked")).toBe("true");
  });

  it("writes one category and shows the value the write came back with", async () => {
    await render();
    set = (event, enabled) =>
      Promise.resolve({
        ok: true,
        settings: {
          ...ALL_ON,
          preferences: {
            enabled: ALL_ON.preferences.enabled,
            events: { ...ALL_ON.preferences.events, [String(event)]: enabled },
          },
        },
      });

    await act(async () => {
      switchFor("notify-finished").click();
    });

    expect(writes).toEqual([{ event: "finished", enabled: false }]);
    expect(switchFor("notify-finished").getAttribute("aria-checked")).toBe("false");
    // Its neighbours are untouched: muting one category must not move another.
    expect(switchFor("notify-swept").getAttribute("aria-checked")).toBe("true");
  });

  it("writes the master switch as its own act, not as a category", async () => {
    await render();
    set = () =>
      Promise.resolve({
        ok: true,
        settings: {
          ...ALL_ON,
          preferences: { enabled: false, events: ALL_ON.preferences.events },
        },
      });

    await act(async () => {
      switchFor("notify-me").click();
    });

    expect(writes).toEqual([{ event: null, enabled: false }]);
    expect(switchFor("notify-me").getAttribute("aria-checked")).toBe("false");
    // Under an off master switch a category switch would be a choice with no
    // effect, exactly as the delivery rule reads it (`enabled && events[e]`).
    expect(switchFor("notify-swept").disabled).toBe(true);
  });

  it("leaves the switch where it was when the write is refused, and says why", async () => {
    await render();
    set = () => Promise.resolve({ ok: false, error: 'This build has no "swept" category.' });

    await act(async () => {
      switchFor("notify-swept").click();
    });

    expect(switchFor("notify-swept").getAttribute("aria-checked")).toBe("true");
    expect(vi.mocked(toastError)).toHaveBeenCalledWith(
      'Couldn\'t change notifications: This build has no "swept" category.',
    );
  });

  it("reports a read that failed rather than drawing switches it cannot stand behind", async () => {
    settings = () => Promise.resolve({ ok: false, error: "database is locked" });

    await render();

    expect(vi.mocked(toastError)).toHaveBeenCalledWith(
      "Couldn't read notification settings: database is locked",
    );
    expect(switchFor("notify-me").disabled).toBe(true);
  });

  it("puts a reported delivery failure on screen with the route that fixes it", async () => {
    settings = () =>
      Promise.resolve({
        ok: true,
        settings: {
          ...ALL_ON,
          deliveryFailure: {
            producer: "run-attention",
            message: "Notification permission denied.",
            at: 1000,
          },
        },
      });

    await render();

    const text = container.textContent ?? "";
    expect(text).toContain("didn't deliver");
    expect(text).toContain("Notification permission denied.");
    expect(text).toContain("System Settings");
  });

  it("says so when the platform posts no native alerts at all", async () => {
    settings = () => Promise.resolve({ ok: true, settings: { ...ALL_ON, supported: false } });

    await render();

    expect(container.textContent ?? "").toContain("can't show notifications");
  });
});
