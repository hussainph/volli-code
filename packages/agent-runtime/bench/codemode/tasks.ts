/**
 * VC-471's four benchmark tasks, as fixtures a real Session runs against.
 *
 * Each task builds what its tools answer from — a worktree on disk, Browser
 * pages, a verb host — and grades the model's final answer against a key it
 * computed itself. The shapes are VC-245's: a `bash`/`read` loop-and-filter
 * task (the 95% of the measured gain), a multi-tab Browser task, a
 * multi-Session start-and-watch task, and a single direct call as the control.
 */

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  RuntimeBrowserPort,
  RuntimeBrowserSnapshot,
  RuntimeVerbCall,
  RuntimeVerbResult,
  SessionRuntimeSpec,
} from "@volli/shared";

export type TaskId =
  | "loop-filter"
  | "browser-tabs"
  | "session-fanout"
  | "single-call"
  | "browser-crawl"
  | "edit-loop";

export interface TaskRun {
  /** What the Session is given beyond its coding tools. */
  spec: Partial<SessionRuntimeSpec>;
  role: "ticket" | "project";
  workspacePath: string;
  prompt: string;
  /** Whether the final answer is right, and the side effects the task needs happened. */
  grade(answer: string): boolean;
  /** Calls the host saw, by tool, for the record. */
  hostCalls: Map<string, number>;
  /** What the host saw that the grade depends on beyond the answer, for the record. */
  evidence?: () => Record<string, unknown>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function lines(answer: string): string[] {
  return answer
    .replace(/```[a-z]*\n?/giu, "")
    .split("\n")
    .map((line) =>
      line
        .replace(/^[-*•\d.)\s]+/u, "")
        .replace(/[`*]/gu, "")
        .trim(),
    )
    .filter((line) => line.length > 0);
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  const a = new Set(left);
  const b = new Set(right);
  return a.size === b.size && [...a].every((item) => b.has(item));
}

/** A deterministic pseudo-random sequence, so every trial sees the same fixture. */
function rng(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
}

const DEPENDENCY_POOL = [
  "react",
  "react-dom",
  "zod",
  "lodash",
  "express",
  "chalk",
  "commander",
  "dotenv",
  "uuid",
  "yaml",
  "semver",
  "debug",
  "ws",
  "undici",
  "pino",
  "kleur",
  "picomatch",
  "fast-glob",
  "tinybench",
  "esbuild",
];

/**
 * (a) Sixteen packages, each a realistic `package.json` of 1–2 KB. Eight
 * depend on `left-pad`; the model must name the ones that ALSO have more than
 * ten runtime dependencies, with the range each pins. One `grep` finds the
 * eight; deciding which of them qualify takes reading each manifest — the
 * fan-out VC-245 measured, where almost nothing read is worth keeping.
 */
