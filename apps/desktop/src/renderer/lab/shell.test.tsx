// @vitest-environment jsdom
import { DEFAULT_CANVAS, type Canvas } from "@volli/shared";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { useThemeStore } from "@renderer/stores/theme";
import type { ScratchModule } from "./scratch";
import { activateScratch } from "./shell";

const CHOSEN: Canvas = {
  stops: [
    { hex: "#2ba39c", x: 0.2, y: 0.7 },
    { hex: "#7a4fa3", x: 0.8, y: 0.2 },
  ],
  primaryIndex: 1,
  vibrancy: 0.9,
  grain: 0.35,
};

beforeEach(() => {
  useThemeStore.setState({
    preview: DEFAULT_CANVAS,
    previewAppearance: "auto",
  });
});

describe("activateScratch", () => {
  it("reapplies the Lab choice after the scratch's setup resets shared stores", () => {
    const order: string[] = [];
    const scratch: ScratchModule & { slug: string } = {
      slug: "seeded",
      title: "Seeded scratch",
      default: () => null,
      seed: () => {
        order.push("scratch setup");
        useThemeStore.setState({ preview: null, previewAppearance: null });
      },
    };

    activateScratch(scratch, () => {
      order.push("Lab theme");
      useThemeStore.getState().startPreview(CHOSEN);
      useThemeStore.getState().startAppearancePreview("dark");
    });

    expect(order).toEqual(["scratch setup", "Lab theme"]);
    expect(useThemeStore.getState().preview).toEqual(CHOSEN);
    expect(useThemeStore.getState().previewAppearance).toBe("dark");
  });
});
