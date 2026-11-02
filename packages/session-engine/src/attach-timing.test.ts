import { describe, expect, it } from "vite-plus/test";
import { AttachStageClock } from "./attach-timing";

describe("AttachStageClock (VC-1072)", () => {
  it("times each stage since the one before it, and the run since its start", () => {
    let now = 1_000;
    const clock = new AttachStageClock(() => now);
    now += 5;
    clock.mark("submitted");
    now += 3_500;
    clock.mark("concurrency-budget");
    now += 20;

    expect(clock.seal()).toEqual({
      totalMs: 3_525,
      stages: [
        { stage: "submitted", ms: 5 },
        { stage: "concurrency-budget", ms: 3_500 },
      ],
    });
  });

  it("ignores a mark that arrives after the run was reported", () => {
    let now = 0;
    const clock = new AttachStageClock(() => now);
    clock.mark("submitted");
    const sealed = clock.seal();
    now += 10;
    // An adapter that kept the spec it was handed, marking after its attach.
    clock.mark("late");

    expect(sealed.stages.map(({ stage }) => stage)).toEqual(["submitted"]);
    expect(clock.seal().stages.map(({ stage }) => stage)).toEqual(["submitted"]);
  });
});
