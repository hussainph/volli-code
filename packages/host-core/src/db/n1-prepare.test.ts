import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { describe, expect, it } from "vite-plus/test";

import { latestCanaryTag, latestReleaseTag } from "../../scripts/n1/prepare.mjs";

it("keeps the fixed 0.2.2 downgrade promises in the non-waived N−1 CI gate (VC-758)", () => {
  const workflow = parse(
    readFileSync(new URL("../../../../.github/workflows/ci.yml", import.meta.url), "utf8"),
  ) as {
    jobs: Record<
      string,
      {
        "continue-on-error"?: boolean;
        if?: string;
        strategy?: { matrix: { lane: string[] } };
        needs?: string[];
        steps: { name: string; run?: string; env?: Record<string, string> }[];
      }
    >;
  };
  const job = workflow.jobs["n1-compat"]!;
  expect(job.strategy!.matrix.lane).toEqual(
    expect.arrayContaining(["release", "latest-canary", "base", "v0.2.1", "v0.2.2-canary.1"]),
  );
  expect(job["continue-on-error"]).not.toBe(true);
  expect(job.if).toBeUndefined();
  const prepare = job.steps.find((step) => step.name === "Prepare N-1")!.run!;
  expect(prepare).toContain('"$LANE" == "v0.2.1" || "$LANE" == "v0.2.2-canary.1"');
  expect(prepare).toContain('args=(--ref "$LANE")');
  expect(
    job.steps.find((step) => step.name === "Run N-1 against this build's head")!.run,
  ).toContain("src/db/n1-compatibility.test.ts");
  const gate = workflow.jobs["gate"]!;
  expect(gate.needs).toContain("n1-compat");
  const required = gate.steps.find(
    (step) => step.name === "Require every lane to pass or to skip by its own condition",
  )!;
  expect(required.env!["N1_COMPAT"]).toBe("${{ needs.n1-compat.result }}");
  expect(required.run).toContain('expect "N-1 compatibility" "$N1_COMPAT" success');
});

describe("the N-1 release lane's choice of build (VC-633)", () => {
  it("takes the newest stable vX.Y.Z by version, never a canary", () => {
    expect(
      latestReleaseTag([
        "v0.2.0",
        "v0.10.0-canary.1",
        "v0.2.1-canary.7",
        "v0.9.3",
        "v0.2.1",
        "",
        "release-1",
      ]),
    ).toBe("v0.9.3");
    expect(latestReleaseTag(["v1.0.0", "v0.10.0"])).toBe("v1.0.0");
    expect(latestReleaseTag(["v0.2.1-canary.7"])).toBeNull();
  });
});

describe("the N-1 latest-canary lane's choice of build (VC-633)", () => {
  it("takes the highest canary number of a version, numerically", () => {
    expect(latestCanaryTag(["v0.2.1-canary.6", "v0.2.1-canary.7", "v0.2.1-canary.1"])).toBe(
      "v0.2.1-canary.7",
    );
    expect(latestCanaryTag(["v0.2.0-canary.9", "v0.2.0-canary.10"])).toBe("v0.2.0-canary.10");
  });

  it("prefers a newer version's canaries over an older version's, by version order", () => {
    expect(
      latestCanaryTag(["v0.2.0-canary.12", "v0.2.1-canary.1", "v0.2.0-canary.11", "v0.2.0"]),
    ).toBe("v0.2.1-canary.1");
    expect(latestCanaryTag(["v0.9.0-canary.30", "v0.10.0-canary.2"])).toBe("v0.10.0-canary.2");
    expect(latestCanaryTag(["v1.0.0-canary.1", "v0.10.4-canary.9"])).toBe("v1.0.0-canary.1");
  });

  it("never takes a stable tag or another prerelease shape", () => {
    expect(
      latestCanaryTag([
        "v0.3.0",
        "v0.3.0-beta.1",
        "v0.2.1-canary.7",
        "v0.4.0-canary",
        "v0.4.0-canary.x",
        "0.5.0-canary.1",
        "",
      ]),
    ).toBe("v0.2.1-canary.7");
    expect(latestCanaryTag(["v0.2.1", "v0.3.0"])).toBeNull();
  });
});
