import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { NOOP_OBSERVABILITY_SINK, type ObservabilityEvent } from "@volli/shared";

import { setAppState } from "../db/app-state-repo";
import { openTestDb, type TestDb } from "../db/test-helpers";
import {
  AGENT_OBSERVABILITY_APP_STATE_KEY,
  AgentObservability,
  AgentObservabilityError,
  admitCollectorEndpoint,
  DEFAULT_COLLECTOR_ENDPOINT,
} from "./settings";
import type { ObservabilityExporter, RecordedObservabilityEvent } from "./sink";
import type { OtlpExporterOptions } from "./otlp";

const toolEvent: ObservabilityEvent = {
  kind: "tool",
  activityKind: "read-file",
  outcome: "completed",
};

/** A transport that keeps what it is given and can fail delivery on demand. */
class FakeExporter implements ObservabilityExporter {
  batches: RecordedObservabilityEvent[][] = [];
  shutdowns = 0;

  export(batch: readonly RecordedObservabilityEvent[]): void {
    this.batches.push([...batch]);
  }

  async flush(): Promise<void> {}

  async shutdown(): Promise<void> {
    this.shutdowns += 1;
  }
}

/** Captures every exporter the owner builds, and what it was told to build. */
function exporterFactory() {
  const built: { options: OtlpExporterOptions; exporter: FakeExporter }[] = [];
  let refuseToBuild = false;
  return {
    built,
    refuse: () => {
      refuseToBuild = true;
    },
    create: (options: OtlpExporterOptions): ObservabilityExporter => {
      if (refuseToBuild) throw new Error("transport refused");
      const exporter = new FakeExporter();
      built.push({ options, exporter });
      return exporter;
    },
  };
}

describe("admitCollectorEndpoint", () => {
  it("admits an ordinary collector address, normalized to its origin", () => {
    expect(admitCollectorEndpoint("http://localhost:4318")).toEqual({
      outcome: "admit",
      endpoint: "http://localhost:4318",
    });
    expect(admitCollectorEndpoint("  https://Collector.internal:4318  ")).toEqual({
      outcome: "admit",
      endpoint: "https://collector.internal:4318",
    });
  });

  it("admits the trailing slash a browser adds, because it is the same address", () => {
    expect(admitCollectorEndpoint("http://localhost:4318/")).toEqual({
      outcome: "admit",
      endpoint: "http://localhost:4318",
    });
  });

  it("refuses an empty address", () => {
    expect(admitCollectorEndpoint("   ")).toEqual({
      outcome: "refuse",
      reason: "Enter your collector's address.",
    });
  });

  it("refuses something that is not an address at all", () => {
    expect(admitCollectorEndpoint("not an address").outcome).toBe("refuse");
  });

  it("refuses a scheme that is not HTTP", () => {
    for (const typed of ["ftp://localhost:4318", "file:///tmp", "grpc://localhost:4317"]) {
      expect(admitCollectorEndpoint(typed)).toEqual({
        outcome: "refuse",
        reason: "The address must start with http:// or https://.",
      });
    }
  });

  it("refuses an address with no host, because the URL parser will not build one", () => {
    expect(admitCollectorEndpoint("http://")).toEqual({
      outcome: "refuse",
      reason: "This is not a valid address.",
    });
    expect(admitCollectorEndpoint("http://:4318").outcome).toBe("refuse");
  });

  it("refuses credentials rather than storing a secret in the clear", () => {
    expect(admitCollectorEndpoint("http://user:pw@localhost:4318")).toEqual({
      outcome: "refuse",
      reason: "Remove the username and password from the address.",
    });
    expect(admitCollectorEndpoint("http://user@localhost:4318").outcome).toBe("refuse");
  });

  it("refuses a path, query or fragment, because the exporter would discard it", () => {
    for (const typed of [
      "http://localhost:4318/v1/traces",
      "http://localhost:4318/?token=abc",
      "http://localhost:4318/#frag",
    ]) {
      expect(admitCollectorEndpoint(typed).outcome).toBe("refuse");
    }
  });
});

