import { describe, expect, it, vi } from "vite-plus/test";
import { disableUnusedBrowserFeatures } from "./chromium-features";

describe("disableUnusedBrowserFeatures", () => {
  it("disables the unused browser observer before a partition can create its store", () => {
    const commandLine = { getSwitchValue: vi.fn(() => ""), appendSwitch: vi.fn() };
    disableUnusedBrowserFeatures(commandLine);
    expect(commandLine.getSwitchValue).toHaveBeenCalledWith("disable-features");
    expect(commandLine.appendSwitch).toHaveBeenCalledExactlyOnceWith(
      "disable-features",
      "DeclarativePerformanceObserver",
    );
  });

  it("preserves other caller-supplied feature disables and their trial parameters", () => {
    const commandLine = {
      getSwitchValue: () => "OtherFeature, AnotherFeature<Trial",
      appendSwitch: vi.fn(),
    };
    disableUnusedBrowserFeatures(commandLine);
    expect(commandLine.appendSwitch).toHaveBeenCalledExactlyOnceWith(
      "disable-features",
      "OtherFeature, AnotherFeature<Trial,DeclarativePerformanceObserver",
    );
  });

  it("does not duplicate an existing disable", () => {
    const commandLine = {
      getSwitchValue: () => "OtherFeature, DeclarativePerformanceObserver ",
      appendSwitch: vi.fn(),
    };
    disableUnusedBrowserFeatures(commandLine);
    expect(commandLine.appendSwitch).not.toHaveBeenCalled();
  });
});
