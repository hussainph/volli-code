import { describe, expect, it } from "vite-plus/test";

import {
  applyQuietAppPolicy,
  quietWindowPolicy,
  revealWindow,
  sealQuietAppActivation,
} from "./quiet-windows";

describe("quietWindowPolicy", () => {
  it("plans a non-activating, click-through, unthrottled macOS smoke window", () => {
    expect(quietWindowPolicy({ VOLLI_QUIET_WINDOWS: "1" }, "darwin")).toEqual({
      enabled: true,
      useAccessoryActivation: true,
      backgroundThrottling: false,
      showInactive: true,
      ignoreMouseEvents: true,
      belowNormalWindowLevel: true,
      focusable: false,
    });
  });

  it("leaves an ordinary app launch on Electron's normal window policy", () => {
    expect(quietWindowPolicy({}, "darwin")).toEqual({
      enabled: false,
      useAccessoryActivation: false,
      backgroundThrottling: true,
      showInactive: false,
      ignoreMouseEvents: false,
      belowNormalWindowLevel: false,
      focusable: true,
    });
  });

  it("does not apply macOS activation policy on another platform", () => {
    expect(quietWindowPolicy({ VOLLI_QUIET_WINDOWS: "1" }, "linux")).toEqual({
      enabled: true,
      useAccessoryActivation: false,
      backgroundThrottling: false,
      showInactive: true,
      ignoreMouseEvents: true,
      belowNormalWindowLevel: false,
      focusable: true,
    });
  });
});

describe("applyQuietAppPolicy", () => {
  it("leaves an ordinary app's activation and Dock state untouched", () => {
    const calls: string[] = [];
    const app = {
      setActivationPolicy(policy: "accessory") {
        calls.push(policy);
      },
      dock: { hide: () => calls.push("dock.hide") },
    };

    applyQuietAppPolicy(app, quietWindowPolicy({}, "darwin"));

    expect(calls).toEqual([]);
  });

  it("keeps a macOS smoke app out of the Dock and application switcher", () => {
    const appState = { activationPolicy: "regular", dockVisible: true };
    const app = {
      setActivationPolicy(policy: "accessory") {
        appState.activationPolicy = policy;
      },
      dock: {
        hide() {
          appState.dockVisible = false;
        },
      },
    };

    applyQuietAppPolicy(app, quietWindowPolicy({ VOLLI_QUIET_WINDOWS: "1" }, "darwin"));

    expect(appState).toEqual({ activationPolicy: "accessory", dockVisible: false });
  });
});

describe("sealQuietAppActivation", () => {
  it("does not prohibit activation for an ordinary app", () => {
    const calls: string[] = [];
    const app = {
      setActivationPolicy(policy: "accessory" | "prohibited") {
        calls.push(policy);
      },
    };

    sealQuietAppActivation(app, quietWindowPolicy({}, "darwin"));

    expect(calls).toEqual([]);
  });

  it("prevents a revealed macOS smoke app from ever becoming active", () => {
    const appState = { activationPolicy: "accessory" };
    const app = {
      setActivationPolicy(policy: "accessory" | "prohibited") {
        appState.activationPolicy = policy;
      },
    };

    sealQuietAppActivation(app, quietWindowPolicy({ VOLLI_QUIET_WINDOWS: "1" }, "darwin"));

    expect(appState).toEqual({ activationPolicy: "prohibited" });
  });
});

describe("revealWindow", () => {
  it("uses only the normal show path for an ordinary app", () => {
    const calls: string[] = [];
    const window = {
      show: () => calls.push("show"),
      showInactive: () => calls.push("showInactive"),
      setIgnoreMouseEvents: () => calls.push("setIgnoreMouseEvents"),
      setAlwaysOnTop: () => calls.push("setAlwaysOnTop"),
    };

    revealWindow(window, quietWindowPolicy({}, "darwin"));

    expect(calls).toEqual(["show"]);
  });

  it("is click-through and below normal windows before a macOS smoke window becomes visible", () => {
    const state = {
      visible: false,
      focused: false,
      ignoresMouseEvents: false,
      relativeLevel: 0,
      atReveal: null as null | { ignoresMouseEvents: boolean; relativeLevel: number },
    };
    const window = {
      show() {
        state.visible = true;
        state.focused = true;
      },
      showInactive() {
        state.visible = true;
        state.atReveal = {
          ignoresMouseEvents: state.ignoresMouseEvents,
          relativeLevel: state.relativeLevel,
        };
      },
      setIgnoreMouseEvents(ignore: boolean) {
        state.ignoresMouseEvents = ignore;
      },
      setAlwaysOnTop(_flag: boolean, _level: "normal", relativeLevel: number) {
        state.relativeLevel = relativeLevel;
      },
    };

    revealWindow(window, quietWindowPolicy({ VOLLI_QUIET_WINDOWS: "1" }, "darwin"));

    expect(state).toEqual({
      visible: true,
      focused: false,
      ignoresMouseEvents: true,
      relativeLevel: -1,
      atReveal: { ignoresMouseEvents: true, relativeLevel: -1 },
    });
  });
});
