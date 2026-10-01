/**
 * VC-471's four benchmark tasks, as fixtures a real Session runs against.
 *
 * Each task builds what its tools answer from — a worktree on disk, Browser
 * pages, a verb host — and grades the model's final answer against a key it
 * computed itself. The shapes are VC-245's: a `bash`/`read` loop-and-filter
 * task (the 95% of the measured gain), a multi-tab Browser task, a
 * multi-Session start-and-watch task, and a single direct call as the control.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  RuntimeBrowserPort,
  RuntimeBrowserSnapshot,
  RuntimeVerbCall,
  RuntimeVerbResult,
  SessionRuntimeSpec,
} from "@volli/shared";

export type TaskId = "loop-filter" | "browser-tabs" | "session-fanout" | "single-call";

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

export const TASKS: Readonly<Record<TaskId, () => TaskRun>> = {
  "loop-filter": loopFilter,
  "browser-tabs": browserTabs,
  "session-fanout": sessionFanout,
  "single-call": singleCall,
};
