import type { Context } from "@earendil-works/chord";
import { createContextKey } from "@earendil-works/chord/context";
import { NOOP_TELEMETRY_CONTEXT, type TelemetryContext } from "@earendil-works/pi-telemetry";

export type { Context };
export { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";

const TELEMETRY_CONTEXT_KEY = createContextKey<TelemetryContext>("pi.telemetryContext");

/** Return the telemetry parent attached to a context, or the shared no-op parent. */
export function getTelemetryContext(context: Context): TelemetryContext {
  return context.value(TELEMETRY_CONTEXT_KEY) ?? NOOP_TELEMETRY_CONTEXT;
}
