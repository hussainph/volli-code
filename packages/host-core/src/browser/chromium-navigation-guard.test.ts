import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vite-plus/test";

import { BROWSER_URL_MAX_CHARS, isAllowedBrowserUrl } from "./backend";
import {
  BLOCKED_BROWSER_NAVIGATION,
  CHROMIUM_NAVIGATION_GUARD_BINDING,
  CHROMIUM_NAVIGATION_GUARD_SOURCE,
} from "./chromium-navigation-guard";

interface NavigationEvent {
  destination: { url: string };
  cancelable: boolean;
  downloadRequest: string | null;
  preventDefault(): void;
}

function guard(frame: "main" | "child" = "main", supported = true) {
  const listeners: Array<(event: NavigationEvent) => void> = [];
  const addEventListener = vi.fn((name: string, listener: (event: NavigationEvent) => void) => {
    expect(name).toBe("navigate");
    listeners.push(listener);
  });
  const window: { top?: object; navigation?: { addEventListener: typeof addEventListener } } = {};
  window.top = frame === "main" ? window : {};
  if (supported) window.navigation = { addEventListener };
  const notify = vi.fn();
  runInNewContext(CHROMIUM_NAVIGATION_GUARD_SOURCE, {
    window,
    URL,
    [CHROMIUM_NAVIGATION_GUARD_BINDING]: notify,
  });
  return {
    listeners,
    notify,
    navigate: (url: string, cancelable = true, downloadRequest: string | null = null) => {
      const preventDefault = vi.fn();
      for (const listener of listeners)
        listener({ destination: { url }, cancelable, downloadRequest, preventDefault });
      return preventDefault;
    },
  };
}

describe("Chromium's isolated main-frame navigation guard", () => {
  it.each([
    "http://fixture.test/page",
    "https://fixture.test/page",
    "HTTP://fixture.test/page",
    "blob:http://fixture.test/document",
    "volli-test-scheme:hello",
    "data:text/html,page",
    "file:///tmp/page",
    "javascript:void(0)",
    "not a URL",
  ])("uses the document-fetch policy for %s", (url) => {
    const policy = guard();
    const prevented = policy.navigate(url);
    if (isAllowedBrowserUrl(url)) {
      expect(prevented).not.toHaveBeenCalled();
      expect(policy.notify).not.toHaveBeenCalled();
    } else {
      expect(prevented).toHaveBeenCalledOnce();
      expect(policy.notify).toHaveBeenCalledExactlyOnceWith(BLOCKED_BROWSER_NAVIGATION);
    }
  });

  it("leaves long HTTP(S) destinations to the Fetch/commit guards without changing in-page URLs", () => {
    const policy = guard();
    expect(
      policy.navigate(`http://fixture.test/#${"x".repeat(BROWSER_URL_MAX_CHARS)}`),
    ).not.toHaveBeenCalled();
    expect(policy.notify).not.toHaveBeenCalled();
  });

  it.each(["about:blank", "chrome-error://chromewebdata/"])(
    "lets the product start/error backstop reach %s",
    (url) => {
      const policy = guard();
      expect(policy.navigate(url)).not.toHaveBeenCalled();
      expect(policy.notify).not.toHaveBeenCalled();
    },
  );

  it("leaves download requests to the browser's existing download denial", () => {
    const policy = guard();
    expect(
      policy.navigate("blob:http://fixture.test/document", true, "fixture.bin"),
    ).not.toHaveBeenCalled();
    expect(policy.notify).not.toHaveBeenCalled();
  });

  it("does not change the same-process iframe residual", () => {
    const policy = guard("child");
    expect(policy.listeners).toEqual([]);
    expect(policy.navigate("blob:http://fixture.test/document")).not.toHaveBeenCalled();
  });

  it("leaves non-cancelable navigations to the existing CDP backstops", () => {
    const policy = guard();
    expect(policy.navigate("blob:http://fixture.test/document", false)).not.toHaveBeenCalled();
    expect(policy.notify).not.toHaveBeenCalled();
  });

  it("retains the CDP backstops on engines without the Navigation API", () => {
    expect(guard("main", false).listeners).toEqual([]);
  });
});