function loopFilter(): TaskRun {
  const root = mkdtempSync(join(tmpdir(), "vc471-loop-"));
  const random = rng(471);
  const expected: string[] = [];
  const leftPad = new Map([
    [1, "^1.3.0"],
    [2, "^1.3.0"],
    [4, "1.1.3"],
    [5, "~1.2.0"],
    [7, "^1.1.0"],
    [9, "0.0.9"],
    [12, "~1.3.0"],
    [15, "1.0.2"],
  ]);
  for (let index = 0; index < 16; index += 1) {
    const name = `@acme/pkg-${String(index).padStart(2, "0")}`;
    const dependencies: Record<string, string> = {};
    // Six to sixteen runtime dependencies, spread so the cut at ten matters.
    const count = 6 + ((index * 7) % 11);
    for (const dependency of DEPENDENCY_POOL.slice(0, count)) {
      dependencies[dependency] = `^${1 + Math.floor(random() * 9)}.${Math.floor(random() * 20)}.0`;
    }
    const pinned = leftPad.get(index);
    if (pinned !== undefined) {
      // Replaces one of the others, so the total stays `count`.
      delete dependencies[DEPENDENCY_POOL[count - 1]!];
      dependencies["left-pad"] = pinned;
      if (count > 10) expected.push(`pkg-${String(index).padStart(2, "0")} ${pinned}`);
    }
    const devDependencies: Record<string, string> = {};
    for (const dependency of ["typescript", "vitest", "prettier", "eslint", "@types/node", "tsx"]) {
      if (random() < 0.7) devDependencies[dependency] = `^${1 + Math.floor(random() * 6)}.0.0`;
    }
    const manifest = {
      name,
      version: `${Math.floor(random() * 4)}.${Math.floor(random() * 12)}.${Math.floor(random() * 30)}`,
      description: `The ${name} package: ${"internal tooling and shared helpers ".repeat(3).trim()}.`,
      license: "MIT",
      type: "module",
      main: "./dist/index.js",
      types: "./dist/index.d.ts",
      exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } },
      files: ["dist", "README.md"],
      scripts: {
        build: "tsc -p tsconfig.build.json",
        test: "vitest run",
        lint: "eslint .",
        typecheck: "tsc --noEmit",
        clean: "rm -rf dist",
      },
      dependencies,
      devDependencies,
      engines: { node: ">=20" },
      repository: { type: "git", url: "git+https://example.com/acme/monorepo.git" },
      keywords: ["acme", "internal", "tooling", `pkg-${index}`],
    };
    const directory = join(root, "packages", `pkg-${String(index).padStart(2, "0")}`);
    mkdirSync(join(directory, "src"), { recursive: true });
    writeFileSync(join(directory, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    writeFileSync(
      join(directory, "src", "index.ts"),
      `export const name = ${JSON.stringify(name)};\n`,
    );
  }
  expected.sort();
  return {
    spec: {},
    role: "ticket",
    workspacePath: root,
    prompt:
      "Which packages under packages/ depend on left-pad AND have more than 10 runtime dependencies " +
      "(entries in `dependencies`, left-pad included)? Reply with one line per package, " +
      "`<package directory> <left-pad version range>`, sorted, and nothing else.",
    // The directory name or the package name: both name the package. Lines
    // that are not an answer line — a preamble — are not graded.
    grade: (answer) =>
      sameSet(
        lines(answer)
          .map((line) =>
            line
              .replace(/^(?:@acme\/|packages\/)/u, "")
              .replace(/\/package\.json/u, "")
              .replace(/\s+/gu, " "),
          )
          .filter((line) => /^pkg-\d\d \S+$/u.test(line)),
        expected,
      ),
    hostCalls: new Map(),
  };
}

/** One Browser page's accessibility snapshot, about 3 KB of it. */
function pageSnapshot(slug: string, signIn: boolean): string {
  const rows = Array.from(
    { length: 40 },
    (_, index) =>
      `  - listitem: link "Article ${index + 1} about ${slug} — a long headline that wraps" [ref=e${index + 10}]`,
  );
  return [
    `- banner:`,
    `  - link "Acme ${slug}" [ref=e1]`,
    `  - navigation "Primary":`,
    `    - link "Home" [ref=e2]`,
    `    - link "Docs" [ref=e3]`,
    `    - link "Pricing" [ref=e4]`,
    ...(signIn ? [`    - button "Sign in" [ref=e5]`] : [`    - button "Account" [ref=e5]`]),
    `- main:`,
    `  - heading "${slug} overview" [level=1]`,
    `  - list:`,
    ...rows,
    `- contentinfo:`,
    `  - text "© Acme"`,
  ].join("\n");
}

/**
 * (b) Four pages in four tabs; two show a Sign in button. A stand-in Browser
 * port answers with realistic snapshots after a realistic page-load wait.
 */
