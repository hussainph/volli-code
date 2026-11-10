import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import { cssTimeMs, GLASS_MOTION, springEasing, springSamples } from "./glass-motion";

it.each([
  ["380ms", 380],
  [".38s", 380],
  ["0s", 0],
  [" 160ms ", 160],
] as const)("parses %s as milliseconds", (value, expected) =>
  expect(cssTimeMs(value)).toBe(expected),
);
it.each(["-1ms", "Infinitys", "NaNs", "12", "1px", "", "1s junk"])(
  "rejects invalid CSS time %s",
  (value) => expect(cssTimeMs(value)).toBeNull(),
);
it("gives the approved activity shimmer one global clock and static motion-off values", () => {
  const css = readFileSync(new URL("../globals.css", import.meta.url), "utf8");
  const clock = css.match(/--duration-activity-shimmer:\s*([^;]+);/)![1]!;
  expect(cssTimeMs(clock)).toBe(1800);
  expect(css.match(/--ease-linear:\s*([^;]+);/)![1]!.trim()).toBe(GLASS_MOTION.linear);
  expect(css.match(/--duration-activity-shimmer: 0ms;/g)).toHaveLength(2);
  const island = readFileSync(
    new URL("../components/chat/liquid-island.css", import.meta.url),
    "utf8",
  );
  expect(island).toContain("var(--duration-activity-shimmer) var(--ease-linear)");
});

describe("finite spring clocks", () => {
  it("derives API seconds from milliseconds", () => {
    expect(GLASS_MOTION.snappySeconds * 1000).toBe(GLASS_MOTION.snappy);
    expect(GLASS_MOTION.menuInSeconds * 1000).toBe(GLASS_MOTION.menuIn);
  });
  it("normalizes 65 samples, permits overshoot only for pointer drops", () => {
    for (const kind of ["pin", "drop"] as const) {
      const samples = springSamples(kind);
      expect(samples).toHaveLength(65);
      expect(samples[0]).toBe(0);
      expect(samples.at(-1)).toBe(1);
      expect(samples.every(Number.isFinite)).toBe(true);
      if (kind === "pin")
        expect(samples.every((value, index) => value <= (samples[index + 1] ?? 1))).toBe(true);
      else {
        expect(Math.max(...samples)).toBeGreaterThan(1);
        expect(Math.max(...samples)).toBeLessThan(1.03);
      }
    }
  });
  it("keeps CSS clocks and curves exactly aligned with the JS definition", () => {
    const css = readFileSync(new URL("../globals.css", import.meta.url), "utf8");
    const time = (name: string) =>
      cssTimeMs(css.match(new RegExp(`--duration-${name}:\\s*([^;]+);`))![1]!);
    expect(time("bouncy")).toBe(GLASS_MOTION.pointerDrop);
    expect(time("smooth")).toBe(GLASS_MOTION.pin);
    expect(time("snappy")).toBe(GLASS_MOTION.snappy);
    for (const [name, kind] of [
      ["smooth", "pin"],
      ["bouncy", "drop"],
    ] as const) {
      const value = css.match(new RegExp(`--spring-${name}:\\s*([^;]+);`))![1]!;
      expect(value.replace(/\s+/g, "")).toBe(springEasing(kind).replace(/\s+/g, ""));
    }
  });
});
