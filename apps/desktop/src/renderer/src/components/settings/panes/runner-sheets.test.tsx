// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { AddRunnerSheet } from "./add-runner-sheet";
import { AlwaysOnRunnerSheet } from "./always-on-runner-sheet";
import { LinkRunnerSheet } from "./link-runner-sheet";
import type { InstallStatus, RunnerSetup } from "./runner-setup";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
const button = (text: string) => {
  const result = [...document.querySelectorAll("button")].find((item) => item.textContent === text);
  if (!result) throw new Error(`Missing button: ${text}`);
  return result;
};
const click = async (text: string) => {
  await act(async () => button(text).click());
};
const type = async (label: string, text: string) => {
  const input = [...document.querySelectorAll("label")]
    .find((item) => item.textContent?.includes(label))!
    .querySelector("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
function fixture() {
  const grant = {
    installTokenId: "grant-id",
    installToken: "vrt_test-only-token",
    expiresAt: Date.now() + 3600000,
  };
  let receive: (status: InstallStatus) => void = vi.fn();
  let fail: () => void = vi.fn();
  const stop = vi.fn();
  const preview = {
    ok: true as const,
    requestId: "request-id",
    hostname: "hetzner-1",
    os: "linux",
    distro: "Ubuntu",
    arch: "x64",
    ip: "203.0.113.1",
    requestedAt: Date.now(),
    expiresAt: Date.now() + 600000,
  };
  const setup = {
    create: vi.fn(async () => grant),
    revoke: vi.fn(async () => null),
    watch: vi.fn((_id, listener, onFail) => {
      receive = listener;
      fail = onFail;
      return stop;
    }),
    preview: vi.fn<RunnerSetup["preview"]>(async () => preview),
    decide: vi.fn(async () => ({ ok: true })),
  } satisfies RunnerSetup;
  const props = { setup, appVersion: "0.3.0", server: null, onClose: vi.fn() };
  return {
    props,
    setup,
    grant,
    preview,
    stop,
    push: (status: InstallStatus) => act(() => receive(status)),
    fail: () => act(() => fail()),
  };
}

describe("Runner setup sheets", () => {
  it("creates only on intent, copies a pinned command, and waits for online rather than just token use", async () => {
    const f = fixture();
    const copy = vi.fn(async (_value: string) => {});
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: copy },
    });
    act(() => root.render(<AddRunnerSheet {...f.props} />));
    expect(f.setup.create).not.toHaveBeenCalled();
    await type("Runner name", "hetzner-1");
    await click("Create install command");
    expect(f.setup.create).toHaveBeenCalledWith("hetzner-1");
    expect(document.body.textContent).toContain("Waiting for the box…");
    await click("Copy command");
    expect(copy.mock.calls[0]![0]).toContain("/v0.3.0/volli-runner-install.sh");
    expect(document.body.textContent).toContain("Copied");
    f.push({
      state: "used",
      expiresAt: f.grant.expiresAt,
      runner: { id: "runner", name: "hetzner-1", status: "offline" },
    });
    expect(document.body.textContent).toContain("Waiting for it to come online");
    expect(document.body.textContent).not.toContain(f.grant.installToken);
    f.push({
      state: "used",
      expiresAt: f.grant.expiresAt,
      runner: { id: "runner", name: "hetzner-1", status: "online" },
    });
    expect(document.body.textContent).toContain("hetzner-1 is online. Pick it in the composer.");
    await click("Done");
    expect(f.props.onClose).toHaveBeenCalledOnce();
    act(() => root.render(null));
    expect(f.stop).toHaveBeenCalledOnce();
  });

  it("does not claim success on failures, supports status retry and explicit revocation", async () => {
    const f = fixture();
    f.setup.create.mockRejectedValueOnce(new Error("private backend details"));
    act(() => root.render(<AddRunnerSheet {...f.props} />));
    await click("Create install command");
    expect(document.body.textContent).toContain("Couldn’t create");
    expect(document.body.textContent).not.toContain("private backend details");
    await click("Create install command");
    f.fail();
    await click("Retry status");
    expect(f.stop).toHaveBeenCalledOnce();
    expect(f.setup.watch).toHaveBeenCalledTimes(2);
    f.setup.revoke.mockRejectedValueOnce(new Error("no connection"));
    await click("Revoke token");
    expect(document.body.textContent).toContain("Couldn’t revoke");
    await click("Revoke token");
    expect(f.setup.revoke).toHaveBeenLastCalledWith("grant-id");
    expect(document.body.textContent).not.toContain(f.grant.installToken);
  });

  it("expires commands without a backend update and replaces them only on request", async () => {
    vi.useFakeTimers();
    const f = fixture();
    act(() => root.render(<AddRunnerSheet {...f.props} />));
    await click("Create install command");
    act(() => vi.advanceTimersByTime(3600001));
    expect(document.body.textContent).not.toContain(f.grant.installToken);
    expect(document.body.textContent).toContain("expired or been revoked");
    await click("Create a fresh command");
    expect(f.setup.revoke).toHaveBeenCalledWith("grant-id");
    expect(f.setup.create).toHaveBeenCalledTimes(2);
  });

  it("shows clipboard failure without leaking the token into the error", async () => {
    const f = fixture();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: vi.fn(async () => {
          throw new Error(f.grant.installToken);
        }),
      },
    });
    act(() => root.render(<AddRunnerSheet {...f.props} />));
    await click("Create install command");
    await click("Copy command");
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      "Couldn’t copy. Select the text and copy it manually.",
    );
  });

  it("generates cloud-init with a fresh token and supports all three provider paths", async () => {
    const f = fixture();
    act(() => root.render(<AlwaysOnRunnerSheet {...f.props} />));
    await click("Create install command");
    expect(document.body.textContent).toContain("#cloud-config");
    expect(document.body.textContent).toContain("Start it within 1 hour");
    const select = document.querySelector<HTMLSelectElement>('[aria-label="Provider"]')!;
    expect([...select.options].map((option) => option.text)).toEqual([
      "Hetzner",
      "DigitalOcean",
      "Other (cloud-init)",
    ]);
    await act(async () => {
      select.value = "DigitalOcean";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(document.body.textContent).toContain("on DigitalOcean");
    f.push({ state: "revoked", expiresAt: f.grant.expiresAt, runner: null });
    expect(document.body.textContent).not.toContain("#cloud-config");
  });

  it("previews identity and warning before approving exactly the previewed request", async () => {
    const f = fixture();
    act(() => root.render(<LinkRunnerSheet {...f.props} />));
    await type("Runner code", "ABCD-EFGH");
    await click("Check code");
    expect(f.setup.preview).toHaveBeenCalledWith("ABCD-EFGH");
    for (const value of [
      "hetzner-1",
      "Ubuntu",
      "x64",
      "203.0.113.1",
      "GitHub access",
      "not proof of identity",
    ])
      expect(document.body.textContent).toContain(value);
    expect(f.setup.decide).not.toHaveBeenCalled();
    await click("Approve runner");
    expect(f.setup.decide).toHaveBeenCalledWith("request-id", "ABCD-EFGH", "approve");
    expect(document.body.textContent).toContain("is approved");
    expect(document.body.textContent).not.toContain("is online");
  });

  it("supports denial and handles a lost decision response as retryable", async () => {
    const f = fixture();
    f.setup.decide.mockRejectedValueOnce(new Error("offline"));
    act(() => root.render(<LinkRunnerSheet {...f.props} />));
    await type("Runner code", "ABCD-EFGH");
    await click("Check code");
    await click("Deny");
    expect(document.body.textContent).toContain("Couldn’t save your decision");
    await click("Deny");
    expect(document.body.textContent).toContain("Link request denied");
    expect(f.setup.decide).toHaveBeenLastCalledWith("request-id", "ABCD-EFGH", "deny");
  });

  it("keeps invalid, throttled and failed code checks out of the approval state", async () => {
    const f = fixture();
    f.setup.preview
      .mockResolvedValueOnce({ ok: false, code: "not_found" })
      .mockResolvedValueOnce({ ok: false, code: "rate_limited" })
      .mockRejectedValueOnce(new Error("internal details"));
    act(() => root.render(<LinkRunnerSheet {...f.props} />));
    await type("Runner code", "ABCD-EFGH");
    await click("Check code");
    expect(document.body.textContent).toContain("invalid or expired");
    await click("Check code");
    expect(document.body.textContent).toContain("Too many attempts");
    await click("Check code");
    expect(document.body.textContent).toContain("Couldn’t check that code");
    expect(document.body.textContent).not.toContain("internal details");
    expect(f.setup.decide).not.toHaveBeenCalled();
    await click("Check code");
    f.setup.decide.mockResolvedValueOnce({ ok: false });
    await click("Approve runner");
    expect(document.body.textContent).toContain("no longer available");
    expect(button("Check code")).toBeTruthy();
  });

  it("disables approval after expiry and lets the person enter another code", async () => {
    vi.useFakeTimers();
    const f = fixture();
    act(() => root.render(<LinkRunnerSheet {...f.props} />));
    await type("Runner code", "ABCD-EFGH");
    await click("Check code");
    act(() => vi.advanceTimersByTime(600001));
    expect(button("Approve runner").disabled).toBe(true);
    await click("Another code");
    expect(button("Check code")).toBeTruthy();
  });
});
