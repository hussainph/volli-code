import { readFile } from "node:fs/promises";
/** One probe series as the line the report prints: count, mean and spread. */
function stats(values) {
  if (!Array.isArray(values) || values.length === 0) return "none";
  const sorted = values.toSorted((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
  const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
  return `n=${sorted.length} mean=${mean.toFixed(2)} p50=${at(0.5).toFixed(2)} p95=${at(0.95).toFixed(2)} max=${sorted.at(-1).toFixed(2)}`;
}

/**
 * A Chromium trace as renderer main-thread milliseconds per lifecycle phase.
 * The main thread belongs to the measured renderer; `forced*` is the share of
 * style/layout that script asked for synchronously (nested inside a call)
 * rather than the frame's own pass.
 */
const round = (value) => Math.round(value * 10) / 10;

async function traceSummary(file, pid) {
  const parsed = JSON.parse(await readFile(file, "utf8"));
  const events = Array.isArray(parsed) ? parsed : parsed.traceEvents;
  const busy = new Map();
  const mains = new Set();
  for (const event of events) {
    const thread = `${event.pid}:${event.tid}`;
    if (
      event.pid === pid &&
      event.ph === "M" &&
      event.name === "thread_name" &&
      event.args?.name === "CrRendererMain"
    ) {
      mains.add(thread);
    }
    if (event.ph === "X") busy.set(thread, (busy.get(thread) ?? 0) + (event.dur ?? 0));
  }
  const main = [...mains].toSorted((a, b) => (busy.get(b) ?? 0) - (busy.get(a) ?? 0))[0];
  const marks = events
    .filter(
      (event) =>
        `${event.pid}:${event.tid}` === main &&
        ["chat-bench:start", "chat-bench:end"].includes(event.name),
    )
    .toSorted((a, b) => a.ts - b.ts);
  const complete = [];
  for (let i = 0; i < marks.length; i += 2) {
    for (const event of events.filter(
      (candidate) => `${candidate.pid}:${candidate.tid}` === main && candidate.ph === "X",
    )) {
      const start = Math.max(event.ts, marks[i].ts);
      const end = Math.min(event.ts + event.dur, marks[i + 1].ts);
      if (end > start) complete.push({ ...event, ts: start, dur: end - start });
    }
  }
  complete.sort((a, b) => a.ts - b.ts || b.dur - a.dur);
  const phases = ["FunctionCall", "UpdateLayoutTree", "Layout", "PrePaint", "Paint", "Layerize"];
  const totals = Object.fromEntries(phases.map((name) => [name, 0]));
  const forced = { UpdateLayoutTree: 0, Layout: 0 };
  let styleElements = 0;
  const stack = [];
  for (const event of complete) {
    while (stack.length > 0 && stack.at(-1).ts + stack.at(-1).dur <= event.ts) stack.pop();
    const inScript = stack.some((open) => open.name === "FunctionCall");
    if (event.name in totals && !(event.name === "FunctionCall" && inScript)) {
      totals[event.name] += event.dur / 1000;
    }
    if (event.name in forced && inScript) forced[event.name] += event.dur / 1000;
    if (event.name === "UpdateLayoutTree") styleElements += event.args?.elementCount ?? 0;
    stack.push(event);
  }
  return {
    ...Object.fromEntries(Object.entries(totals).map(([name, ms]) => [name, round(ms)])),
    forcedStyle: round(forced.UpdateLayoutTree),
    forcedLayout: round(forced.Layout),
    styleElements,
  };
}

export async function printReport(report, STREAM_TOKEN_RATE) {
  console.log(`\n=== ${report.label}: ${report.sessions} sessions x ${report.turns} turns ===`);
  console.log(
    ["step", "DOM nodes", "renderer RSS MB", "spread", "JS heap MB"].join("\t"),
    "\n" +
      report.steps
        .map((step) =>
          [step.step, step.nodes, step.rendererRssMb, step.rssSpreadMb, step.jsHeapMb].join("\t"),
        )
        .join("\n"),
  );
  console.log("\nchecks:", JSON.stringify(report.checks, null, 2));
  if (report.streamingSamples?.length > 0) {
    const latencies = report.streamingSamples.map((sample) =>
      sample.ok === true ? sample.latencyMs.toFixed(1) : "failed",
    );
    const dropped = report.streamingSamples.map((sample) =>
      sample.ok === true ? sample.droppedFrames : "failed",
    );
    const longTasks = report.streamingSamples.map((sample) =>
      sample.ok === true ? sample.longTasksMs.length : "failed",
    );
    console.log(
      `stream+scroll (${STREAM_TOKEN_RATE} tokens/s): latency ms [${latencies.join(", ")}], ` +
        `dropped [${dropped.join(", ")}], long tasks [${longTasks.join(", ")}]`,
    );
  }
  if (report.draftTyping !== undefined) {
    const typing = report.draftTyping;
    console.log(
      `\ndraft typing (${typing.typedCharacters} chars, ${typing.nodes} DOM nodes, empty state ${typing.emptyStateMounted ? "mounted" : "ABSENT"}):`,
    );
    console.log(`  input handler ms   ${stats(typing.handlerMs)}`);
    console.log(`  key->paint ms      ${stats(typing.latencyMs)}`);
    const longTotal = (typing.longTasksMs ?? []).reduce((sum, value) => sum + value, 0);
    console.log(
      `  long tasks         ${typing.longTasksMs?.length ?? 0} (${longTotal.toFixed(0)} ms total)`,
    );
  }
  if (report.revealSwitch !== undefined) {
    const reveal = report.revealSwitch;
    console.log(`\nchat switch, kept views revealed (${reveal.nodes} DOM nodes):`);
    console.log(`  click handler ms   ${stats(reveal.handlerMs)}`);
    console.log(`  click->paint ms    ${stats(reveal.latencyMs)}`);
    const longTotal = (reveal.longTasksMs ?? []).reduce((sum, value) => sum + value, 0);
    console.log(
      `  long tasks         ${reveal.longTasksMs?.length ?? 0} (${longTotal.toFixed(0)} ms total)`,
    );
    if (report.revealTrace !== undefined) {
      const summary = await traceSummary(report.revealTrace, report.measuredRendererPid);
      const presses = reveal.handlerMs?.length || 1;
      console.log(`  main thread, ms per press (trace ${report.revealTrace}):`);
      for (const [name, ms] of Object.entries(summary)) {
        const value =
          name === "styleElements" ? Math.round(ms / presses) : (ms / presses).toFixed(1);
        console.log(`    ${name.padEnd(18)} ${value}`);
      }
    }
  }
  if (report.phases)
    console.log("  exclusive renderer CPU phases ms:", JSON.stringify(report.phases));
  if (report.errors?.length > 0) console.log("console errors:", report.errors.slice(0, 5));
  if (report.failure !== undefined) {
    console.error("\nbench failed:", report.failure);
    process.exitCode = 1;
  }
}
