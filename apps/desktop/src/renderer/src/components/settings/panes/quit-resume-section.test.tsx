// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { QuitResumeResult } from "../../../../../ipc/contract";
import { QuitResumeSection } from "./quit-resume-section";

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }));
vi.mock("@renderer/lib/toast", () => ({ toastError }));

let root: Root | null = null;
let container: HTMLElement | null = null;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  vi.unstubAllGlobals();
  toastError.mockReset();
});

function bridge(read: QuitResumeResult, write?: (autoResume: boolean) => QuitResumeResult) {
  const get = vi.fn(async () => read);
  const set = vi.fn(async (autoResume: boolean) =>
    write === undefined ? ({ ok: true, autoResume } as const) : write(autoResume),
  );
  vi.stubGlobal("api", { quitResume: { get, set } });
  return { get, set };
}

async function open(): Promise<void> {
  await act(async () => root?.render(<QuitResumeSection />));
}

function toggle(): HTMLButtonElement {
  const control = document.querySelector<HTMLButtonElement>('[aria-label="Resume after quit"]');
  if (control === null) throw new Error(`No switch: ${document.body.textContent}`);
  return control;
}

const checked = () => toggle().getAttribute("aria-checked") === "true";

describe("Settings → Agents → Restart (VC-1245)", () => {
  it("shows the host's setting, off by default, and stores the person's choice", async () => {
    const main = bridge({ ok: true, autoResume: false });
    await open();
    expect(document.body.textContent).toContain("Restart");
    expect(checked()).toBe(false);
    await act(async () => toggle().click());
    expect(main.set).toHaveBeenCalledWith(true);
    expect(checked()).toBe(true);
  });

  it("puts the switch back and says so when the save is refused or fails", async () => {
    bridge({ ok: true, autoResume: false }, () => ({ ok: false, error: "db is gone" }));
    await open();
    await act(async () => toggle().click());
    expect(checked()).toBe(false);
    expect(toastError).toHaveBeenCalledWith("Couldn't save that: db is gone");

    const main = bridge({ ok: true, autoResume: true });
    main.set.mockRejectedValueOnce(new Error("bridge closed"));
    await act(async () => root?.unmount());
    root = createRoot(container!);
    await open();
    await act(async () => toggle().click());
    expect(checked()).toBe(true);
    expect(toastError).toHaveBeenLastCalledWith("Couldn't save that: bridge closed");
  });

  it("names a failed read instead of showing a guessed switch", async () => {
    bridge({ ok: false, error: "db is gone" });
    await open();
    expect(document.body.textContent).toContain("Couldn't read restart settings");
    expect(document.querySelector('[aria-label="Resume after quit"]')).toBeNull();

    vi.stubGlobal("api", {});
    await act(async () => root?.unmount());
    root = createRoot(container!);
    await open();
    expect(document.body.textContent).toContain("Couldn't read restart settings");
  });

  it("drops a read that answers after the section closed", async () => {
    const pending = Promise.withResolvers<QuitResumeResult>();
    vi.stubGlobal("api", { quitResume: { get: () => pending.promise, set: vi.fn() } });
    await open();
    await act(async () => root?.unmount());
    root = null;
    await act(async () => pending.resolve({ ok: true, autoResume: true }));
  });
});
