import { afterEach, beforeEach, describe } from "vite-plus/test";
import { requireExperimentId, type ExperimentId } from "@volli/shared";

import { ExperimentalSettings, installExperimentalSettings } from "../experiments";

/**
 * Run a reader-gated suite with one flag on, without environment or database
 * writes. Example: describeWithExperiment("cloud", () => { it(...); }).
 * The prior reader is restored after each test, including a failed test.
 * Like other process-global fixtures, use serial tests, not it.concurrent.
 */
export function describeWithExperiment(id: ExperimentId, suite: () => void): void {
  requireExperimentId(id);
  describe(`with experiment ${id}`, () => {
    let restore: () => void;
    beforeEach(() => {
      restore = installExperimentalSettings(new ExperimentalSettings(null, id, "dev"));
    });
    afterEach(() => restore());
    suite();
  });
}
