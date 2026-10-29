import { followCloudSession } from "@renderer/lib/cloud-client";
import { toastError } from "@renderer/lib/toast";
import { useProjectsStore } from "../projects";
import { useAutomationsStore } from "../automations";
import { installCloudAutomationSource } from "../automation-source";
import { ConvexAutomationSource } from "./source";
import { clearCloudAutomations, useCloudAutomationsStore } from "./state";

const without = <T>(rows: Record<string, T>, projectId: string): Record<string, T> =>
  Object.fromEntries(
    Object.entries(rows).filter(([key]) => key !== projectId && !key.startsWith(`${projectId}:`)),
  );
function forget(projectId: string): void {
  useAutomationsStore.setState((state) => ({
    byProject: without(state.byProject, projectId),
    armingByProject: without(state.armingByProject, projectId),
    orderByProject: without(state.orderByProject, projectId),
    railReadAt: {},
    runsByProject: without(state.runsByProject, projectId),
    skipsByProject: without(state.skipsByProject, projectId),
    runsByAutomation: without(state.runsByAutomation, projectId),
    skipsByAutomation: without(state.skipsByAutomation, projectId),
    editor: state.editor?.projectId === projectId ? null : state.editor,
  }));
  useCloudAutomationsStore.setState((state) => ({
    armings: without(state.armings, projectId),
    schedules: without(state.schedules, projectId),
    histories: without(state.histories, projectId),
    pending: without(state.pending, projectId),
  }));
  const remaining = useCloudAutomationsStore.getState();
  useAutomationsStore.setState({
    enabledIds: [
      ...new Set(
        [...Object.values(remaining.armings).flat(), ...Object.values(remaining.schedules).flat()]
          .filter((row) => row.pausedAt === null)
          .map((row) => row.automationId),
      ),
    ],
  });
}
/** One binding per cloud window. Client/account/project loss tears down watches
 * and evidence; a socket outage keeps last accepted rows, read-only. */
export function bindCloudAutomations(readOnly: (projectId?: string) => string | null): () => void {
  let source: ConvexAutomationSource | null = null;
  let followed = new Set<string>();
  const sync = () => {
    const projects = new Set(useProjectsStore.getState().projects.map((row) => row.id));
    for (const id of followed)
      if (!projects.has(id)) {
        source?.closeProject(id);
        forget(id);
      }
    const added = [...projects].filter((id) => !followed.has(id));
    followed = projects;
    for (const id of added)
      if (source !== null) {
        const state = useAutomationsStore.getState();
        void Promise.all([
          state.refresh(id),
          state.refreshArming(id),
          state.refreshOrder(id),
          source.schedules(id),
          source.pending(id),
        ]).catch((error) => toastError(error instanceof Error ? error.message : String(error)));
      }
  };
  const stopProjects = useProjectsStore.subscribe(sync);
  const stopSession = followCloudSession((session) => {
    source?.close();
    for (const id of followed) forget(id);
    followed = new Set();
    source = session === null ? null : new ConvexAutomationSource(session, readOnly);
    installCloudAutomationSource(source);
    if (source !== null) {
      source.onError = toastError;
      void source
        .runners()
        .catch((error) => toastError(error instanceof Error ? error.message : String(error)));
    }
    sync();
  });
  return () => {
    stopProjects();
    stopSession();
    source?.close();
    installCloudAutomationSource(null);
    for (const id of followed) forget(id);
    clearCloudAutomations();
  };
}