function browserTabs(): TaskRun {
  const pages = new Map([
    ["https://fixture.test/alpha", true],
    ["https://fixture.test/beta", false],
    ["https://fixture.test/gamma", true],
    ["https://fixture.test/delta", false],
  ]);
  const hostCalls = new Map<string, number>();
  const count = (name: string) => hostCalls.set(name, (hostCalls.get(name) ?? 0) + 1);
  let tabs = 0;
  const byTab = new Map<string, string>();
  const snapshot = (tabId: string): RuntimeBrowserSnapshot => {
    const url = byTab.get(tabId) ?? "about:blank";
    const slug = url.split("/").at(-1) ?? "blank";
    return {
      tabId,
      url,
      title: `Acme — ${slug}`,
      ownerSessionId: "vc471-bench",
      error: null,
      snapshotText: pageSnapshot(slug, pages.get(url) === true),
      generation: 1,
      truncated: false,
      picture: null,
    };
  };
  const port: RuntimeBrowserPort = {
    tabs: async () => {
      count("tabs");
      return {
        tabs: [...byTab.entries()].map(([tabId, url]) => ({
          tabId,
          url,
          title: url,
          createdBy: "session" as const,
          ownerSessionId: "vc471-bench",
          heldBy: null,
        })),
      };
    },
    navigate: async ({ tabId, navigation }) => {
      count("navigate");
      await sleep(400);
      const id = tabId ?? `tab-${++tabs}`;
      if (navigation.kind === "url") byTab.set(id, navigation.url);
      return snapshot(id);
    },
    snapshot: async ({ tabId }) => {
      count("snapshot");
      await sleep(100);
      return snapshot(tabId);
    },
    act: async (input) => {
      count("act");
      return { ...snapshot(input.tabId), target: null };
    },
    screenshot: async ({ tabId }) => {
      count("screenshot");
      return { ...snapshot(tabId), base64Png: "", width: 1, height: 1 };
    },
    console: async ({ tabId }) => {
      count("console");
      return { ...snapshot(tabId), messages: [], truncated: false };
    },
  };
  const expected = [...pages.entries()].filter(([, signIn]) => signIn).map(([url]) => url);
  return {
    spec: { browser: port },
    role: "ticket",
    workspacePath: mkdtempSync(join(tmpdir(), "vc471-browser-")),
    prompt:
      `Open each of these pages in its own tab and tell me which ones show a "Sign in" button: ${[...pages.keys()].join(", ")}. ` +
      "Reply with the URLs that do, one per line, and nothing else.",
    // The URLs the answer names; prose around them is not graded.
    grade: (answer) => sameSet(answer.match(/https:\/\/fixture\.test\/[a-z]+/gu) ?? [], expected),
    hostCalls,
  };
}

/**
 * (c) Start four Sessions and watch them. Since VC-457 a Session is awaited by
 * watching it — the notice opens a later turn — so "start and await" is a
 * start per ticket and one watch over all four. A stand-in verb host answers
 * as the real door does, in its own words.
 */
