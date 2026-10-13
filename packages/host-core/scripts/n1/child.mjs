// The PREVIOUS build (N-1) acting on a profile, for the N-1 compatibility job
// (VC-633, `src/db/n1-compatibility.test.ts`). Runs as a plain `node` child
// under `hooks.mjs`, so every module below is N-1's own shipped source,
// imported through `n1:` specifiers; this file imports nothing else from the
// checkout it lives in.
//
// It drives the writes a person makes on a downgraded build, through the same
// host modules the app calls (database open, ticket commands, the Session
// Engine over the SQLite ledger, the secrets table, the backup bundle and
// restore), not through raw SQL. The calls it makes have kept their shape
// since v0.2.1; a step whose module or export N-1 does not have reports
// `unsupported` rather than guessing at a substitute.
//
// Reads one JSON command from argv, runs its steps in order, prints one JSON
// line and exits 0. A step that throws is reported, not fatal: the refusal
// step is supposed to throw. Never prints a secret value.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const n1 = (path) => import(`n1:${path}`);

/** N-1's module at `path`, or null when that build has no such file. */
async function optional(path) {
  try {
    return await n1(path);
  } catch (error) {
    if (error?.code === "ERR_MODULE_NOT_FOUND" && String(error.message).includes(path.slice(2))) {
      return null;
    }
    throw error;
  }
}

const command = JSON.parse(process.argv[2]);
const { openVolliDb } = await n1("./db/index");
const migrations = await n1("./db/migrations");
const head = migrations.SCHEMA_HEAD ?? migrations.MIGRATIONS.at(-1).version;
// The downgrade guard (VC-602); a build without it cannot refuse anything.
const guard = await optional("./db/schema-compatibility");

function errorReport(error) {
  return {
    name: error?.name ?? typeof error,
    message: String(error?.message ?? error),
    ...(typeof error?.minReaderVersion !== "undefined"
      ? { minReaderVersion: error.minReaderVersion }
      : {}),
  };
}

