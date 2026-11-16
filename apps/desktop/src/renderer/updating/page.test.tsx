// @vitest-environment jsdom
/** The schema-upgrade window's page (VC-1105): one busy line, and the mode main names. */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import {
  CHECKING_LABEL,
  UPDATING_LABEL,
  UPDATING_THEN_QUIT_LABEL,
  UpdatingPage,
  updatingAppearance,
  updatingBackground,
  updatingThenQuit,
  updatingWork,
} from "./page";

describe("UpdatingPage", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("announces one busy line and offers nothing to press", () => {
    act(() => root.render(<UpdatingPage />));
    const status = host.querySelector('[role="status"]');
    expect(status?.textContent).toBe(UPDATING_LABEL);
    expect(host.querySelectorAll("button, a, input")).toHaveLength(0);
  });

  it("says the quit waits for the upgrade, still with nothing to press (VC-1208)", () => {
    act(() => root.render(<UpdatingPage thenQuit />));
    expect(host.querySelector('[role="status"]')?.textContent).toBe(UPDATING_THEN_QUIT_LABEL);
    expect(host.querySelectorAll("button, a, input")).toHaveLength(0);
  });

  it("says checking, not updating, for a routine launch's check", () => {
    act(() => root.render(<UpdatingPage work="check" />));
    expect(host.querySelector('[role="status"]')?.textContent).toBe(CHECKING_LABEL);
    expect(host.querySelectorAll("button, a, input")).toHaveLength(0);
  });
});

describe("updatingBackground", () => {
  it("takes only a six-digit hex color", () => {
    expect(updatingBackground("?background=%2334293a")).toBe("#34293a");
    expect(updatingBackground("?background=red")).toBeNull();
    expect(updatingBackground("?background=%23fff")).toBeNull();
    expect(updatingBackground("?background=url(x)")).toBeNull();
    expect(updatingBackground("")).toBeNull();
  });
});

describe("updatingThenQuit", () => {
  it("is true only when main names a waiting quit", () => {
    expect(updatingThenQuit("?appearance=dark&then=quit")).toBe(true);
    expect(updatingThenQuit("?then=restart")).toBe(false);
    expect(updatingThenQuit("")).toBe(false);
  });
});

describe("updatingWork", () => {
  it("is a check only when main names one", () => {
    expect(updatingWork("?appearance=dark&work=check")).toBe("check");
    expect(updatingWork("?work=upgrade")).toBe("upgrade");
    expect(updatingWork("?appearance=dark")).toBe("upgrade");
  });
});

describe("updatingAppearance", () => {
  it("takes only the two modes main names", () => {
    expect(updatingAppearance("?appearance=light")).toBe("light");
    expect(updatingAppearance("?appearance=dark")).toBe("dark");
    expect(updatingAppearance("?appearance=auto")).toBeNull();
    expect(updatingAppearance("")).toBeNull();
  });
});
