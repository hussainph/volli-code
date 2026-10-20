import { describe, expect, it } from "vite-plus/test";
import { HOST_WORKSPACE_BOUNDS, HOST_WORKSPACE_FAILURE_CODES } from "./host-workspaces";

describe("the frozen host workspace contract", () => {
  it("pins finite listing and string bounds", () => {
    expect(HOST_WORKSPACE_BOUNDS).toEqual({
      rows: 500,
      name: 512,
      path: 4096,
      gitUrl: 2048,
      message: 512,
    });
    expect(Object.isFrozen(HOST_WORKSPACE_BOUNDS)).toBe(true);
  });
  it("pins every closed failure code", () => {
    expect(HOST_WORKSPACE_FAILURE_CODES).toEqual([
      "invalid-source",
      "path-unreadable",
      "target-exists",
      "clone-failed",
      "clone-timeout",
      "registration-failed",
      "still-running",
      "interrupted",
      "capacity",
    ]);
  });
});