function sessionFanout(): TaskRun {
  const tickets = ["VC-101", "VC-102", "VC-103", "VC-104"];
  const hostCalls = new Map<string, number>();
  const started = new Map<string, string>();
  const watched = new Set<string>();
  const callVerb = async (request: RuntimeVerbCall): Promise<RuntimeVerbResult> => {
    hostCalls.set(request.verb, (hostCalls.get(request.verb) ?? 0) + 1);
    await sleep(20);
    if (request.verb === "session.start") {
      const ticket = String(request.input.ticket);
      const handle = `s${(0xa0 + started.size).toString(16)}${ticket.slice(-3)}`;
      started.set(ticket, handle);
      // The real door watches every Session `session_start` opens, and its
      // description says so; a model that relies on that has watched it.
      watched.add(handle);
      return {
        text: [
          `Started Session ${handle} on ${ticket}. It runs on its own; it does not move the Ticket.`,
          `Kickoff: ${String(request.input.message ?? "(default)")}`,
          "A notice arrives here when its first turn ends, when it signals done or blocked, or if it is stopped.",
        ].join("\n"),
        // The real door's typed details (VC-471 phase 2), shaped as the
        // Verb Registry declares them to programs.
        details: {
          sessionId: `00000000-0000-4000-8000-${handle.padStart(12, "0")}`,
          handle,
          ticket,
          title: `Run tests on ${ticket}`,
          model: { providerId: "anthropic", modelId: "claude-haiku-4-5", reasoningLevel: "off" },
          state: "running",
        },
      };
    }
    if (request.verb === "watch") {
      const sessions: string[] = [];
      const ticketsWatched: string[] = [];
      for (const handle of String(request.input.sessions ?? "").split(/[\s,]+/u)) {
        if (handle) {
          watched.add(handle);
          sessions.push(handle);
        }
      }
      // Watching a Session's Ticket is told the same facts about it.
      for (const ticket of String(request.input.tickets ?? "").split(/[\s,]+/u)) {
        const handle = started.get(ticket);
        if (handle !== undefined) {
          watched.add(handle);
          ticketsWatched.push(ticket);
        }
      }
      return {
        text: `Watching ${[...watched].join(", ")}. Notices arrive as new turns.`,
        details: { action: "watch", sessions, tickets: ticketsWatched, ended: 0 },
      };
    }
    return { text: `${request.verb} is not part of this fixture.` };
  };
  return {
    spec: { callVerb, tools: { tools: ["read"], verbs: ["session.start", "watch"] } },
    role: "project",
    workspacePath: mkdtempSync(join(tmpdir(), "vc471-fanout-")),
    prompt:
      `Start a Session on each of ${tickets.join(", ")} with the kickoff message "Run the test suite and report failures.", ` +
      "then watch all four Sessions. Reply with the started Session handles, one per line, and nothing else.",
    evidence: () => ({ started: Object.fromEntries(started), watched: [...watched] }),
    grade: (answer) => fanoutGrade(answer, { started: Object.fromEntries(started) }),
    hostCalls,
  };
}

/**
 * The fan-out grade, from the answer and what the host saw: every Ticket
 * started once, and the reply is exactly their handles. Watching is implied
 * by starting — the real `session_start` watches what it opens — so phase 1's
 * runs, whose stand-in did not, are graded again with this by the report.
 */
export function fanoutGrade(
  answer: string,
  evidence: { started?: Record<string, string> },
): boolean {
  const started = evidence.started ?? {};
  const tickets = ["VC-101", "VC-102", "VC-103", "VC-104"];
  return (
    Object.keys(started).length === tickets.length &&
    tickets.every((ticket) => Object.hasOwn(started, ticket)) &&
    sameSet(lines(answer), Object.values(started))
  );
}

/** (d) One read, one answer: the control. Code Mode should cost here, not save. */
function singleCall(): TaskRun {
  const root = mkdtempSync(join(tmpdir(), "vc471-single-"));
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify({ name: "fixture", version: "3.4.1", private: true }, null, 2)}\n`,
  );
  return {
    spec: {},
    role: "ticket",
    workspacePath: root,
    prompt: "What version does package.json declare? Reply with just the version.",
    grade: (answer) => answer.includes("3.4.1"),
    hostCalls: new Map(),
  };
}

/** One service status page, about 3.5 KB of snapshot, with an incident history that says "Degraded" too. */
function statusPage(service: string, status: "Operational" | "Degraded", load: number): string {
  const history = Array.from(
    { length: 24 },
    (_, index) =>
      `    - listitem: "2026-0${1 + (index % 9)}-${String(10 + index).padStart(2, "0")} — ${
        index % 3 === 0
          ? "Degraded performance in eu-west, resolved"
          : "Scheduled maintenance completed"
      } (${service})"`,
  );
  return [
    "- banner:",
    `  - link "Acme Status — ${service}" [ref=e1]`,
    "  - navigation:",
    '    - link "All services" [ref=e2]',
    '    - link "Subscribe" [ref=e3]',
    "- main:",
    `  - heading "${service}" [level=1]`,
    `  - region "Current status":`,
    `    - text "Current status: ${status}"`,
    `    - text "Checked ${load === 1 ? "just now" : "a moment ago"} (load ${load})"`,
    '  - heading "Uptime, last 90 days" [level=2]',
    `  - text "${(99 + ((service.length * 7) % 100) / 100).toFixed(2)}%"`,
    '  - heading "Incident history" [level=2]',
    "  - list:",
    ...history,
    "- contentinfo:",
    '  - text "© Acme"',
  ].join("\n");
}

