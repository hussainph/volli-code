import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vite-plus/test";

import { workAtRisk } from "./work";

it("lists dirty/unpushed/unverifiable working copies, not dependencies, clean copies or symlink targets", () => {
  const root = mkdtempSync(join(tmpdir(), "runner-work-risk-"));
  try {
    for (const name of [
      "clean",
      "dirty",
      "unpushed",
      "no-upstream",
      "unreadable",
      "node_modules/ignored",
      "elsewhere",
    ]) {
      mkdirSync(join(root, name), { recursive: true });
      writeFileSync(join(root, name, ".git"), "gitdir: example");
    }
    symlinkSync(join(root, "elsewhere"), join(root, "symlink"));
    const result = workAtRisk(root, (_command, args) => {
      const path = args[1]!;
      const status = args.includes("status");
      if (path.endsWith("unreadable") && status) return { status: 1, stdout: "" };
      if (path.endsWith("no-upstream") && !status) return { status: 1, stdout: "" };
      return {
        status: 0,
        stdout: status
          ? path.endsWith("dirty")
            ? " M file"
            : ""
          : path.endsWith("unpushed")
            ? "1"
            : "0",
      };
    });
    expect(result.toSorted()).toEqual(
      ["dirty", "no-upstream", "unpushed", "unreadable"].map((name) => join(root, name)).toSorted(),
    );
    expect(
      workAtRisk(join(root, "missing"), () => {
        throw new Error("not called");
      }),
    ).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
