/**
 * Power/link SIMULATION for the two-window acceptance journey. No OS sleep:
 * the real suspend event reports asleep, then only this runner's transport
 * is held down until the real resume event. Never present in a release.
 */
import type { BackendConnection, ConnectBackend } from "@volli/host-core/cloud-runner";

export interface RunnerSleepSimulation {
  wrap(connect: ConnectBackend): ConnectBackend;
  suspend(): Promise<void>;
  resume(): void;
}

const unavailable = () => Promise.reject(new Error("Simulated runner sleep: link held down."));

export function runnerSleepSimulation(input: {
  dev: boolean;
  env: Readonly<Record<string, string | undefined>>;
  emit(event: "suspend" | "resume"): void;
}): RunnerSleepSimulation | null {
  if (!input.dev || input.env["VOLLI_SMOKE_CLOUD_RUNNER_POWER"] !== "1") return null;
  let held = false;
  let reporting: { done(): void; fail(error: unknown): void } | null = null;
  const connections = new Set<() => void>();
  return {
    wrap: (connect) => (token) => {
      if (held) {
        return {
          mutation: unavailable,
          query: unavailable,
          isConnected: () => false,
          onConnectionChange: () => () => {},
          onUpdate: () => () => {},
          close: async () => {},
        } satisfies BackendConnection;
      }
      const live = connect(token);
      let closed = false;
      const listeners = new Set<(connected: boolean) => void>();
      const off = live.onConnectionChange((connected) => {
        if (!closed) for (const listener of listeners) listener(connected && !held);
      });
      const disconnect = () => {
        if (closed) return;
        closed = true;
        off();
        connections.delete(disconnect);
        for (const listener of listeners) listener(false);
        void live.close().catch(() => {});
      };
      connections.add(disconnect);
      return {
        async mutation(name, args) {
          if (held || closed) return unavailable();
          const request = reporting;
          const asleep =
            request !== null && name === "runners:reportState" && args.state === "asleep";
          try {
            const answer = await live.mutation(name, args);
            if (asleep && reporting === request) {
              held = true;
              reporting = null;
              for (const close of connections) close();
              request.done();
            }
            return answer;
          } catch (error) {
            if (asleep && reporting === request) {
              reporting = null;
              request.fail(error);
            }
            throw error;
          }
        },
        query: (name, args) =>
          held || closed ? unavailable() : (live.query?.(name, args) ?? unavailable()),
        isConnected: () => !held && !closed && live.isConnected(),
        onConnectionChange: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        onUpdate: (name, args, listener) =>
          live.onUpdate(name, args, (value) => {
            if (!closed && !held) listener(value);
          }),
        close: async () => {
          if (closed) return;
          closed = true;
          off();
          connections.delete(disconnect);
          await live.close();
        },
      };
    },
    suspend() {
      if (held) return Promise.resolve();
      if (reporting !== null)
        return Promise.reject(new Error("A simulated suspend is already pending."));
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          reporting = null;
          reject(new Error("The runner did not report asleep; simulation refused."));
        }, 3_000);
        reporting = {
          done: () => {
            clearTimeout(timer);
            resolve();
          },
          fail: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        };
        try {
          input.emit("suspend");
        } catch (error) {
          clearTimeout(timer);
          reporting = null;
          reject(error);
        }
      });
    },
    resume() {
      if (!held) throw new Error("The runner is not in simulated sleep.");
      held = false;
      input.emit("resume");
    },
  };
}
