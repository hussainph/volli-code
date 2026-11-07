import { channel } from "node:diagnostics_channel";
import { beforeEach } from "vite-plus/test";

// Published synchronously before fixture hooks. onTestFinished runs after the
// test's teardown too, so a fork lost during cleanup still has an active test.
// The preload writes outside Vitest's buffered console and survives isolation.
const diagnostics = channel("volli.test");
beforeEach(({ task, onTestFinished }) => {
  const identity = { id: task.id, file: task.file.filepath, name: task.name };
  diagnostics.publish({ event: "test-start", ...identity });
  onTestFinished(() => diagnostics.publish({ event: "test-finished", ...identity }));
});
