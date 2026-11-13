// @vitest-environment jsdom
import { describe, expect, it } from "vite-plus/test";
import { createIslandClearance, ISLAND_CLEARANCE_PROPERTY } from "./island-clearance";

const read = (node: HTMLElement) => node.style.getPropertyValue(ISLAND_CLEARANCE_PROPERTY);

describe("island clearance", () => {
  it("writes the rise on every attached element, including one attached later", () => {
    const clearance = createIslandClearance();
    const band = document.createElement("div");
    clearance.attach(band);
    expect(read(band)).toBe("0px");
    clearance.publish(29.8);
    expect(read(band)).toBe("30px");
    const button = document.createElement("button");
    clearance.attach(button);
    expect(read(button)).toBe("30px");
    clearance.publish(12.26);
    expect(read(band)).toBe("12.5px");
    expect(read(button)).toBe("12.5px");
  });

  it("writes nothing for a repeat, and stops writing to a detached element", () => {
    const clearance = createIslandClearance();
    const button = document.createElement("button");
    const detach = clearance.attach(button);
    clearance.publish(30);
    button.style.removeProperty(ISLAND_CLEARANCE_PROPERTY);
    clearance.publish(30.1);
    expect(read(button)).toBe("");
    detach?.();
    clearance.publish(4);
    expect(read(button)).toBe("");
    expect(clearance.attach(null)).toBeUndefined();
  });

  it("never publishes a negative rise", () => {
    const clearance = createIslandClearance();
    const button = document.createElement("button");
    clearance.attach(button);
    clearance.publish(-3);
    expect(read(button)).toBe("0px");
  });
});
