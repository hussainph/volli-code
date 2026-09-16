#!/usr/bin/env node
/**
 * VC-387 — what one `volli:data-changed` costs the renderer.
 *
 * Measures the SQLite half of `refreshPlanningData`: the read `data.bootstrap`
 * performs on every broadcast, against the two narrower reads VC-387 proposes
 * (one project's roster; nothing at all), on a board the size of a busy
 * install. The renderer half (hydrate + re-render) is NOT measured here — this
 * is the cost of the read that makes the person wait, which is what the ticket
 * names.
 *
 * Deliberately a micro-bench over the real repos and the real migrations
 * rather than a full-app run: the question is the shape of the read, and the
 * full-app harness (`e2e/bench/performance/run.mjs`) takes twenty minutes to
 * answer a question this one answers in seconds. Numbers are comparable only
 * within one run on one machine.
 *
 *   node apps/desktop/e2e/board-refresh-bench.mjs [--projects N] [--tickets N]
 *     [--body-bytes N] [--agents N] [--repetitions N] [--json PATH]
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFile } from "node:fs/promises";
import os from "node:os";

import { createServer } from "vite";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_DIR = resolve(HERE, "..");

function parseArgs(argv) {
  const args = {
    projects: 4,
    tickets: 98,
    bodyBytes: 2_400,
    agents: 12,
    repetitions: 60,
    json: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--projects") args.projects = Number(argv[++i]);
    else if (flag === "--tickets") args.tickets = Number(argv[++i]);
    else if (flag === "--body-bytes") args.bodyBytes = Number(argv[++i]);
    else if (flag === "--agents") args.agents = Number(argv[++i]);
    else if (flag === "--repetitions") args.repetitions = Number(argv[++i]);
    else if (flag === "--json") args.json = argv[++i];
    else throw new Error(`Unknown argument ${flag}`);
  }
  return args;
}

/** Deterministic prose of about `bytes` bytes — a ticket body, not random noise. */
function body(bytes, seed) {
  const words = [
    "the",
    "renderer",
    "re-reads",
    "every",
    "live",
    "ticket",
    "body",
    "included",
    "on",
    "each",
    "broadcast",
    "which",
    "a",
    "dozen",
    "agents",
    "make",
    "per",
    "turn",
  ];
  let out = `## Scope ${seed}\n\n`;
  let i = seed;
  while (out.length < bytes) {
    out += `${words[i % words.length]} `;
    i += 1;
    if (i % 17 === 0) out += "\n";
  }
  return out.slice(0, bytes);
}