describe("AgentObservability", () => {
  let ctx: TestDb;

  beforeEach(() => {
    ctx = openTestDb();
  });

  afterEach(() => {
    ctx.cleanup();
  });

  const owner = (factory?: ReturnType<typeof exporterFactory>): AgentObservability =>
    new AgentObservability({
      db: ctx.db,
      serviceVersion: "0.0.0-test",
      now: () => 1000,
      ...(factory === undefined ? {} : { createExporter: factory.create }),
    });

  it("is off for a profile that has never configured anything", () => {
    const observability = owner();
    observability.start();
    expect(observability.view()).toEqual({
      enabled: false,
      endpoint: DEFAULT_COLLECTOR_ENDPOINT,
      status: "off",
      problem: null,
    });
  });

  it("records into the no-op sink while it is off", () => {
    const factory = exporterFactory();
    const observability = owner(factory);
    observability.start();
    observability.record(toolEvent);
    expect(factory.built).toEqual([]);
  });

  it("builds no transport at all until a person turns it on", () => {
    const factory = exporterFactory();
    owner(factory).start();
    expect(factory.built).toEqual([]);
  });

  it("starts exporting when the setting is on, and says so", () => {
    const factory = exporterFactory();
    const first = owner(factory);
    first.configure({ enabled: true, endpoint: "http://localhost:4318" });
    expect(first.view()).toEqual({
      enabled: true,
      endpoint: "http://localhost:4318",
      status: "exporting",
      problem: null,
    });
    // The decision is durable: a later launch reads it back and starts.
    const next = owner(factory);
    next.start();
    expect(next.view().status).toBe("exporting");
    expect(factory.built).toHaveLength(2);
    expect(factory.built[0]?.options.endpoint).toBe("http://localhost:4318");
    expect(factory.built[0]?.options.serviceVersion).toBe("0.0.0-test");
  });

  it("delivers recorded events to the live transport", async () => {
    const factory = exporterFactory();
    const observability = owner(factory);
    observability.configure({ enabled: true, endpoint: "http://localhost:4318" });
    observability.record(toolEvent);
    await observability.shutdown(100);
    expect(factory.built[0]?.exporter.batches.flat().map((entry) => entry.event)).toEqual([
      toolEvent,
    ]);
  });

  it("refuses an address that is not one, before it is stored", () => {
    const factory = exporterFactory();
    const observability = owner(factory);
    expect(() => observability.configure({ enabled: true, endpoint: "nope" })).toThrow(
      AgentObservabilityError,
    );
    expect(observability.view()).toEqual({
      enabled: false,
      endpoint: DEFAULT_COLLECTOR_ENDPOINT,
      status: "off",
      problem: null,
    });
    expect(factory.built).toEqual([]);
  });

  it("stores the normalized address, so what is shown is what is used", () => {
    const observability = owner(exporterFactory());
    const view = observability.configure({ enabled: true, endpoint: "http://LOCALHOST:4318/" });
    expect(view.endpoint).toBe("http://localhost:4318");
  });

  it("turns export off again, releasing the transport", () => {
    const factory = exporterFactory();
    const observability = owner(factory);
    observability.configure({ enabled: true, endpoint: "http://localhost:4318" });
    observability.configure({ enabled: false, endpoint: "http://localhost:4318" });
    expect(observability.view().status).toBe("off");
    observability.record(toolEvent);
    expect(factory.built[0]?.exporter.batches).toEqual([]);
  });

  it("turns export off even when the address field holds nonsense", () => {
    const factory = exporterFactory();
    const observability = owner(factory);
    observability.configure({ enabled: true, endpoint: "http://localhost:4318" });

    // Somebody mistyped the address and then reached for the off switch. The
    // switch and the field are saved together, so the bad value arrives with
    // the decision to stop — and being told to repair a field in order to stop
    // using it would leave them unable to turn telemetry off at all.
    const view = observability.configure({ enabled: false, endpoint: "nope" });

    expect(view.status).toBe("off");
    // The abandoned value is not adopted; the last good address survives, so
    // switching back on does not need it retyped.
    expect(view.endpoint).toBe("http://localhost:4318");
    observability.record(toolEvent);
    expect(factory.built[0]?.exporter.batches).toEqual([]);
  });

  it("still refuses a bad address when it is being asked to carry telemetry", () => {
    const observability = owner(exporterFactory());
    // The same value, the opposite decision: this one is asking Volli to send
    // somewhere, so it has to be somewhere.
    expect(() => observability.configure({ enabled: true, endpoint: "nope" })).toThrow(
      AgentObservabilityError,
    );
  });

  it("replaces the transport when the address changes", () => {
    const factory = exporterFactory();
    const observability = owner(factory);
    observability.configure({ enabled: true, endpoint: "http://localhost:4318" });
    observability.configure({ enabled: true, endpoint: "http://localhost:4319" });
    expect(factory.built.map((entry) => entry.options.endpoint)).toEqual([
      "http://localhost:4318",
      "http://localhost:4319",
    ]);
  });

  it("latches a transport that would not start, and keeps the app running", () => {
    const factory = exporterFactory();
    factory.refuse();
    const observability = owner(factory);
    observability.configure({ enabled: true, endpoint: "http://localhost:4318" });
    expect(observability.view()).toEqual({
      enabled: true,
      endpoint: "http://localhost:4318",
      status: "failed",
      problem: "Volli could not start exporting to this address.",
    });
    // Still a working sink from the runtime's side.
    expect(() => observability.record(toolEvent)).not.toThrow();
  });

  it("surfaces the first delivery failure once, and never repeats it", () => {
    const factory = exporterFactory();
    const observability = owner(factory);
    observability.configure({ enabled: true, endpoint: "http://localhost:4318" });
    const report = factory.built[0]?.options.onDeliveryFailure;
    report?.(new Error("connection refused"));
    report?.(new Error("connection refused"));
    report?.(new Error("still refused"));
    expect(observability.view()).toEqual({
      enabled: true,
      endpoint: "http://localhost:4318",
      status: "failed",
      problem: "Nothing is answering at this address.",
    });
  });

  it("clears the latched problem when the configuration changes", () => {
    const factory = exporterFactory();
    const observability = owner(factory);
    observability.configure({ enabled: true, endpoint: "http://localhost:4318" });
    factory.built[0]?.options.onDeliveryFailure?.(new Error("connection refused"));
    expect(observability.view().problem).not.toBeNull();
    observability.configure({ enabled: true, endpoint: "http://localhost:4319" });
    expect(observability.view()).toEqual({
      enabled: true,
      endpoint: "http://localhost:4319",
      status: "exporting",
      problem: null,
    });
  });

  it("latches a stored setting that will not start, rather than failing the launch", () => {
    const factory = exporterFactory();
    factory.refuse();
    setAppState(
      ctx.db,
      AGENT_OBSERVABILITY_APP_STATE_KEY,
      JSON.stringify({ enabled: true, endpoint: "http://localhost:4318" }),
      0,
    );
    const observability = owner(factory);
    expect(() => observability.start()).not.toThrow();
    expect(observability.view().status).toBe("failed");
  });

  it("reads a corrupt or hostile stored row as off", () => {
    for (const value of ["not json", '"a string"', "null", '{"enabled":"yes"}', "[]"]) {
      setAppState(ctx.db, AGENT_OBSERVABILITY_APP_STATE_KEY, value, 0);
      const observability = owner(exporterFactory());
      observability.start();
      expect(observability.view().enabled).toBe(false);
    }
  });

  it("falls back to the default address when the stored one is no longer admissible", () => {
    setAppState(
      ctx.db,
      AGENT_OBSERVABILITY_APP_STATE_KEY,
      JSON.stringify({ enabled: false, endpoint: "ftp://elsewhere" }),
      0,
    );
    const observability = owner(exporterFactory());
    expect(observability.view().endpoint).toBe(DEFAULT_COLLECTOR_ENDPOINT);
    // A missing endpoint is the same situation.
    setAppState(ctx.db, AGENT_OBSERVABILITY_APP_STATE_KEY, JSON.stringify({ enabled: false }), 0);
    expect(owner(exporterFactory()).view().endpoint).toBe(DEFAULT_COLLECTOR_ENDPOINT);
  });

  it("shuts the transport down once and is safe to call again", async () => {
    const factory = exporterFactory();
    const observability = owner(factory);
    observability.configure({ enabled: true, endpoint: "http://localhost:4318" });
    await observability.shutdown(100);
    await observability.shutdown(100);
    expect(factory.built[0]?.exporter.shutdowns).toBe(1);
    expect(observability.view().status).toBe("failed");
  });

  it("shuts down cleanly when nothing was ever started", async () => {
    await expect(owner(exporterFactory()).shutdown(100)).resolves.toBeUndefined();
  });

  it("does not let a transport that fails to close hold the quit", async () => {
    const hostile: ObservabilityExporter = {
      export: () => {},
      flush: async () => {},
      shutdown: () => Promise.reject(new Error("already gone")),
    };
    const observability = new AgentObservability({
      db: ctx.db,
      serviceVersion: "0.0.0-test",
      createExporter: () => hostile,
    });
    observability.configure({ enabled: true, endpoint: "http://localhost:4318" });
    await expect(observability.shutdown(100)).resolves.toBeUndefined();
  });

  it("does not let a transport that fails to close break a reconfigure", async () => {
    const hostile: ObservabilityExporter = {
      export: () => {},
      flush: async () => {},
      shutdown: () => Promise.reject(new Error("already gone")),
    };
    const observability = new AgentObservability({
      db: ctx.db,
      serviceVersion: "0.0.0-test",
      createExporter: () => hostile,
    });
    observability.configure({ enabled: true, endpoint: "http://localhost:4318" });
    // Replacing the transport tears the old one down without awaiting it; the
    // rejection must be absorbed rather than surfacing as an unhandled one.
    expect(() =>
      observability.configure({ enabled: true, endpoint: "http://localhost:4319" }),
    ).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(observability.view().status).toBe("exporting");
  });

  it("defaults to the real OTLP transport when none is injected", async () => {
    const observability = new AgentObservability({ db: ctx.db, serviceVersion: "0.0.0-test" });
    // Constructing the real exporter opens nothing: the transport connects on
    // the first batch, and nothing is recorded before this shuts down again.
    observability.configure({ enabled: true, endpoint: "http://127.0.0.1:1" });
    expect(observability.view()).toEqual({
      enabled: true,
      endpoint: "http://127.0.0.1:1",
      status: "exporting",
      problem: null,
    });
    await observability.shutdown(500);
  });

  it("is the disabled sink itself while it is off", () => {
    const observability = owner(exporterFactory());
    // The shape the runtime is handed: a sink, always, never an undefined check.
    expect(typeof observability.record).toBe("function");
    expect(typeof NOOP_OBSERVABILITY_SINK.record).toBe("function");
  });
});
