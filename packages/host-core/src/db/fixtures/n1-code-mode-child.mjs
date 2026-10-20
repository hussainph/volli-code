// VC-748's narrow N−1 bridge. Runs under scripts/n1/hooks.mjs against the
// manifest's complete shipped tree and lockfile, never current product sources.
// Runtime/host ports are inert stand-ins: exercise the shipped adapter's attach
// validation and shipped provider-tool builder without a model, tool execution,
// Electron, credentials, a sandbox worker or network access.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const n1 = (path) => import(`n1:${path}`);
const command = JSON.parse(process.argv[2]);
const shared = await n1("@volli/shared");
const { createSessionEngine, canonicalJson } = await n1("@volli/session-engine");
const { RuntimeObservationTranslator } = await import(
  pathToFileURL(
    join(process.env.VOLLI_N1_TREE, "packages/session-engine/src/observation-translation.ts"),
  ).href
);
const { openVolliDb } = await n1("./db/index");
const { SCHEMA_HEAD: head } = await n1("./db/migrations");
const { createSqliteSessionLedger } = await n1("./session-control/sqlite-ledger");
const { createPiNativeAdapter } = await n1("./session-runtime/pi-adapter");
// These are internal, not public package exports. The whole-tree loader still
// resolves their own imports and dependencies exclusively inside N−1.
const { createSessionTools } = await import(
  pathToFileURL(join(process.env.VOLLI_N1_TREE, "packages/agent-runtime/src/pi/tools.ts")).href
);
const { piExecutionEnv } = await n1("@volli/agent-runtime");
const unused = async () => {
  throw new Error("N−1 Code Mode fixture must not execute a tool or contact a provider");
};

