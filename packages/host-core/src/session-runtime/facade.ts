/**
 * Inert Session facade/utility assembly (VC-622). No ledger is read at
 * construction. Starts keep the project's post-I/O skill policy and the same
 * model ladder; attachments read birth models without rehydrating the executor.
 * Callers expose these captured services only through lifecycle.ready().
 */
import { randomUUID } from "node:crypto";
import {
  acceptsImageInputIn,
  applySkillModes,
  globalSkillsDir,
  projectSkillsDir,
  resolveDefaultModel,
  skillPromptResource,
  skillsIndexResource,
  userInvokableSkills,
  type SessionExecutionVenue,
  type SessionOrigin,
} from "@volli/shared";
import type { HostCore } from "../index";
import type { HostEventBus } from "../ports/events";
import { getProjectById } from "../db/projects-repo";
import { getTicket, getTicketBrief } from "../db/tickets-repo";
import { recordSessionStartedOnce } from "../db/events-repo";
import { createModelAutoSelect } from "../decision/auto-select";
import type { HostDecisions } from "../decision/desktop";
import { loadSkills } from "../skills";
import { createPeekSummarizer } from "../session-control/peek-summary";
import { createAutoTitler } from "./auto-title";
import { readModelAccessDefaults } from "./model-access-preferences";
import { createSessions, StructuredSessionsError, type SessionSkillPorts } from "./sessions";
import type { TicketSessionDelegationStore } from "./delegation-store";
import type { createRuntimeAssembly } from "./assembly";
import type { RecoveredSessionServices } from "./lifecycle";
import {
  createRuntimeSessionAgents,
  type RuntimeSessionAgentOptions,
  type RuntimeSessionAgents,
} from "./agents";

