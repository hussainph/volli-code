import { expect, it } from "vite-plus/test";
import { selectNavigatorRange } from "./session-navigator-selection";
it("toggles, extends either direction, unions modifier ranges and retains the anchor", () => {
  const ordered = ["a", "b", "c", "d"];
  const choose = (
    target: string,
    range = false,
    toggle = false,
    selected: ReadonlySet<string> = new Set(),
    anchor: string | null = null,
  ) => selectNavigatorRange({ ordered, target, range, toggle, selected, anchor });
  expect([...choose("b").selected]).toEqual(["b"]);
  expect([...choose("b", false, true, new Set(["a", "b"])).selected]).toEqual(["a"]);
  const backward = choose("a", true, false, new Set(["d"]), "c");
  expect([...backward.selected]).toEqual(["a", "b", "c"]);
  expect(backward.anchor).toBe("c");
  expect([...choose("b", true, true, new Set(["d"]), "a").selected]).toEqual(["d", "a", "b"]);
  expect([...choose("b", true, false, new Set(["d"]), "missing").selected]).toEqual(["b"]);
});
