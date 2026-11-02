/**
 * The Session executor, with its log lines owned by the right operation (VC-699).
 *
 * An executor's attachment outlives the request that opened it: the listeners
 * and timers it registers keep reporting turns long after `sessions.attach`
 * returned. Started inside that request, they would inherit its trace and log
 * every later turn under it. So:
 *
 * - **attach** runs detached: in a fresh root context holding only the
 *   Session and attachment ids, so nothing it starts carries a request's trace.
 * - **dispatch** runs under the trace of the command it delivers: the one the
 *   command was recorded under (a queued follow-up's is its message's), or,
 *   for a command this host never saw recorded, the request's own. What the
 *   executor does on that call's chain (the turn it opens, its tools, the
 *   facts they record) carries that command's trace and id.
 *
 * Work an executor reports from its own listeners carries the Session and
 * attachment, and joins a trace only by identifier (`log/correlation`): a
 * turn's end joins the trace its start had. Otherwise it carries none.
 *
 * Each call's synchronous part is also timed as the Session's main-thread
 * work (VC-1090, `door: "runtime"`): attaching and a dispatch
 * (`dispatch:<kind>`), so a stall there names the Session instead of landing
 * in `unattributed`. The facts an executor reports are timed where they are
 * written (`session-control/session-wake.ts`): its sink only queues them.
 */
import type {
  BindingHandle,
  HarnessCommand,
  NativeAttachmentSpec,
  NativeHarnessAdapter,
  ObservationSink,
} from "@volli/session-engine";

import { logContext, withLogContext, withMainSpan, withRootLogContext } from "../log/context";
import { commandTrace } from "../log/correlation";

export function correlatedExecutor(adapter: NativeHarnessAdapter): NativeHarnessAdapter {
  return {
    id: adapter.id,
    durableIdNamespace: adapter.durableIdNamespace,
    adapterVersion: adapter.adapterVersion,
    runtime: adapter.runtime,
    async attach(spec: NativeAttachmentSpec, sink: ObservationSink): Promise<BindingHandle> {
      const sessionId = spec.sessionId;
      const handle = await withRootLogContext({ sessionId, attachmentId: spec.attachmentId }, () =>
        withMainSpan({ door: "runtime", operation: "attach", sessionId }, () =>
          adapter.attach(spec, sink),
        ),
      );
      return correlatedHandle(handle);
    },
  };
}

function correlatedHandle(handle: BindingHandle): BindingHandle {
  const dispatch = (command: HarnessCommand) => dispatchUnderCommandTrace(handle, command);
  return new Proxy(handle, {
    get(target, property) {
      if (property === "dispatch") return dispatch;
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function"
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}

function dispatchUnderCommandTrace(
  handle: BindingHandle,
  command: HarnessCommand,
): ReturnType<BindingHandle["dispatch"]> {
  return withMainSpan(
    { door: "runtime", operation: `dispatch:${command.kind}`, sessionId: command.sessionId },
    () => dispatchTraced(handle, command),
  );
}

function dispatchTraced(
  handle: BindingHandle,
  command: HarnessCommand,
): ReturnType<BindingHandle["dispatch"]> {
  const ids = {
    sessionId: command.sessionId,
    attachmentId: command.attachmentId,
    commandId: command.commandId,
  };
  const ambient = logContext()["traceId"];
  const owner = commandTrace(command.commandId);
  if (owner === undefined || owner === ambient) {
    // Recorded on this very request, or never seen: the request's own chain.
    return withLogContext(ids, () => handle.dispatch(command));
  }
  return withRootLogContext({ traceId: owner, ...ids }, () => handle.dispatch(command));
}