/**
 * (e) A long multi-page Browser task with repeated checks — the shape the owner's
 * Sessions run: eight status pages, each loaded and then reloaded, because a
 * status can flap between loads. A service counts only when it shows
 * "Degraded" on BOTH loads; every page's incident history also says
 * "Degraded", so reading the current status line is the only way to tell.
 * Sixteen loads of ~3.5 KB each, of which one line apiece matters.
 */
function browserCrawl(): TaskRun {
  const services = [
    "auth",
    "billing",
    "search",
    "storage",
    "email",
    "webhooks",
    "realtime",
    "exports",
  ];
  // [first load, every later load]: billing, email and realtime stay degraded;
  // search recovers; webhooks degrades only on the reload.
  const statuses: Record<string, ["Operational" | "Degraded", "Operational" | "Degraded"]> = {
    auth: ["Operational", "Operational"],
    billing: ["Degraded", "Degraded"],
    search: ["Degraded", "Operational"],
    storage: ["Operational", "Operational"],
    email: ["Degraded", "Degraded"],
    webhooks: ["Operational", "Degraded"],
    realtime: ["Degraded", "Degraded"],
    exports: ["Operational", "Operational"],
  };
  const urls = services.map((service) => `https://status.fixture.test/${service}`);
  const hostCalls = new Map<string, number>();
  const count = (name: string) => hostCalls.set(name, (hostCalls.get(name) ?? 0) + 1);
  const loads = new Map<string, number>();
  let tabs = 0;
  const byTab = new Map<string, { url: string; load: number }>();
  const snapshot = (tabId: string): RuntimeBrowserSnapshot => {
    const page = byTab.get(tabId) ?? { url: "about:blank", load: 0 };
    const service = page.url.split("/").at(-1) ?? "blank";
    const known = statuses[service];
    return {
      tabId,
      url: page.url,
      title: `Acme Status — ${service}`,
      ownerSessionId: "vc471-bench",
      error: null,
      snapshotText:
        known === undefined
          ? '- main:\n  - text "Not found"'
          : statusPage(service, known[page.load <= 1 ? 0 : 1], page.load),
      generation: page.load,
      truncated: false,
      picture: null,
    };
  };
  const load = (tabId: string, url: string) => {
    const next = (loads.get(url) ?? 0) + 1;
    loads.set(url, next);
    byTab.set(tabId, { url, load: next });
  };
  const port: RuntimeBrowserPort = {
    tabs: async () => {
      count("tabs");
      return {
        tabs: [...byTab.entries()].map(([tabId, page]) => ({
          tabId,
          url: page.url,
          title: page.url,
          createdBy: "session" as const,
          ownerSessionId: "vc471-bench",
          heldBy: null,
        })),
      };
    },
    navigate: async ({ tabId, navigation }) => {
      count("navigate");
      await sleep(300);
      const id = tabId ?? `tab-${++tabs}`;
      if (navigation.kind === "url") load(id, navigation.url);
      else if (navigation.kind === "reload") load(id, byTab.get(id)?.url ?? "about:blank");
      return snapshot(id);
    },
    snapshot: async ({ tabId }) => {
      count("snapshot");
      await sleep(80);
      return snapshot(tabId);
    },
    act: async (input) => {
      count("act");
      return { ...snapshot(input.tabId), target: null };
    },
    screenshot: async ({ tabId }) => {
      count("screenshot");
      return { ...snapshot(tabId), base64Png: "", width: 1, height: 1 };
    },
    console: async ({ tabId }) => {
      count("console");
      return { ...snapshot(tabId), messages: [], truncated: false };
    },
  };
  const expected = ["billing", "email", "realtime"].map(
    (service) => `https://status.fixture.test/${service}`,
  );
  return {
    spec: { browser: port },
    role: "ticket",
    workspacePath: mkdtempSync(join(tmpdir(), "vc471-crawl-")),
    prompt:
      "These are our service status pages. A status can flap between loads, so for each page: load it, " +
      "then reload it once and check again. Report the services whose current status is Degraded on BOTH loads. " +
      `Pages: ${urls.join(", ")}. Reply with their URLs, one per line, and nothing else.`,
    grade: (answer) =>
      sameSet(answer.match(/https:\/\/status\.fixture\.test\/[a-z]+/gu) ?? [], expected),
    hostCalls,
    evidence: () => ({ loads: Object.fromEntries(loads) }),
  };
}