function assembleSessionServices(options: {
  host: HostCore;
  assembly: ReturnType<typeof createRuntimeAssembly>;
  homeDir: string;
  venue: SessionExecutionVenue;
  events: HostEventBus;
  decisions: HostDecisions | null;
  delegation: TicketSessionDelegationStore | null;
}) {
  const {
    host,
    homeDir,
    venue,
    events,
    decisions: desktopDecisions,
    delegation: sessionDelegation,
  } = options;
  const { sessionEngine } = host;
  const sessionDb = host.database.ok ? host.database.db : null;
  const { sessionRuntime, piRuntimeHost, sessionToolSurface } = options.assembly;
  const sessionSkills: SessionSkillPorts | null =
    sessionEngine !== null && sessionDb !== null
      ? {
          resolve: async (projectId, names) => {
            const project = getProjectById(sessionDb, projectId);
            if (!project) {
              throw new StructuredSessionsError(
                "SKILL_NOT_FOUND",
                "The project for this Session was not found.",
              );
            }
            const read = await loadSkills({
              projectSkillsDir: projectSkillsDir(project.path),
              globalSkillsDir: globalSkillsDir(homeDir),
            });
            if (!read.ok) {
              throw new StructuredSessionsError(
                "SKILL_NOT_FOUND",
                `The project's skills could not be read: ${read.error}`,
              );
            }
            // Disk I/O yielded: a concurrent Settings write may disable a
            // skill. Re-read policy now, never validate against the stale row.
            const currentProject = getProjectById(sessionDb, projectId);
            if (!currentProject) {
              throw new StructuredSessionsError(
                "SKILL_NOT_FOUND",
                "The project for this Session was not found.",
              );
            }
            const available = userInvokableSkills(
              applySkillModes(read.skills, currentProject.skillModes ?? {}),
            );
            return [...new Set(names)].map((name) => {
              const skill = available.find((candidate) => candidate.name === name);
              if (!skill) {
                throw new StructuredSessionsError(
                  "SKILL_NOT_FOUND",
                  `The skill "${name}" was not found in this project.`,
                );
              }
              return skillPromptResource(skill);
            });
          },
          index: async (projectId, injectedNames) => {
            const project = getProjectById(sessionDb, projectId);
            if (!project) return null;
            const read = await loadSkills({
              projectSkillsDir: projectSkillsDir(project.path),
              globalSkillsDir: globalSkillsDir(homeDir),
            });
            if (!read.ok) return null;
            // The discoverable index has the same post-I/O policy race.
            const currentProject = getProjectById(sessionDb, projectId);
            if (!currentProject) return null;
            return skillsIndexResource(
              applySkillModes(read.skills, currentProject.skillModes ?? {}),
              injectedNames,
            );
          },
          record: async (sessionId, resources) => {
            await sessionEngine.getOrRecordSessionInput({
              sessionId,
              input: { kind: "prompt-resources", resources },
              provenance: {
                source: { kind: "system", id: "pi-runtime", detail: null },
                venue,
              },
            });
          },
        }
      : null;
  const sessions =
    sessionRuntime !== null &&
    sessionEngine !== null &&
    piRuntimeHost !== null &&
    sessionDb !== null &&
    sessionSkills !== null &&
    sessionToolSurface !== null &&
    sessionDelegation !== null
      ? createSessions({
          runtime: sessionRuntime,
          // Explicit/parent choices are resolved by the facade first. A new
          // project's Session then uses its pin before the global tier ladder.
          // null project means a parent's global-fallback path: no project pin.
          readDefaultModel: async (tier, projectId) => {
            const project = projectId === null ? undefined : getProjectById(sessionDb, projectId);
            const pinned = project?.sessionModel ?? null;
            if (pinned !== null) return pinned;
            const sees =
              tier === "visual"
                ? acceptsImageInputIn((await piRuntimeHost.inspectModelAccess({})).models)
                : undefined;
            return resolveDefaultModel(readModelAccessDefaults(sessionDb), tier, sees);
          },
          ticketBelongsToProject: (projectId, ticketId) =>
            getTicket(sessionDb, ticketId)?.projectId === projectId,
          readModelAnchor: async (sessionId) => {
            const { projection } = await sessionRuntime.projection({ sessionId });
            return { selection: projection.modelSelection, tier: projection.modelTier };
          },
          readBirthModel: async (sessionId, commandId) => {
            const { projection } = await sessionRuntime.projection({ sessionId });
            const intent = projection.commands?.find((command) => command.id === commandId)?.intent;
            if (intent?.kind !== "model.select") return null;
            return {
              selection: intent.selection,
              tier: intent.tier ?? null,
              ...(intent.auto === undefined ? {} : { auto: intent.auto }),
            };
          },
          // Read birth intent without projection() rehydrating an executor.
          readBirthModelFromLedger: async (sessionId, commandId) => {
            const ledgerEvents = await sessionEngine.listEvents({ sessionId });
            const recorded = ledgerEvents.find(
              (event) =>
                event.payload.kind === "command.recorded" && event.payload.command.id === commandId,
            );
            const intent =
              recorded?.payload.kind === "command.recorded"
                ? recorded.payload.command.intent
                : null;
            if (intent?.kind !== "model.select") return null;
            return {
              selection: intent.selection,
              tier: intent.tier ?? null,
              ...(intent.auto === undefined ? {} : { auto: intent.auto }),
            };
          },
          skills: sessionSkills,
          toolSurface: sessionToolSurface,
          grants: sessionDelegation,
          inspectModelAccess: () => piRuntimeHost.inspectModelAccess({}),
          ...(desktopDecisions === null
            ? {}
            : {
                autoSelect: createModelAutoSelect({
                  db: sessionDb,
                  port: desktopDecisions.port,
                }),
              }),
          // A Session's first start, not each idempotent attach/start call.
          recordSessionStarted: ({ ticketId, sessionId, actor, origin }) => {
            recordSessionStartedOnce(sessionDb, {
              ticketId,
              sessionId,
              now: Date.now(),
              actor,
              origin,
            });
          },
        })
      : null;
  const autoTitler =
    sessionEngine !== null && sessionDb !== null && piRuntimeHost !== null
      ? createAutoTitler({
          readSession: async (sessionId) => {
            const projection = await sessionEngine.getSession({ sessionId });
            if (projection === null) return null;
            return {
              title: projection.session.title,
              ticketId: projection.session.ticketId,
              model: projection.modelSelection,
            };
          },
          // Per refinement: Sessions outlive the Settings write that retunes it.
          readModelDefaults: () => readModelAccessDefaults(sessionDb),
          readTicket: (ticketId) => getTicketBrief(sessionDb, ticketId) ?? null,
          inspectModelAccess: ({ signal }) => piRuntimeHost.inspectModelAccess({ signal }),
          completeUtility: (input) => piRuntimeHost.completeUtility(input),
          recordUsage: async (sessionId, usage) => {
            await sessionEngine.observe({
              // Durable id shape is frozen. Each model call is a new bill,
              // not Session-scoped replay that would dedupe the second usage.
              id: `usage:auto-title:${randomUUID()}`,
              kind: "usage.recorded",
              sessionId,
              occurredAt: Date.now(),
              provenance: {
                source: { kind: "system", id: "auto-title", detail: null },
                venue,
              },
              attachmentId: null,
              turnId: null,
              usage,
            });
          },
          retitle: async (sessionId, title) => {
            const submitted = await sessionEngine.submit({
              commandId: randomUUID(),
              sessionId,
              intent: { kind: "session.retitle", title },
              provenance: {
                source: {
                  kind: "system",
                  id: "auto-title",
                  detail: { sessionOrigin: { kind: "volli", reason: "auto-title" } },
                },
                venue,
              },
            });
            if (submitted.receipt?.status !== "completed") {
              throw new Error("Session retitle was not completed");
            }
            // Direct Engine submission bypasses runtime publication; this
            // makes the label visible without waiting for an unrelated read.
            events.publish("session-retitled", { sessionId, title });
          },
        })
      : null;
  // One owner/cache for every client. Only an explicit peek runs a model call.
  const peekSummarizer =
    sessionEngine !== null && sessionDb !== null && piRuntimeHost !== null
      ? createPeekSummarizer({
          readModelDefaults: () => readModelAccessDefaults(sessionDb),
          inspectModelAccess: ({ signal }) => piRuntimeHost.inspectModelAccess({ signal }),
          completeUtility: (input) => piRuntimeHost.completeUtility(input),
          recordUsage: async (sessionId, usage) => {
            await sessionEngine.observe({
              // Frozen durable id shape; separate utility calls must not dedupe.
              id: `usage:peek-summary:${randomUUID()}`,
              kind: "usage.recorded",
              sessionId,
              occurredAt: Date.now(),
              provenance: {
                source: { kind: "system", id: "peek-summary", detail: null },
                venue,
              },
              attachmentId: null,
              turnId: null,
              usage,
            });
          },
        })
      : null;
  // The caller derives both ids from its operation. CLI and tools share this
  // exact command so replay never mints a second kickoff message or turn.
  const submitKickoffMessage =
    sessionRuntime === null
      ? undefined
      : async ({
          sessionId,
          text,
          commandId,
          messageId,
          origin,
        }: {
          sessionId: string;
          text: string;
          commandId: string;
          messageId: string;
          origin?: SessionOrigin;
        }): Promise<void> => {
          await sessionRuntime.command({
            origin,
            commandId,
            sessionId,
            command: {
              kind: "message.submit",
              message: { id: messageId, role: "user", parts: [{ type: "text", text }] },
            },
          });
        };
  return {
    sessions,
    sessionSkills,
    autoTitler,
    peekSummarizer,
    submitKickoffMessage,
    runtime: sessionRuntime,
    sessionEngine,
    piRuntimeHost,
    transcriptArtifacts: options.assembly.transcriptArtifacts,
  };
}
export type RuntimeSessionServices = ReturnType<typeof assembleSessionServices>;

