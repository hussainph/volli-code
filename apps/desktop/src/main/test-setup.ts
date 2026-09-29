/**
 * What every main-process test file gets whether it asks or not.
 *
 * The one thing here is draining the data-change coalescer. Roughly fifteen
 * mutation sites queue an invalidation, several of them from handlers a test is
 * exercising for some other reason entirely, and the queue is module state that
 * outlives the test that filled it. Left alone it is delivered into the NEXT
 * test's window mock, carrying ids that test never created — and a suite that
 * swaps fake timers for real ones leaves a scope behind that can never drain on
 * its own at all.
 *
 * DISPOSE, not flush. A test that wants the notice asks for it by name
 * (`flushDataChangedForTest`); a test that never looked wants it gone, not
 * delivered somewhere else.
 *
 * Imported dynamically so it resolves AFTER a test file's hoisted `vi.mock`
 * calls: `broadcast.ts` reaches Electron, and most of these files replace that
 * module wholesale.
 */
import { afterEach } from "vite-plus/test";

afterEach(async () => {
  const { resetDataChangedForTest } = await import("./broadcast");
  resetDataChangedForTest();
});
