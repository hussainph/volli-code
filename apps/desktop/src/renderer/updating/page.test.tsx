// @vitest-environment jsdom
/** The schema-upgrade window's page (VC-1105): one busy line, and the mode main names. */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { UPDATING_LABEL, UpdatingPage, updatingAppearance } from "./page";

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
});

describe("updatingAppearance", () => {
  it("takes only the two modes main names", () => {
    expect(updatingAppearance("?appearance=light")).toBe("light");
    expect(updatingAppearance("?appearance=dark")).toBe("dark");
    expect(updatingAppearance("?appearance=auto")).toBeNull();
    expect(updatingAppearance("")).toBeNull();
  });
});