/** Inert staging only. No ledger consumer can obtain services without recovery. */
export interface RuntimeSessionFacade {
  waitForBirth(sessionId: string): Promise<void>;
  agents(options: Omit<RuntimeSessionAgentOptions, "facade" | "services">): RuntimeSessionAgents;
}
const servicesByFacade = new WeakMap<RuntimeSessionFacade, RuntimeSessionServices>();

export function createRuntimeSessionFacade(
  options: Parameters<typeof assembleSessionServices>[0],
): RuntimeSessionFacade {
  const services = assembleSessionServices(options);
  const facade: RuntimeSessionFacade = {
    // Synchronization only: never reads the ledger or exposes Sessions.
    waitForBirth: async (sessionId) => {
      await services.sessions?.waitForBirth?.(sessionId);
    },
    agents: (agentOptions) => createRuntimeSessionAgents({ ...agentOptions, facade, services }),
  };
  servicesByFacade.set(facade, services);
  return facade;
}

export function recoveredRuntimeSessionServices(
  ready: RecoveredSessionServices<RuntimeSessionFacade>,
): RuntimeSessionServices {
  const services = servicesByFacade.get(ready.services);
  if (services === undefined)
    throw new Error("The recovered facade belongs to a different runtime.");
  return services;
}

/** Preserve proof revocation while adapting the opaque facade for automations. */
export function recoveredSessionAutomationPorts(
  ready: RecoveredSessionServices<RuntimeSessionFacade>,
) {
  return {
    ...ready,
    get services() {
      return recoveredRuntimeSessionServices(ready);
    },
  };
}

