import { describe, expect, it } from "vite-plus/test";

import { slashQueryAt } from "./slash-menu";

describe("slashQueryAt", () => {
  it("opens on a bare slash", () => {
    expect(slashQueryAt("/", 1)).toEqual({ from: 0, to: 1, filter: "" });
  });

  it("captures the filter after the slash", () => {
    expect(slashQueryAt("try /td", 7)).toEqual({ from: 4, to: 7, filter: "td" });
  });

  it("ignores mid-word slashes", () => {
    expect(slashQueryAt("and/or", 4)).toBeNull();
  });

  it("ignores when the caret is not in a token", () => {
    expect(slashQueryAt("hello ", 6)).toBeNull();
  });
});
