/** Exclusive renderer CPU time, NOT GPU duration or presentation latency.
 * Clip to marked measurement windows and the measured renderer's pid. Nested
 * script/layout events cannot double count. Raw traces remain the evidence.
 */
const category = (name) => {
  if (["UpdateLayoutTree", "Layout", "RecalculateStyles"].includes(name)) return "styleLayout";
  if (["PrePaint", "Paint", "PaintImage"].includes(name)) return "paint";
  if (["Layerize", "CompositeLayers", "Commit"].includes(name)) return "compositePreparation";
  if (
    ["FunctionCall", "EvaluateScript", "RunMicrotasks", "EventDispatch", "V8.Execute"].includes(
      name,
    )
  )
    return "script";
  return null;
};
export function tracePhases(parsed, pid, expectedWindows = 1) {
  const events = Array.isArray(parsed) ? parsed : parsed.traceEvents;
  if (!Array.isArray(events)) throw new Error("missing trace events");
  const thread = events.find(
    (event) =>
      event.pid === pid &&
      event.ph === "M" &&
      event.name === "thread_name" &&
      event.args?.name === "CrRendererMain",
  )?.tid;
  if (thread === undefined) throw new Error("measured renderer thread missing from trace");
  const marks = events
    .filter(
      (event) =>
        event.pid === pid &&
        event.tid === thread &&
        ["chat-bench:start", "chat-bench:end"].includes(event.name),
    )
    .toSorted((a, b) => a.ts - b.ts);
  if (marks.length !== expectedWindows * 2) throw new Error("incomplete trace measurement windows");
  const windows = [];
  for (let i = 0; i < marks.length; i += 2) {
    if (
      marks[i].name !== "chat-bench:start" ||
      marks[i + 1].name !== "chat-bench:end" ||
      marks[i + 1].ts <= marks[i].ts
    )
      throw new Error("overlapping or invalid trace measurement windows");
    windows.push([marks[i].ts, marks[i + 1].ts]);
  }
  const totals = { script: 0, styleLayout: 0, paint: 0, compositePreparation: 0 };
  const complete = events.filter(
    (event) =>
      event.pid === pid &&
      event.tid === thread &&
      event.ph === "X" &&
      event.dur > 0 &&
      category(event.name),
  );
  for (const [start, end] of windows) {
    const edges = [];
    for (const event of complete) {
      const left = Math.max(start, event.ts),
        right = Math.min(end, event.ts + event.dur);
      if (right > left) {
        edges.push({ ts: left, event, start: true }, { ts: right, event, start: false });
      }
    }
    const active = new Set();
    let prior = start;
    for (const edge of edges.toSorted((a, b) => a.ts - b.ts)) {
      // The innermost recognized event owns this slice of CPU time.
      const inner = [...active].toSorted((a, b) => b.ts - a.ts || a.dur - b.dur)[0];
      if (inner) totals[category(inner.name)] += (edge.ts - prior) / 1000;
      if (edge.start) active.add(edge.event);
      else active.delete(edge.event);
      prior = edge.ts;
    }
  }
  return {
    unit: "ms",
    windows: windows.length,
    measuredMs: windows.reduce((sum, [start, end]) => sum + (end - start) / 1000, 0),
    ...totals,
    compositeMeaning: "main-thread preparation only; not GPU/presentation duration",
  };
}