/** Renderer listing/peek/stop hooks, supplied only from recovered services. */
export function recoveredSessionClientPorts(ready: RecoveredSessionServices<RuntimeSessionFacade>) {
  const { sessionEngine, runtime, autoTitler, peekSummarizer, transcriptArtifacts } =
    recoveredRuntimeSessionServices(ready);
  return {
    sessionEngine,
    autoTitle:
      autoTitler === null
        ? undefined
        : (input: Parameters<typeof autoTitler.refine>[0]) => void autoTitler.refine(input),
    summarizePeek: peekSummarizer?.summarize,
    readTranscriptArtifact: (reference: Parameters<typeof transcriptArtifacts.read>[0]) =>
      transcriptArtifacts.read(reference),
    sessionRuntime: runtime ?? undefined,
  };
}

/** Public CLI Session verbs cannot be wired from unrecovered facade inputs. */
export function recoveredSessionCommandPorts(
  ready: RecoveredSessionServices<RuntimeSessionFacade>,
) {
  const {
    sessionEngine,
    sessions,
    sessionSkills,
    submitKickoffMessage,
    autoTitler,
    piRuntimeHost,
    transcriptArtifacts,
  } = recoveredRuntimeSessionServices(ready);
  if (sessionEngine === null) throw new Error("The Session engine is unavailable.");
  return {
    sessionEngine,
    readTranscriptArtifact: (reference: Parameters<typeof transcriptArtifacts.read>[0]) =>
      transcriptArtifacts.read(reference),
    ...(sessions === null ? {} : { sessions }),
    ...(sessionSkills === null
      ? {}
      : { skillsIndex: (projectId: string) => sessionSkills.index(projectId, []) }),
    ...(submitKickoffMessage === undefined ? {} : { submitSessionMessage: submitKickoffMessage }),
    ...(autoTitler === null
      ? {}
      : {
          refineAutoTitle: (input: Parameters<typeof autoTitler.refine>[0]) =>
            void autoTitler.refine(input),
        }),
    ...(piRuntimeHost === null
      ? {}
      : {
          inspectModelAccess: (input: { signal: AbortSignal }) =>
            piRuntimeHost.inspectModelAccess(input),
        }),
  };
}
