/** Convex transport for the existing Automation store. Reads stay live until
 * their project leaves the Workspace. No cloud command reaches local IPC.
 * Receipt envelopes differ between the two stores; the UI consumes their
 * accepted rows, not a fabricated local receipt.
 */
import {
  getFunctionName,
  type FunctionReference,
  type FunctionArgs,
  type FunctionReturnType,
} from "convex/server";
import {
  parseAutomationSkipReason,
  type Automation,
  type AutomationRun,
  type ResolvedAutomationModel,
} from "@volli/shared";
import type {
  AutomationCreateInput,
  AutomationUpdateInput,
  AutomationArmInput,
  AutomationSetColumnOrderInput,
  AutomationIdInput,
  AutomationSetEnabledInput,
  AutomationRunInput,
  AutomationRunForProjectInput,
} from "../../../../ipc/contract";
import { toastError } from "@renderer/lib/toast";
import type { CloudSession } from "@renderer/lib/cloud-client";
import { useCloudPlacesStore } from "@renderer/lib/cloud-places";
import { cloudFailure, CLOUD_READ_ONLY, type Watched } from "../cloud-board/source";
import { useAutomationsStore, automationHistoryKey } from "../automations";
import type { AutomationSource, SourceReply } from "../automation-source";
import { clearCloudAutomations, useCloudAutomationsStore, type CloudRun } from "./state";
import { cloudLaunchNow } from "../launch";
import { optimisticDefinition, optimisticArming } from "./optimistic";

type Query = FunctionReference<"query">;
const pageArgs = { numItems: 50, cursor: null };
export function resolvedRunModel(value: unknown): ResolvedAutomationModel | null {
  if (typeof value !== "object" || value === null) return null;
  const row = value as Record<string, unknown>;
  return typeof row.providerId === "string" &&
    typeof row.modelId === "string" &&
    typeof row.reasoningLevel === "string"
    ? { providerId: row.providerId, modelId: row.modelId, reasoningLevel: row.reasoningLevel }
    : null;
}
function startedRuns(rows: readonly CloudRun[]): AutomationRun[] {
  return rows.flatMap((row) => {
    const model = resolvedRunModel(row.model);
    return row.status === "started" && row.sessionId !== null && model !== null
      ? [
          {
            ...row,
            sessionId: row.sessionId,
            model,
            attendance:
              row.attendance === "unattended" ? ("unattended" as const) : ("attended" as const),
          },
        ]
      : [];
  });
}
function skippedRuns(rows: readonly CloudRun[]) {
  return rows.flatMap((row) =>
    row.status === "skipped" && row.automationId !== null
      ? [
          {
            id: row.id,
            projectId: row.projectId,
            automationId: row.automationId,
            automationName: row.automationName ?? "Automation",
            dueAt: row.dueAt ?? row.createdAt,
            recordedAt: row.createdAt,
            missedCount: row.missedCount ?? 1,
            reason: parseAutomationSkipReason(row.skipReason),
          },
        ]
      : [],
  );
}