function withDb(fn) {
  const db = openVolliDb(command.dbPath);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

const NOW = 1_791_000_000_000;
const provenance = { source: { kind: "user", id: "n1", detail: null }, venue: null };

const steps = {
  /** Opens the database as N-1 boots it. */
  open: () =>
    withDb((db) => ({
      userVersion: db.pragma("user_version", { simple: true }),
      floor: guard ? guard.readMinReaderVersion(db) : null,
    })),

  /** Saves, reads back and clears a credential row, as N-1's settings panes do. */
  secrets: async (step) => {
    const repo = await n1("./db/secrets-repo");
    return withDb((db) => {
      repo.writeSecret(db, step.name, step.value, NOW);
      const saved = repo.readSecret(db, step.name) === step.value;
      if (step.clear) repo.deleteSecret(db, step.name);
      return { saved, present: repo.hasSecret(db, step.name) };
    });
  },

  /** Creates a ticket with a label, moves it and comments on it. */
  ticket: async (step) => {
    const commands = await n1("./ticket-commands");
    const comments = await n1("./db/comments-repo");
    return withDb((db) => {
      const context = { now: NOW, actor: { kind: "user" } };
      const ticket = commands.createTicketCommand(
        db,
        {
          id: step.ticketId,
          projectId: step.projectId,
          title: "Written by N-1",
          status: "todo",
          labels: ["n1"],
        },
        context,
      );
      commands.moveTicketCommand(
        db,
        { projectId: step.projectId, ticketId: ticket.id, toStatus: "doing", toIndex: 0 },
        context,
      );
      comments.createComment(db, { ticketId: ticket.id, body: "from N-1", actor: "user" }, NOW);
      return { ticketNumber: ticket.ticketNumber };
    });
  },

  /** Creates a Session on that ticket through N-1's Session Engine and SQLite ledger. */
  session: async (step) => {
    const { createSessionEngine } = await n1("@volli/session-engine");
    const { createSqliteSessionLedger } = await n1("./session-control/sqlite-ledger");
    const db = openVolliDb(command.dbPath);
    try {
      let next = 0;
      const engine = createSessionEngine({
        ledger: createSqliteSessionLedger(db),
        clock: { now: () => NOW },
        // Ledger ids are unique across the whole file: scope them to this Session.
        ids: { next: (kind) => `${step.sessionId}-${kind}-${++next}` },
      });
      const created = await engine.createSession({
        commandId: `n1-command-${step.sessionId}`,
        requestedSessionId: step.sessionId,
        projectId: step.projectId,
        ticketId: step.ticketId,
        role: "ticket",
        parentSessionId: null,
        title: "N-1 Session",
        provenance,
      });
      const read = await engine.getSession({ sessionId: created.session.id });
      return { sessionId: created.session.id, readBack: read?.session?.id ?? null };
    } finally {
      db.close();
    }
  },

  /** Leaves a flat Pi-style card pending while a new-birth Session is downgraded. */
  pendingFlatAsk: async (step) => {
    const { createSessionEngine } = await n1("@volli/session-engine");
    const { createSqliteSessionLedger } = await n1("./session-control/sqlite-ledger");
    const shared = await n1("@volli/shared");
    const db = openVolliDb(command.dbPath);
    try {
      const engine = createSessionEngine({
        ledger: createSqliteSessionLedger(db),
        clock: { now: () => NOW },
        ids: { next: (kind) => `pending-flat-${kind}` },
      });
      const surface = await engine.getOrRecordSessionInput({
        sessionId: step.sessionId,
        input: { kind: "tool-surface", tools: ["ask_user"] },
        provenance,
      });
      const attachmentId = "n1-flat-attachment";
      const native = { id: null, detail: null };
      const adapter = { source: { kind: "adapter", id: "pi", detail: null }, venue: null };
      await engine.observe({
        id: "n1-flat-attached",
        sessionId: step.sessionId,
        occurredAt: NOW,
        provenance: adapter,
        kind: "attachment.opened",
        attachment: {
          id: attachmentId,
          sessionId: step.sessionId,
          adapterId: "pi",
          venue: { id: "n1-local", kind: "local" },
          continuity: "fresh",
          native,
          authority: null,
        },
      });
      const options = [{ id: "keep", label: "Keep it", description: null }];
      const interaction = {
        id: step.interactionId,
        attachmentId,
        kind: "question",
        title: "Keep the downgraded change?",
        detail: null,
        options,
        multiple: false,
        native,
        prompts: [
          {
            id: shared.DEFAULT_INTERACTION_PROMPT_ID,
            label: "Keep the downgraded change?",
            detail: null,
            options,
            multiple: false,
            custom: true,
          },
        ],
      };
      await engine.observe({
        id: "n1-flat-opened",
        sessionId: step.sessionId,
        occurredAt: NOW,
        provenance: adapter,
        kind: "interaction.opened",
        interaction,
      });
      const pending = await engine.getSession({ sessionId: step.sessionId });
      return { surface, interaction, activeCount: pending.interactions.active.length };
    } finally {
      db.close();
    }
  },

  /** Reads and answers a head-written card through N-1's codec, UI rules and ledger. */
  askUser: async (step) => {
    const { createSessionEngine } = await n1("@volli/session-engine");
    const { createSqliteSessionLedger } = await n1("./session-control/sqlite-ledger");
    const shared = await n1("@volli/shared");
    // prepare.mjs installs the host's dependency closure only. Presentation is
    // shipped in both tags, but after the host extraction it is outside that
    // closure. Import its exact shipped helper file, resolving its sole import
    // to the SAME N-1 shared package the host uses, without linking or rewriting
    // any extracted source (and without falling back to head's implementation).
    const helperUrl = pathToFileURL(
      join(process.env.VOLLI_N1_TREE, "packages/session-presentation/src/interaction.ts"),
    ).href;
    const helperImports = registerHooks({
      resolve(specifier, context, nextResolve) {
        return nextResolve(
          context.parentURL === helperUrl && specifier === "@volli/shared"
            ? "n1:@volli/shared"
            : specifier,
          context,
        );
      },
    });
    let ui;
    try {
      ui = await n1(helperUrl);
    } finally {
      helperImports.deregister();
    }
    const db = openVolliDb(command.dbPath);
    try {
      let next = 0;
      const engine = createSessionEngine({
        ledger: createSqliteSessionLedger(db),
        clock: { now: () => NOW },
        ids: { next: (kind) => `${step.sessionId}-n1-answer-${kind}-${++next}` },
      });
      // getSession folds persisted events with N-1's real stored codec.
      const before = await engine.getSession({ sessionId: step.sessionId });
      const interaction = before?.interactions.active.find((ask) => ask.id === step.interactionId);
      if (!interaction) throw new Error("Head-written ask_user card is not pending in N-1");
      const events = await engine.listEvents({ sessionId: step.sessionId });
      const opened = events.find(
        ({ payload }) =>
          payload.kind === "interaction.opened" && payload.interaction.id === interaction.id,
      );
      if (!opened) throw new Error("Head-written interaction event is missing in N-1");
      // N-1 keeps original membership but ignores the new schema marker in
      // its decoded birth input. Reading/answering must not rewrite its bytes.
      const toolSurface = await engine.getOrRecordSessionInput({
        sessionId: step.sessionId,
        input: { kind: "tool-surface", tools: ["write"] },
        provenance,
      });
      const renderer = shared.decodeRendererSessionEventPayload(
        opened.payload,
        "N-1 ask_user card",
      );
      const card = renderer.interaction;
      const prompts = shared.readInteractionPrompts(card);
      let draft = ui.emptyInteractionDraft(card);
      const submitStates = [ui.canSubmitInteraction(card, draft)];
      for (const answer of step.answers) {
        const prompt = prompts.find((candidate) => candidate.id === answer.promptId);
        if (!prompt) throw new Error(`N-1 did not render prompt ${answer.promptId}`);
        for (const optionId of answer.optionIds) draft = ui.selectOption(draft, prompt, optionId);
        if (answer.response !== null) {
          draft = ui.setPromptResponse(draft, prompt.id, answer.response);
        }
        submitStates.push(ui.canSubmitInteraction(card, draft));
      }
      if (!submitStates.at(-1)) throw new Error("N-1 UI cannot submit the fully answered card");
      const resolution = ui.interactionResolution(card, draft);
      const submitted = await engine.submit({
        commandId: `${step.sessionId}-n1-answer-command`,
        sessionId: step.sessionId,
        intent: {
          kind: "interaction.resolve",
          attachmentId: interaction.attachmentId,
          interactionId: interaction.id,
          resolution,
          reference: { id: `${step.sessionId}-n1-answer-artifact`, mediaType: null, digest: null },
        },
        provenance,
      });
      if (submitted.receipt?.status === "rejected") {
        throw new Error(`N-1 rejected the answer: ${submitted.receipt.code}`);
      }
      // No executor/provider is needed: report the adapter's durable fact as
      // the real engine does once its resolution endpoint has accepted it.
      await engine.observe({
        id: `${step.sessionId}-n1-answer-observation`,
        sessionId: step.sessionId,
        attachmentId: interaction.attachmentId,
        occurredAt: NOW,
        provenance: { source: { kind: "adapter", id: "pi", detail: null }, venue: null },
        kind: "interaction.resolved",
        interactionId: interaction.id,
        resolution,
      });
      const after = await engine.getSession({ sessionId: step.sessionId });
      const resolved = after.interactions.resolved.find(
        (ask) => ask.interaction.id === interaction.id,
      );
      const resolvedEvents = await engine.listEvents({ sessionId: step.sessionId });
      const resolvedEvent = resolvedEvents.find(
        ({ payload }) =>
          payload.kind === "interaction.resolved" && payload.interactionId === interaction.id,
      );
      if (!resolvedEvent) throw new Error("N-1 did not persist the card answer");
      const rendererAnswer = shared.decodeRendererSessionEventPayload(
        resolvedEvent.payload,
        "N-1 ask_user answer",
      );
      if (JSON.stringify(rendererAnswer.resolution) !== JSON.stringify(resolved.resolution)) {
        throw new Error("N-1 renderer codec changed the stored answer");
      }
      return {
        prompts,
        toolSurface,
        rendererNative: card.native,
        submitStates,
        resolution,
        answers: shared.readInteractionAnswers(card, rendererAnswer.resolution),
        activeCount: after.interactions.active.length,
        route: submitted.command.route,
      };
    } finally {
      db.close();
    }
  },

  /** Makes a backup bundle of the profile. */
  bundle: async (step) => {
    const { createBackupBundle } = await n1("./backup/bundle");
    const { blobsRoot } = await n1("./blob-store");
    const { sessionTranscriptsRoot } = await n1("./session-runtime/transcript-artifacts");
    return withDb((db) => {
      const bundle = createBackupBundle({
        db,
        blobsRoot: blobsRoot(step.profileRoot),
        transcriptsRoot: sessionTranscriptsRoot(step.profileRoot),
        appVersion: "n-1",
        now: NOW,
      });
      writeFileSync(step.out, bundle.bytes);
      return { schemaVersion: bundle.document.schemaVersion };
    });
  },

  /** Restores a bundle into an empty profile. */
  restore: async (step) => {
    const { restoreBackupBundle } = await n1("./backup/restore");
    mkdirSync(step.profileRoot, { recursive: true });
    const result = await restoreBackupBundle({
      bundle: readFileSync(step.bundle),
      profileRoot: step.profileRoot,
      projectPaths: step.projectPaths ?? {},
      now: NOW + 1,
    });
    return result.ok
      ? { restored: true, schemaVersion: result.report?.schemaVersion }
      : { restored: false, problems: result.problems.map((p) => p.message ?? String(p)) };
  },
};

const results = [];
for (const step of command.steps) {
  const run = steps[step.kind];
  try {
    results.push({ kind: step.kind, ok: true, value: await run(step) });
  } catch (error) {
    results.push({ kind: step.kind, ok: false, error: errorReport(error) });
  }
}

process.stdout.write(
  `${JSON.stringify({ head, guarded: guard !== null, hostSrc: process.env.VOLLI_N1_HOST_SRC, results })}\n`,
);
