// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { CommitField } from "./commit-field";

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
function press(name: string) {
  const button = host.querySelector<HTMLButtonElement>(`[aria-label="${name}"]`)!;
  return act(async () => button.click());
}

describe("CommitField quantities", () => {
  it("steps numeric unit fields, commits once per press and respects bounds", async () => {
    const onCommit = vi.fn((value: string) => ({ ok: true as const, value }));
    act(() =>
      root.render(
        <CommitField
          value="2"
          suffix="days"
          ariaLabel="Retention"
          min={1}
          max={3}
          onCommit={onCommit}
        />,
      ),
    );
    expect(host.querySelector("input")!.type).toBe("number");
    await press("Increase Retention");
    expect(onCommit).toHaveBeenCalledExactlyOnceWith("3");
    expect(
      host.querySelector<HTMLButtonElement>('[aria-label="Increase Retention"]')!.disabled,
    ).toBe(true);
    await press("Decrease Retention");
    expect(onCommit).toHaveBeenLastCalledWith("2");
    expect(host.querySelector("input")!.value).toBe("2");
  });

  it("validates and confirms stepper changes just like typed commits", async () => {
    const onCommit = vi.fn(() => ({ ok: true as const }));
    const confirm = vi.fn(() => false);
    act(() =>
      root.render(
        <CommitField
          type="number"
          value="2"
          ariaLabel="Limit"
          validate={() => "Too many"}
          onCommit={onCommit}
        />,
      ),
    );
    await press("Increase Limit");
    expect(host.querySelector('[role="alert"]')!.textContent).toBe("Too many");
    expect(onCommit).not.toHaveBeenCalled();
    act(() =>
      root.render(
        <CommitField
          key="confirm"
          type="number"
          value="2"
          ariaLabel="Limit"
          confirm={confirm}
          onCommit={onCommit}
        />,
      ),
    );
    await press("Decrease Limit");
    expect(confirm).toHaveBeenCalledWith("1");
    expect(host.querySelector("input")!.value).toBe("2");
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("shows rejected saves and freezes the stepper during pending writes", async () => {
    let resolve!: (result: { ok: false; error: string }) => void;
    const onCommit = vi.fn(
      () =>
        new Promise<{ ok: false; error: string }>((done) => {
          resolve = done;
        }),
    );
    act(() =>
      root.render(<CommitField type="number" value="2" ariaLabel="Limit" onCommit={onCommit} />),
    );
    await press("Increase Limit");
    expect(host.querySelector("input")!.disabled).toBe(true);
    expect(host.querySelector<HTMLButtonElement>('[aria-label="Decrease Limit"]')!.disabled).toBe(
      true,
    );
    await act(async () => resolve({ ok: false, error: "Offline" }));
    expect(host.querySelector('[role="alert"]')!.textContent).toBe("Offline");
    expect(host.querySelector("input")!.disabled).toBe(false);
  });

  it("surfaces thrown writes and leaves ordinary text fields without steppers", async () => {
    act(() =>
      root.render(
        <CommitField
          type="number"
          value="2"
          ariaLabel="Limit"
          onCommit={async () => {
            throw new Error("Write failed");
          }}
        />,
      ),
    );
    await press("Increase Limit");
    expect(host.querySelector('[role="alert"]')!.textContent).toBe("Write failed");
    act(() =>
      root.render(
        <CommitField key="text" value="main" ariaLabel="Branch" onCommit={() => ({ ok: true })} />,
      ),
    );
    expect(host.querySelector("input")!.type).toBe("text");
    expect(host.querySelector("button")).toBeNull();
  });
});