const LEGACY_IMPORT = 'import { oldLog } from "../legacy";';
const LOGGER_IMPORT = /^import\s*\{[^}]*\blogger\b[^}]*\}\s*from\s*"\.\.\/logger";$/u;

/** A file's lines, without its import lines, for the body comparison. */
function bodyLines(text: string): string[] {
  return text.split("\n").filter((line) => !line.startsWith("import "));
}

/** One module of the edit fixture: ~40–60 lines of plausible TypeScript. */
function moduleSource(index: number, calls: number, legacy: boolean, extraImport: boolean): string {
  const name = `m${String(index).padStart(2, "0")}`;
  const out: string[] = [];
  if (extraImport) out.push('import { createLogger } from "../logger";');
  if (legacy) out.push(LEGACY_IMPORT);
  out.push('import { config } from "../config";', "");
  out.push(`/** Handlers for the ${name} queue. */`);
  out.push(
    `export interface ${name.toUpperCase()}Job {`,
    "  id: string;",
    "  attempts: number;",
    "  payload: Record<string, unknown>;",
    "}",
    "",
  );
  for (let fn = 0; fn < 4; fn += 1) {
    out.push(
      `export async function handle${fn}(job: ${name.toUpperCase()}Job): Promise<boolean> {`,
    );
    out.push(`  const limit = config.retries + ${fn};`);
    out.push("  if (job.attempts > limit) {");
    if (legacy && fn < calls) {
      out.push(`    oldLog("${name} job over its retry limit", { id: job.id, step: ${fn} });`);
    } else {
      out.push(`    // ${name}: give up quietly on step ${fn}`);
    }
    out.push("    return false;", "  }");
    out.push(
      `  const keys = Object.keys(job.payload).filter((key) => key.startsWith("${name}_"));`,
    );
    out.push("  return keys.length > 0;", "}", "");
  }
  if (extraImport) {
    out.push(`export const ${name}Logger = createLogger("${name}");`, "");
  }
  return `${out.join("\n")}\n`;
}

/**
 * (f) A multi-step editing task across several files — read, edit and run in a
 * loop, the work a Ticket Session mostly does. Six of twelve modules still call
 * the legacy `oldLog(...)` helper (two to four calls each, one beside an
 * existing `../logger` import); each must call `logger.info(...)` with the same
 * arguments and import `logger` from "../logger" instead of the legacy import,
 * and everything else must stay as it was. A check script reports what is
 * left; the task is done when it says OK.
 *
 * Graded on the files, not the reply: the six migrated exactly (every other
 * line unchanged), the six others byte-for-byte untouched, and the reply
 * carrying the script's OK line.
 */
