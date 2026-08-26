import { describe, expect, it } from "vite-plus/test";

import { collisionMatrix } from "./worktree-collisions";

describe("collisionMatrix", () => {
  it("names every ticket that touches a shared path", () => {
    const matrix = collisionMatrix([
      { ticket: "VC-65", paths: ["src/chat-plane.tsx", "src/only-65.ts"] },
      { ticket: "VC-68", paths: ["src/chat-plane.tsx"] },
      { ticket: "VC-70", paths: ["src/chat-plane.tsx", "src/only-70.ts"] },
    ]);

    // The per-path view: one row per contested path, naming every claimant.
    expect(matrix.overlaps).toEqual([
      { path: "src/chat-plane.tsx", tickets: ["VC-65", "VC-68", "VC-70"] },
    ]);
  });

  it("leaves a path only one ticket touches out of the matrix", () => {
    const matrix = collisionMatrix([
      { ticket: "VC-1", paths: ["a.ts", "shared.ts"] },
      { ticket: "VC-2", paths: ["b.ts", "shared.ts"] },
    ]);

    expect(matrix.overlaps.map((overlap) => overlap.path)).toEqual(["shared.ts"]);
  });

  it("pairs the tickets that will collide, worst pair first", () => {
    const matrix = collisionMatrix([
      { ticket: "VC-1", paths: ["one.ts", "two.ts", "three.ts"] },
      { ticket: "VC-2", paths: ["one.ts", "two.ts"] },
      { ticket: "VC-3", paths: ["three.ts"] },
    ]);

    // A pair is the schedulable unit — "do not run these two at once" — so the
    // heaviest collision sorts first, and ties fall back to ticket order.
    expect(matrix.pairs).toEqual([
      { tickets: ["VC-1", "VC-2"], paths: ["one.ts", "two.ts"] },
      { tickets: ["VC-1", "VC-3"], paths: ["three.ts"] },
    ]);
  });

  it("reports an empty matrix when nothing overlaps", () => {
    const matrix = collisionMatrix([
      { ticket: "VC-1", paths: ["a.ts"] },
      { ticket: "VC-2", paths: ["b.ts"] },
    ]);

    expect(matrix).toEqual({ overlaps: [], pairs: [] });
  });

  it("reports an empty matrix for one worktree, or none at all", () => {
    expect(collisionMatrix([{ ticket: "VC-1", paths: ["a.ts", "b.ts"] }])).toEqual({
      overlaps: [],
      pairs: [],
    });
    expect(collisionMatrix([])).toEqual({ overlaps: [], pairs: [] });
  });

  it("counts one ticket's repeated path once, never as a collision with itself", () => {
    // A rename shows up twice in a numstat scan (old path and new path collapse
    // to the same displayed path). One ticket touching a path twice is still one
    // claimant, and a self-pair is not a collision anyone can schedule around.
    const matrix = collisionMatrix([
      { ticket: "VC-1", paths: ["dup.ts", "dup.ts"] },
      { ticket: "VC-2", paths: ["dup.ts"] },
    ]);

    expect(matrix.overlaps).toEqual([{ path: "dup.ts", tickets: ["VC-1", "VC-2"] }]);
    expect(matrix.pairs).toEqual([{ tickets: ["VC-1", "VC-2"], paths: ["dup.ts"] }]);
  });

  it("orders contested paths and claimants deterministically", () => {
    // The radar is bash-composable, so two runs over the same worktrees must
    // produce byte-identical output whatever order the scan happened to visit.
    const matrix = collisionMatrix([
      { ticket: "VC-9", paths: ["z.ts", "a.ts"] },
      { ticket: "VC-10", paths: ["a.ts", "z.ts"] },
    ]);

    expect(matrix.overlaps).toEqual([
      { path: "a.ts", tickets: ["VC-10", "VC-9"] },
      { path: "z.ts", tickets: ["VC-10", "VC-9"] },
    ]);
    expect(matrix.pairs).toEqual([{ tickets: ["VC-10", "VC-9"], paths: ["a.ts", "z.ts"] }]);
  });
});