export class ConvexAutomationSource implements AutomationSource {
  readonly #session: CloudSession;
  readonly #readOnly: (projectId: string) => string | null;
  readonly #watches = new Map<string, { stop: (() => void) | null; projectId?: string }>();
  readonly #pages = new Map<
    string,
    {
      rows: CloudRun[][];
      cursors: string[];
      cursor: string;
      done: boolean;
      loading: boolean;
      projectId: string;
      automationId?: string;
    }
  >();
  #closed = false;
  constructor(session: CloudSession, readOnly: (projectId: string) => string | null = () => null) {
    this.#session = session;
    this.#readOnly = readOnly;
  }
  #assertOpen(): void {
    if (this.#closed) throw new Error("The Workspace changed.");
  }
  async #read<Q extends Query>(
    reference: Q,
    args: FunctionArgs<Q>,
    paint: (rows: FunctionReturnType<Q>) => void,
    projectId?: string,
  ): Promise<FunctionReturnType<Q>> {
    this.#assertOpen();
    const key = JSON.stringify([getFunctionName(reference), args]);
    if (!this.#watches.has(key)) {
      const watch = this.#session.client.watchQuery(reference, args) as Watched<
        FunctionReturnType<Q>
      >;
      let failed = false;
      const entry = { stop: null as (() => void) | null, projectId };
      const update = () => {
        if (this.#closed || this.#watches.get(key) !== entry) return;
        try {
          const rows = watch.localQueryResult();
          if (rows !== undefined) {
            failed = false;
            paint(rows);
          }
        } catch (error) {
          if (!failed) this.#failed(error);
          failed = true;
        }
      };
      this.#watches.set(key, entry);
      const stop = watch.onUpdate(update);
      if (this.#watches.get(key) === entry) entry.stop = stop;
      else stop();
      update();
    }
    const entry = this.#watches.get(key);
    const rows = await this.#session.client.query(reference, args);
    this.#assertOpen();
    if (this.#watches.get(key) === entry) paint(rows);
    else throw new Error("The project is no longer in this Workspace.");
    return rows;
  }
  #failed(error: unknown): void {
    // Imported lazily by cloud boot; the same toast convention as local reads.
    this.onError(`Couldn’t load Automations: ${cloudFailure(error).message}`);
  }
  onError: (message: string) => void = toastError;
  async #write<T>(
    projectId: string,
    issue: () => Promise<T>,
    runnerId = useCloudPlacesStore.getState().thisRunnerId,
  ): Promise<T> {
    this.#assertOpen();
    if (!this.#session.client.connectionState().isWebSocketConnected)
      throw new Error(CLOUD_READ_ONLY);
    const refusal = this.#readOnly(projectId);
    if (refusal !== null) throw new Error(refusal);
    try {
      const reply = await issue();
      this.#assertOpen();
      return reply;
    } catch (error) {
      const failure = cloudFailure(error);
      const runnerName =
        useCloudAutomationsStore.getState().runners.find((row) => row.id === runnerId)?.name ??
        "this Mac";
      const messages: Record<string, string> = {
        runner_needs_update: `Update Volli on ${runnerName}`,
        runner_not_live: `${runnerName} isn’t accepting work. Choose an online runner.`,
        runner_unavailable: "Choose an available runner.",
        runner_not_yours: "Choose one of your own runners.",
        name_taken: "An Automation with that name already exists.",
        invalid_draft: "Enter a name and Instructions.",
        draft_too_large: "Shorten the name or Instructions.",
        invalid_runtime: "Choose a valid model and effort.",
        invalid_trigger: "Choose a valid Trigger.",
        wrong_trigger: "Save the Trigger before arming it.",
        automation_not_found: "This Automation is no longer available.",
        automation_not_in_project: "This Automation belongs to another project.",
        run_already_started: "This Run has already started.",
        run_already_finished: "This Run has already finished.",
        retry_unavailable: "This Run is no longer available to retry.",
      };
      throw new Error(
        failure.code === null ? failure.message : (messages[failure.code] ?? failure.message),
        { cause: error },
      );
    }
  }
  closeProject(projectId: string): void {
    for (const [key, watch] of this.#watches)
      if (watch.projectId === projectId) {
        watch.stop?.();
        this.#watches.delete(key);
      }
    for (const [key, history] of this.#pages)
      if (history.projectId === projectId) this.#pages.delete(key);
  }
  close(): void {
    this.#closed = true;
    for (const watch of this.#watches.values()) watch.stop?.();
    this.#watches.clear();
    this.#pages.clear();
    clearCloudAutomations();
  }

  async list({
    projectId,
  }: {
    projectId: string;
  }): Promise<{ ok: true; automations: Automation[] }> {
    const answer = await this.#read(
      this.#session.api.automations.list,
      { projectId },
      (rows) => {
        useAutomationsStore.setState((state) => ({
          byProject: { ...state.byProject, [projectId]: rows },
        }));
      },
      projectId,
    );
    return { ok: true, automations: answer };
  }
  async #definition(projectId: string, automationId: string): Promise<Automation> {
    const rows = await this.list({ projectId });
    const row = rows.automations.find((candidate) => candidate.id === automationId);
    if (row === undefined) throw new Error("This Automation is no longer available.");
    return row;
  }
  #projectOf(automationId: string): string {
    const rows = Object.values(useAutomationsStore.getState().byProject).flat();
    const projectId = rows.find((row) => row.id === automationId)?.projectId;
    if (projectId == null) throw new Error("Open this Automation’s project first.");
    return projectId;
  }
  async create(input: AutomationCreateInput): Promise<SourceReply<"create">> {
    if (input.projectId === null) throw new Error("Choose a project for this Automation.");
    const { client, api } = this.#session;
    // Deterministic within this accepted command, including a retry after a lost reply.
    const automationId = input.commandId;
    const now = Date.now();
    const userId = cloudLaunchNow()?.userId;
    const reply = await this.#write(input.projectId, () =>
      client.mutation(
        api.automations.create,
        { ...input, projectId: input.projectId!, automationId },
        {
          optimisticUpdate: (store) => {
            if (userId !== undefined)
              optimisticDefinition(store, api.automations, {
                projectId: input.projectId!,
                automationId,
                draft: input,
                change: "create",
                userId,
                now,
              });
          },
        },
      ),
    );
    return { ok: true, automation: await this.#definition(input.projectId, reply.automationId) };
  }
  async update(input: AutomationUpdateInput): Promise<SourceReply<"update">> {
    const projectId = this.#projectOf(input.automationId);
    const now = Date.now();
    const userId = cloudLaunchNow()?.userId;
    await this.#write(projectId, () =>
      this.#session.client.mutation(this.#session.api.automations.update, input, {
        optimisticUpdate: (store) => {
          if (userId !== undefined)
            optimisticDefinition(store, this.#session.api.automations, {
              projectId,
              automationId: input.automationId,
              draft: input,
              change: "update",
              userId,
              now,
            });
        },
      }),
    );
    return { ok: true, automation: await this.#definition(projectId, input.automationId) };
  }
  async delete(input: AutomationIdInput): Promise<SourceReply<"delete">> {
    await this.#write(this.#projectOf(input.automationId), () =>
      this.#session.client.mutation(this.#session.api.automations.remove, input),
    );
    return { ok: true };
  }
  async armings({ projectId }: { projectId: string }): Promise<SourceReply<"armings">> {
    const answer = await this.#read(
      this.#session.api.automations.armings,
      { projectId },
      (rows) => {
        useCloudAutomationsStore.setState((state) => ({
          armings: { ...state.armings, [projectId]: rows },
        }));
        useAutomationsStore.setState((state) => ({
          armingByProject: {
            ...state.armingByProject,
            [projectId]: rows.filter((row) => row.pausedAt === null),
          },
        }));
        this.#paintEnablement();
      },
      projectId,
    );
    return { ok: true, armings: answer.filter((row) => row.pausedAt === null) };
  }
  async arm(input: AutomationArmInput & { runnerId?: string }): Promise<SourceReply<"arm">> {
    const intent = {
      ...input,
      runnerId: input.runnerId ?? useCloudPlacesStore.getState().thisRunnerId,
    };
    const now = Date.now();
    const userId = cloudLaunchNow()?.userId;
    const runners = useCloudAutomationsStore.getState().runners;
    await this.#write(
      input.projectId,
      () =>
        this.#session.client.mutation(this.#session.api.automations.arm, intent, {
          optimisticUpdate: (store) => {
            if (userId !== undefined)
              optimisticArming(store, this.#session.api.automations, {
                intent,
                userId,
                runners,
                now,
              });
          },
        }),
      intent.runnerId,
    );
    return this.armings({ projectId: input.projectId });
  }
  async columnOrders({ projectId }: { projectId: string }): Promise<SourceReply<"columnOrders">> {
    const answer = await this.#read(
      this.#session.api.automations.columnOrders,
      { projectId },
      (rows) => {
        useAutomationsStore.setState((state) => ({
          orderByProject: {
            ...state.orderByProject,
            [projectId]: rows.map((row) => ({
              projectId: row.projectId,
              status: row.status,
              orderedAt: row.orderedAt,
              rankedAutomationIds: row.rankedIds,
            })),
          },
        }));
      },
      projectId,
    );
    return {
      ok: true,
      orders: answer.map((row) => ({
        projectId: row.projectId,
        status: row.status,
        orderedAt: row.orderedAt,
        rankedAutomationIds: row.rankedIds,
      })),
    };
  }
  async setColumnOrder({
    rankedAutomationIds,
    ...input
  }: AutomationSetColumnOrderInput): Promise<SourceReply<"setColumnOrder">> {
    await this.#write(input.projectId, () =>
      this.#session.client.mutation(this.#session.api.automations.setColumnOrder, {
        ...input,
        rankedIds: rankedAutomationIds,
      }),
    );
    return this.columnOrders({ projectId: input.projectId });
  }
  async schedules(projectId: string): Promise<void> {
    await this.#read(
      this.#session.api.automations.schedules,
      { projectId },
      (rows) => {
        useCloudAutomationsStore.setState((state) => ({
          schedules: { ...state.schedules, [projectId]: rows },
        }));
        this.#paintEnablement();
      },
      projectId,
    );
  }
  #paintEnablement(): string[] {
    const state = useCloudAutomationsStore.getState();
    const ids = [
      ...new Set(
        [...Object.values(state.armings).flat(), ...Object.values(state.schedules).flat()]
          .filter((row) => row.pausedAt === null)
          .map((row) => row.automationId),
      ),
    ];
    useAutomationsStore.setState({ enabledIds: ids, enablementRead: true });
    return ids;
  }
  async enablement(): Promise<SourceReply<"enablement">> {
    return { ok: true, enabledAutomationIds: this.#paintEnablement() };
  }
  async setEnabled(
    input: AutomationSetEnabledInput & { runnerId?: string },
  ): Promise<SourceReply<"setEnabled">> {
    const projectId = this.#projectOf(input.automationId);
    await this.#write(
      projectId,
      () =>
        input.enabled
          ? this.#session.client.mutation(this.#session.api.automations.armSchedule, {
              commandId: input.commandId,
              automationId: input.automationId,
              runnerId: input.runnerId ?? useCloudPlacesStore.getState().thisRunnerId,
            })
          : this.#session.client.mutation(this.#session.api.automations.disarmSchedule, {
              commandId: input.commandId,
              automationId: input.automationId,
            }),
      input.runnerId ?? useCloudPlacesStore.getState().thisRunnerId,
    );
    await this.schedules(projectId);
    return this.enablement();
  }
  async runners(): Promise<void> {
    await this.#read(this.#session.api.runners.list, {}, (rows) =>
      useCloudAutomationsStore.setState({ runners: rows }),
    );
  }
  async pending(projectId: string): Promise<void> {
    await this.#read(
      this.#session.api.automations.pendingArrivals,
      { projectId },
      (rows) =>
        useCloudAutomationsStore.setState((state) => ({
          pending: { ...state.pending, [projectId]: rows },
        })),
      projectId,
    );
  }
  async cancel(projectId: string, jobId: string): Promise<void> {
    await this.#write(projectId, () =>
      this.#session.client.mutation(this.#session.api.automations.cancelPendingArrival, {
        commandId: crypto.randomUUID(),
        jobId,
      }),
    );
  }
  async retry(input: { projectId: string; runId: string; retryCommandId: string }): Promise<void> {
    await this.#write(input.projectId, () =>
      this.#session.client.mutation(this.#session.api.automations.retryArrival, {
        commandId: input.retryCommandId,
        runId: input.runId,
        runnerId: useCloudPlacesStore.getState().thisRunnerId,
      }),
    );
  }
  async queueRun({ target, projectId, ...input }: AutomationRunInput & { projectId: string }) {
    return this.#write(projectId, () =>
      this.#session.client.mutation(this.#session.api.automations.run, {
        ...input,
        ...(target.kind === "automation"
          ? { automationId: target.automationId }
          : { instructions: target.instructions }),
        runnerId: useCloudPlacesStore.getState().thisRunnerId,
      }),
    );
  }
  async queueProjectRun({ projectId, ...input }: AutomationRunForProjectInput) {
    return this.#write(projectId, () =>
      this.#session.client.mutation(this.#session.api.automations.runForProject, {
        ...input,
        runnerId: useCloudPlacesStore.getState().thisRunnerId,
      }),
    );
  }

  /** A by-hand Run's toast becomes a Session door only after intake exists. */
  followRun(projectId: string, runId: string, settled: (run: CloudRun) => void): void {
    this.#assertOpen();
    const key = `run:${runId}`;
    this.#watches.get(key)?.stop?.();
    const watch = this.#session.client.watchQuery(this.#session.api.automations.runState, {
      runId,
    }) as Watched<CloudRun>;
    const entry = { stop: null as (() => void) | null, projectId };
    const finish = () => {
      entry.stop?.();
      this.#watches.delete(key);
    };
    const read = () => {
      if (this.#closed || this.#watches.get(key) !== entry) return;
      try {
        const run = watch.localQueryResult();
        if (
          run === undefined ||
          run.status === "queued" ||
          (run.status === "started" && run.sessionAccess === "starting")
        )
          return;
        finish();
        settled(run);
      } catch (error) {
        finish();
        this.#failed(error);
      }
    };
    this.#watches.set(key, entry);
    const stop = watch.onUpdate(read);
    if (this.#watches.get(key) === entry) entry.stop = stop;
    else stop();
    read();
  }

  #paintHistory(key: string): CloudRun[] {
    const history = this.#pages.get(key)!;
    const rows = [...new Map(history.rows.flat().map((row) => [row.id, row])).values()].toSorted(
      (a, b) => b.createdAt - a.createdAt,
    );
    useCloudAutomationsStore.setState((state) => ({
      histories: { ...state.histories, [key]: rows },
    }));
    if (history.automationId === undefined)
      useAutomationsStore.setState((state) => ({
        runsByProject: { ...state.runsByProject, [history.projectId]: startedRuns(rows) },
        skipsByProject: { ...state.skipsByProject, [history.projectId]: skippedRuns(rows) },
      }));
    else
      useAutomationsStore.setState((state) => ({
        runsByAutomation: { ...state.runsByAutomation, [key]: startedRuns(rows) },
        skipsByAutomation: { ...state.skipsByAutomation, [key]: skippedRuns(rows) },
      }));
    return rows;
  }
  async #history(projectId: string, automationId?: string): Promise<CloudRun[]> {
    const key =
      automationId === undefined ? projectId : automationHistoryKey(projectId, automationId);
    if (!this.#pages.has(key))
      this.#pages.set(key, {
        rows: [],
        cursors: [],
        cursor: "",
        done: false,
        loading: false,
        projectId,
        automationId,
      });
    const paint = (page: { page: CloudRun[]; continueCursor: string; isDone: boolean }) => {
      const history = this.#pages.get(key)!;
      history.rows[0] = page.page;
      history.cursors[0] = page.continueCursor;
      if (history.rows.length === 1) {
        history.cursor = page.continueCursor;
        history.done = page.isDone;
      }
      this.#paintHistory(key);
    };
    const history = this.#pages.get(key)!;
    const paginationOpts =
      history.rows.length > 1 ? { ...pageArgs, endCursor: history.cursors[0] } : pageArgs;
    if (automationId === undefined)
      await this.#read(
        this.#session.api.automations.runsForProject,
        { projectId, paginationOpts },
        paint,
        projectId,
      );
    else
      await this.#read(
        this.#session.api.automations.runsForAutomation,
        { automationId, paginationOpts },
        paint,
        projectId,
      );
    return this.#paintHistory(key);
  }
  hasMore(key: string): boolean {
    return this.#pages.get(key)?.done === false;
  }
  async loadMore(key: string): Promise<void> {
    const history = this.#pages.get(key);
    if (history === undefined || history.done || history.loading) return;
    history.loading = true;
    const index = history.rows.length;
    const paint = (page: { page: CloudRun[]; continueCursor: string; isDone: boolean }) => {
      history.rows[index] = page.page;
      history.cursors[index] = page.continueCursor;
      history.cursor = page.continueCursor;
      history.done = page.isDone;
      this.#paintHistory(key);
    };
    try {
      const cursor = history.cursor;
      // Freeze the preceding page at its old boundary before opening the next.
      // Otherwise an insertion at the head pushes its last row into a gap.
      const reference =
        history.automationId === undefined
          ? this.#session.api.automations.runsForProject
          : this.#session.api.automations.runsForAutomation;
      const scope =
        history.automationId === undefined
          ? { projectId: history.projectId }
          : { automationId: history.automationId };
      const previousOpts = {
        numItems: 50,
        cursor: index === 1 ? null : history.cursors[index - 2]!,
      };
      const previousKey = JSON.stringify([
        getFunctionName(reference),
        { ...scope, paginationOpts: previousOpts },
      ]);
      this.#watches.get(previousKey)?.stop?.();
      this.#watches.delete(previousKey);
      const pinned = (page: { page: CloudRun[]; continueCursor: string }) => {
        history.rows[index - 1] = page.page;
        history.cursors[index - 1] = page.continueCursor;
        this.#paintHistory(key);
      };
      const boundedOpts = { ...previousOpts, endCursor: cursor };
      if (history.automationId === undefined)
        await this.#read(
          this.#session.api.automations.runsForProject,
          { projectId: history.projectId, paginationOpts: boundedOpts },
          pinned,
          history.projectId,
        );
      else
        await this.#read(
          this.#session.api.automations.runsForAutomation,
          { automationId: history.automationId, paginationOpts: boundedOpts },
          pinned,
          history.projectId,
        );
      const paginationOpts = { numItems: 50, cursor };
      if (history.automationId === undefined)
        await this.#read(
          this.#session.api.automations.runsForProject,
          { projectId: history.projectId, paginationOpts },
          paint,
          history.projectId,
        );
      else
        await this.#read(
          this.#session.api.automations.runsForAutomation,
          { automationId: history.automationId, paginationOpts },
          paint,
          history.projectId,
        );
    } finally {
      history.loading = false;
    }
  }
  async runsForProject({
    projectId,
  }: {
    projectId: string;
  }): Promise<SourceReply<"runsForProject">> {
    return { ok: true, runs: startedRuns(await this.#history(projectId)) };
  }
  async skipsForProject({
    projectId,
  }: {
    projectId: string;
  }): Promise<SourceReply<"skipsForProject">> {
    return { ok: true, skips: skippedRuns(await this.#history(projectId)) };
  }
  async runsForAutomation({
    projectId,
    automationId,
  }: {
    projectId: string;
    automationId: string;
  }): Promise<SourceReply<"runsForAutomation">> {
    return { ok: true, runs: startedRuns(await this.#history(projectId, automationId)) };
  }
  async skipsForAutomation({
    projectId,
    automationId,
  }: {
    projectId: string;
    automationId: string;
  }): Promise<SourceReply<"skipsForAutomation">> {
    return { ok: true, skips: skippedRuns(await this.#history(projectId, automationId)) };
  }
}