async function attach(step) {
  const db = openVolliDb(command.dbPath);
  try {
    const engine = createSessionEngine({
      ledger: createSqliteSessionLedger(db),
      clock: { now: () => 1_791_100_000_000 },
      ids: { next: unused },
    });
    const events = await engine.listEvents({ sessionId: step.sessionId });
    const projection = await engine.getSession({ sessionId: step.sessionId });
    const birth = events.find(
      ({ payload }) =>
        payload.kind === "session.input.recorded" && payload.input.kind === "tool-surface",
    )?.payload.input;
    if (!birth?.codeMode) throw new Error("N−1 lost the durable Code Mode birth record");
    // Use this build's production epoch reader when it has shipped. Pre-feature
    // readers have only the immutable birth and legitimately degrade to it.
    const readerPath = join(
      process.env.VOLLI_N1_TREE,
      process.env.VOLLI_N1_HOST_SRC,
      "session-runtime/tool-refresh.ts",
    );
    const reader = existsSync(readerPath) ? await import(pathToFileURL(readerPath).href) : null;
    const record = reader?.effectiveToolSurface(events) ?? birth;
    const declaration = reader?.declarationToolSurface(events) ?? birth;
    // The sequenced reader is strict about unknown kinds. Seed the OLD bus
    // after historical refreshes, then prove its first post-start drain excludes them.
    const wakePath = ["session-control/session-wake.ts", "session-wake.ts"]
      .map((path) => join(process.env.VOLLI_N1_TREE, process.env.VOLLI_N1_HOST_SRC, path))
      .find(existsSync);
    if (!wakePath) throw new Error("N−1 has no production Session wake bus");
    const { createSessionWakeBus } = await import(pathToFileURL(wakePath).href);
    const wakeErrors = [];
    const wakes = [];
    const bus = createSessionWakeBus(engine, {
      db,
      onError: (error) => wakeErrors.push(String(error)),
    });
    const unsubscribe = bus.subscribe((wake) => wakes.push(wake));
    await bus.engine.observe({
      id: `n1-startup-wake-${step.sessionId}`,
      sessionId: step.sessionId,
      occurredAt: 1_791_100_000_001,
      provenance: { source: { kind: "system", id: "n1-proof", detail: null }, venue: null },
      kind: "adapter.observed",
      attachmentId: null,
      name: "N−1 startup wake proof",
      native: null,
    });
    unsubscribe();
    const startupWakeSafe =
      wakeErrors.length === 0 &&
      wakes.length === 1 &&
      wakes[0].event.payload.kind === "adapter.observed";
    if (!startupWakeSafe)
      throw new Error(`N−1 wake replayed historical refreshes: ${JSON.stringify(wakeErrors)}`);
    let result;
    const browser = Object.fromEntries(
      [
        "tabs",
        "navigate",
        "snapshot",
        "act",
        "screenshot",
        "console",
        "acquire",
        "release",
        "find",
        "turnEnded",
      ].map((name) => [name, unused]),
    );
    const adapter = createPiNativeAdapter({
      sessionDataDir: join(step.workspace, "pi-unused"),
      readWorkspaceEnvironment: () => undefined,
      resolveRuntimeContext: async () => ({
        role: "project",
        projectId: "proj-n1",
        ticketId: null,
        rootThreadId: `thread:${step.sessionId}:root`,
        brief: "Offline N−1 Code Mode attachment fixture",
        model: { providerId: "anthropic", modelId: "fixture", reasoningLevel: "off" },
        toolSurface: record.tools,
        codeMode: record.codeMode,
        declarationSurface: declaration,
        refreshDescriptions: record.refreshDescriptions,
        promptResources: [],
      }),
      resolveWebPorts: () => ({ webFetch: unused, webSearch: unused }),
      resolveBrowserPort: () => browser,
      callVerb: unused,
      createRuntime: () => ({
        startSession: async (spec) => {
          const environment = await piExecutionEnv(step.workspace, { environment: {} });
          let bound = [];
          const declared = createSessionTools(spec, environment, undefined, (surface, tools) => {
            bound = tools.map((entry) => entry.id);
            return {
              name: "codemode",
              label: "Code Mode",
              description: "Inert Code Mode builder",
              parameters: { type: "object", properties: {} },
              execute: unused,
            };
          });
          result = {
            tools: shared.sessionToolIds(spec),
            routes: record.codeMode.routes,
            bound,
            declared: declared.map((tool) => tool.name),
            replayable: projection?.session.id === step.sessionId,
            startupWakeSafe,
            birthStillReadable: birth.tools.every((tool) =>
              shared.sessionToolIds(spec).includes(tool),
            ),
            callable: bound.filter((tool) =>
              shared.isCodeCallable(tool, record.codeMode.routes[tool]),
            ),
          };
          return { recovery: undefined, close: async () => undefined };
        },
      }),
    });
    const binding = await adapter.attach(
      {
        sessionId: step.sessionId,
        attachmentId: "n1-code-mode-attachment",
        directory: step.workspace,
        continuity: "fresh",
        native: null,
      },
      { emit: unused },
    );
    await binding.release("requested");
    if (!result) throw new Error("N−1 never reached runtime startSession");
    return result;
  } finally {
    db.close();
  }
}

function replay(step) {
  // A durable recovery marker, read cold; none of the live translator survives.
  const observations = JSON.parse(readFileSync(step.markers, "utf8"));
  const translator = new RuntimeObservationTranslator({
    ...step.translation,
    now: () => 1_791_100_000_000,
  });
  return {
    artifacts: observations
      .flatMap((observation) => translator.replay(observation))
      .map((fact) => {
        if (fact.kind !== "transcript.message")
          throw new Error(`Unexpected replay fact: ${fact.kind}`);
        const artifact = {
          version: 1,
          threadId: fact.threadId,
          branchId: fact.branchId,
          attemptId: fact.attemptId,
          turnId: fact.turnId,
          message: fact.message,
        };
        return {
          id: fact.id,
          artifact,
          digest: `sha256:${createHash("sha256").update(canonicalJson(artifact)).digest("hex")}`,
        };
      }),
  };
}

const results = [];
for (const step of command.steps) {
  try {
    const value = step.kind === "attach" ? await attach(step) : replay(step);
    results.push({ kind: step.kind, ok: true, value });
  } catch (error) {
    results.push({
      kind: step.kind,
      ok: false,
      error: { name: error?.name ?? typeof error, message: String(error?.message ?? error) },
    });
  }
}
process.stdout.write(`${JSON.stringify({ head, guarded: false, results })}\n`);