function editLoop(): TaskRun {
  const root = mkdtempSync(join(tmpdir(), "vc471-edit-"));
  const modules = join(root, "src", "modules");
  mkdirSync(modules, { recursive: true });
  mkdirSync(join(root, "scripts"), { recursive: true });
  writeFileSync(
    join(root, "src", "legacy.ts"),
    "export function oldLog(..._args: unknown[]): void {}\n",
  );
  writeFileSync(
    join(root, "src", "logger.ts"),
    "export const logger = { info: (..._args: unknown[]): void => undefined };\n" +
      "export function createLogger(_name: string) {\n  return logger;\n}\n",
  );
  writeFileSync(join(root, "src", "config.ts"), "export const config = { retries: 3 };\n");
  const targets = new Map([
    [2, 2],
    [3, 4],
    [5, 3],
    [8, 2],
    [10, 4],
    [11, 3],
  ]);
  const originals = new Map<string, string>();
  for (let index = 1; index <= 12; index += 1) {
    const calls = targets.get(index);
    const source = moduleSource(index, calls ?? 0, calls !== undefined, index === 5 || index === 7);
    const file = `m${String(index).padStart(2, "0")}.ts`;
    originals.set(file, source);
    writeFileSync(join(modules, file), source);
  }
  writeFileSync(
    join(root, "scripts", "check-logging.mjs"),
    [
      'import { readdirSync, readFileSync } from "node:fs";',
      'const dir = new URL("../src/modules/", import.meta.url);',
      "const problems = [];",
      "let migrated = 0;",
      "for (const file of readdirSync(dir).filter((name) => name.endsWith('.ts')).sort()) {",
      "  const text = readFileSync(new URL(file, dir), 'utf8');",
      "  if (text.includes('oldLog(')) problems.push(`${file}: still calls oldLog`);",
      "  if (text.includes('../legacy')) problems.push(`${file}: still imports ../legacy`);",
      "  const usesLogger = text.includes('logger.info(');",
      "  const imports = text.split('\\n').filter((line) => /^import\\s*\\{[^}]*\\blogger\\b[^}]*\\}\\s*from\\s*\"\\.\\.\\/logger\";$/.test(line)).length;",
      "  if (usesLogger && imports !== 1) problems.push(`${file}: calls logger.info but imports logger ${imports} times`);",
      "  if (usesLogger) migrated += 1;",
      "}",
      "if (problems.length > 0) { console.log(problems.join('\\n')); console.log(`FAIL: ${problems.length} problems`); process.exit(1); }",
      "console.log(`OK: ${migrated} modules migrated, 0 problems`);",
      "",
    ].join("\n"),
  );
  const migratedOk = (file: string, now: string): boolean => {
    const original = originals.get(file)!;
    const all = now.split("\n");
    if (now.includes("oldLog") || now.includes("../legacy")) return false;
    if (all.filter((line) => LOGGER_IMPORT.test(line)).length !== 1) return false;
    // The other imports stay; createLogger stays imported where it was.
    if (
      original.includes("createLogger") &&
      !/\bcreateLogger\b/u.test(all.filter((line) => line.startsWith("import ")).join("\n"))
    )
      return false;
    if (!all.some((line) => line === 'import { config } from "../config";')) return false;
    const expected = bodyLines(original).map((line) => line.replace("oldLog(", "logger.info("));
    return JSON.stringify(bodyLines(now)) === JSON.stringify(expected);
  };
  return {
    spec: {},
    role: "ticket",
    workspacePath: root,
    prompt:
      "Migrate src/modules off the legacy oldLog helper: replace every oldLog(...) call with logger.info(...) " +
      'with the same arguments, import logger from "../logger" instead of importing from "../legacy", and ' +
      "leave everything else exactly as it is. Then run `node scripts/check-logging.mjs` and fix anything it " +
      "reports. Reply with the script's final output line.",
    grade: (answer) => {
      if (!/OK: 6 modules migrated, 0 problems/u.test(answer)) return false;
      for (const file of readdirSync(modules).toSorted()) {
        const now = readFileSync(join(modules, file), "utf8");
        const target = targets.has(Number(file.slice(1, 3)));
        if (target ? !migratedOk(file, now) : now !== originals.get(file)) return false;
      }
      return true;
    },
    hostCalls: new Map(),
    evidence: () => {
      const files: Record<string, string> = {};
      for (const file of readdirSync(modules).toSorted()) {
        const now = readFileSync(join(modules, file), "utf8");
        const target = targets.has(Number(file.slice(1, 3)));
        files[file] = target
          ? migratedOk(file, now)
            ? "migrated"
            : "WRONG"
          : now === originals.get(file)
            ? "untouched"
            : "CHANGED";
      }
      return { files };
    },
  };
}

export const TASKS: Readonly<Record<TaskId, () => TaskRun>> = {
  "loop-filter": loopFilter,
  "browser-tabs": browserTabs,
  "session-fanout": sessionFanout,
  "single-call": singleCall,
  "browser-crawl": browserCrawl,
  "edit-loop": editLoop,
};