/** Median and p95 of a sample, in milliseconds. */
function summarize(samples) {
  const sorted = samples.toSorted((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return {
    median: Number(at(0.5).toFixed(3)),
    p95: Number(at(0.95).toFixed(3)),
    min: Number(sorted[0].toFixed(3)),
    max: Number(sorted[sorted.length - 1].toFixed(3)),
  };
}

function measure(label, repetitions, run) {
  run(); // warm the prepared statements — the app's are warm too
  const samples = [];
  for (let i = 0; i < repetitions; i += 1) {
    const started = performance.now();
    run();
    samples.push(performance.now() - started);
  }
  return { label, ...summarize(samples) };
}

async function loadMainModules() {
  const vite = await createServer({
    root: APP_DIR,
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
    logLevel: "error",
  });
  try {
    const load = (path) => vite.ssrLoadModule(resolve(APP_DIR, path));
    const [migrations, projects, tickets, labels, appState, shared] = await Promise.all([
      load("src/main/db/migrations.ts"),
      load("src/main/db/projects-repo.ts"),
      load("src/main/db/tickets-repo.ts"),
      load("src/main/db/labels-repo.ts"),
      load("src/main/db/app-state-repo.ts"),
      vite.ssrLoadModule("@volli/shared"),
    ]);
    return { vite, migrations, projects, tickets, labels, appState, shared };
  } catch (error) {
    await vite.close();
    throw error;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const mods = await loadMainModules();
  const { default: Database } = await import(
    join(APP_DIR, "node_modules/better-sqlite3/lib/index.js")
  );

  const dir = mkdtempSync(join(tmpdir(), "volli-vc387-bench-"));
  const dbPath = join(dir, "volli.db");
  const db = new Database(dbPath);
  db.pragma("foreign_keys = ON");
  mods.migrations.migrate(db, dbPath);

  const projectIds = [];
  const seed = db.transaction(() => {
    for (let p = 0; p < args.projects; p += 1) {
      const projectId = `bench-project-${p}`;
      projectIds.push(projectId);
      mods.projects.insertProject(db, {
        id: projectId,
        name: `Bench ${p}`,
        path: `/bench/project-${p}`,
        ticketPrefix: `B${p}`,
        baseBranch: null,
        setupCommand: null,
        colorIndex: 0,
        sortOrder: p,
        createdAt: 0,
        updatedAt: 0,
      });
      const labelIds = ["perf", "infra", "ui"].map(
        (name) => mods.labels.getOrCreateLabel(db, projectId, name, 0).id,
      );
      for (let t = 0; t < args.tickets; t += 1) {
        const ticket = mods.shared.createTicket({
          id: `bench-ticket-${p}-${t}`,
          projectId,
          ticketNumber: t + 1,
          title: `Bench ticket ${p}-${t}`,
          status: ["backlog", "todo", "doing", "needs_review", "done"][t % 5],
          order: t,
          now: 0,
          body: body(args.bodyBytes, t),
        });
        mods.tickets.insertTicket(db, ticket);
        mods.labels.addTicketLabel(db, ticket.id, labelIds[t % labelIds.length]);
      }
    }
  });
  seed();

  const hotProject = projectIds[0];

  // What `data.bootstrap` does today, every broadcast (see buildBootstrapPayload).
  const wholeBoard = () => {
    const projects = mods.projects.listProjects(db);
    const appState = mods.appState.getAllAppState(db);
    const all = mods.tickets.listAllTickets(db);
    const allLabels = mods.labels.listAllLabels(db);
    return projects.length + all.length + allLabels.length + Object.keys(appState).length;
  };
  // Fix shape 1: one project's roster.
  const oneProject = () => {
    const rows = mods.tickets.listTicketsByProject(db, hotProject);
    const labels = mods.labels.listLabelsByProject(db, hotProject);
    return rows.length + labels.length;
  };

  // The read is only half of what a broadcast costs: the payload is then
  // structured-cloned across the IPC boundary (main → every window) before the
  // renderer hydrates it. `structuredClone` is measured here as the closest
  // in-process stand-in for that copy, and the JSON length as the size that
  // crosses.
  const wholePayload = {
    projects: mods.projects.listProjects(db),
    appState: mods.appState.getAllAppState(db),
    tickets: mods.tickets.listAllTickets(db),
    labels: mods.labels.listAllLabels(db),
  };
  const scopedPayload = {
    tickets: mods.tickets.listTicketsByProject(db, hotProject),
    labels: mods.labels.listLabelsByProject(db, hotProject),
  };
  const bodylessPayload = {
    ...scopedPayload,
    tickets: scopedPayload.tickets.map(({ body: _body, ...rest }) => rest),
  };

  const rows = [
    measure("data.bootstrap (whole board, today)", args.repetitions, wholeBoard),
    measure("one project's roster (fix shape 1)", args.repetitions, oneProject),
    measure("IPC copy of the whole board", args.repetitions, () => structuredClone(wholePayload)),
    measure("IPC copy of one project", args.repetitions, () => structuredClone(scopedPayload)),
    measure("IPC copy of one project, no bodies (shape 2)", args.repetitions, () =>
      structuredClone(bodylessPayload),
    ),
  ];

  const bytes = {
    wholeBoard: JSON.stringify(wholePayload).length,
    oneProject: JSON.stringify(scopedPayload).length,
    oneProjectNoBodies: JSON.stringify(bodylessPayload).length,
  };

  const whole = rows[0];
  const scoped = rows[1];
  const turn = {
    agents: args.agents,
    todayMs: Number((whole.median * args.agents).toFixed(3)),
    scopedMs: Number((scoped.median * args.agents).toFixed(3)),
    commentSkipMs: 0,
  };

  const report = {
    generatedAt: new Date().toISOString(),
    machine: {
      platform: process.platform,
      arch: process.arch,
      cores: os.availableParallelism?.() ?? os.cpus().length,
      node: process.version,
    },
    board: {
      projects: args.projects,
      ticketsPerProject: args.tickets,
      liveTickets: args.projects * args.tickets,
      bodyBytes: args.bodyBytes,
    },
    reads: rows,
    payloadBytes: bytes,
    perRoundOfComments: turn,
  };

  console.log(
    `\nBoard: ${report.board.liveTickets} live tickets across ${args.projects} projects, ${args.bodyBytes}B bodies\n`,
  );
  for (const row of rows) {
    console.log(
      `  ${row.label.padEnd(46)} median ${String(row.median).padStart(8)} ms   p95 ${String(row.p95).padStart(8)} ms`,
    );
  }
  console.log(
    `\n  payload across the wire: whole board ${(bytes.wholeBoard / 1024).toFixed(0)} KiB, ` +
      `one project ${(bytes.oneProject / 1024).toFixed(0)} KiB, ` +
      `one project without bodies ${(bytes.oneProjectNoBodies / 1024).toFixed(0)} KiB`,
  );
  console.log(
    `\n  ${args.agents} agents, one comment each (one turn):\n` +
      `    today                         ${turn.todayMs} ms of SQLite reads\n` +
      `    scoped to the changed project ${turn.scopedMs} ms\n` +
      `    comment does not read         ${turn.commentSkipMs} ms\n`,
  );

  if (args.json !== null) {
    await writeFile(args.json, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`  wrote ${args.json}`);
  }

  db.close();
  rmSync(dir, { recursive: true, force: true });
  await mods.vite.close();
}

await main();
