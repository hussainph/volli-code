import type {
  BindingHandle,
  HarnessCommand,
  NativeAttachmentSpec,
  NativeHarnessAdapter,
  ObservationSink,
} from "@volli/session-engine";
import type { LogRecord, RuntimeObservation } from "@volli/shared";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { installHostLog } from "../log/root";
import { startMainStallMonitor, type MainStallMonitor } from "../log/stall";
import { correlatedExecutor } from "./correlated-executor";

/** Holds the event loop for `ms`, as a slow synchronous fact write would. */
function block(ms: number): void {
  const until = performance.now() + ms;
  while (performance.now() < until) {
    // Busy: nothing else in this process runs until it returns.
  }
}

let records: LogRecord[] = [];
let undoLog: () => void = () => {};
let monitor: MainStallMonitor | null = null;

beforeEach(() => {
  records = [];
  undoLog = installHostLog({ level: "info", sink: { write: (record) => records.push(record) } });
  monitor = startMainStallMonitor({ thresholdMs: 30 });
});

afterEach(() => {
  monitor?.stop();
  undoLog();
});

const stalls = () => records.filter((record) => record.msg === "main stall");

const SPEC = {
  sessionId: "session-1",
  attachmentId: "attachment-1",
  directory: "/fixture",
  continuity: "fresh",
  native: null,
} as unknown as NativeAttachmentSpec;

describe("the Session runtime's main-thread spans (VC-1090)", () => {
  it("attributes a blocking attach and dispatch to the Session, observations passed through", async () => {
    let reported: ObservationSink | null = null;
    const adapter: NativeHarnessAdapter = {
      id: "fake",
      durableIdNamespace: "fake",
      adapterVersion: "1.0.0",
      runtime: { path: "/trusted/fake", version: "1.0.0", fingerprint: "sha256:fake" },
      async attach(_spec, sink): Promise<BindingHandle> {
        reported = sink;
        block(40);
        return {
          native: { id: "native-1", detail: null },
          dispatch: async () => {
            block(40);
            return { status: "accepted" } as never;
          },
          reconcile: async () => ({ cursor: null, observations: [], receipts: [] }),
          release: async () => {},
        } as unknown as BindingHandle;
      },
    };
    const written: RuntimeObservation[] = [];
    const engineSink: ObservationSink = {
      emit: async (observation) => {
        written.push(observation);
      },
    };
    const handle = await correlatedExecutor(adapter).attach(SPEC, engineSink);
    const observation = { kind: "usage" } as unknown as RuntimeObservation;
    await reported!.emit(observation);
    expect(written).toEqual([observation]);
    await expect(
      handle.dispatch({
        kind: "message.submit",
        sessionId: "session-1",
        attachmentId: "attachment-1",
        commandId: "command-1",
      } as unknown as HarnessCommand),
    ).resolves.toEqual({ status: "accepted" });
    expect(reported).toBe(engineSink);
    expect(stalls()).toEqual([
      expect.objectContaining({
        attribution: "span",
        door: "runtime",
        operation: "attach",
        sessionId: "session-1",
      }),
      expect.objectContaining({
        attribution: "span",
        door: "runtime",
        operation: "dispatch:message.submit",
        sessionId: "session-1",
      }),
    ]);
  });
});
