import { SettingsNavigation } from "@renderer/components/settings/settings-navigation";
/** One Settings surface. Legacy Configure entry points deep-link into project scope. */
import * as React from "react";
import { FolderOpenIcon } from "@phosphor-icons/react/dist/csr/FolderOpen";
import { hasAccountEnrollment, useExperimentsStore } from "@renderer/stores/experiments";
import { launchStore } from "@renderer/stores/launch";
import { useUiStore } from "@renderer/stores/ui";
import { useCloudEnabled } from "@renderer/components/hosts/use-hosts";
import { useLogViewerEnabled } from "@renderer/components/logs/log-viewer";
import { configureGroups } from "@renderer/components/settings/configure-groups";
import { PrefShell, type PrefGroup } from "@renderer/components/settings/kit";
import {
  SettingsScope,
  SettingsProjectWelcome,
} from "@renderer/components/settings/settings-scope";
import {
  resolveSettingsCategory,
  settingsGroups,
} from "@renderer/components/settings/settings-groups";
import { useProjectsStore } from "@renderer/stores/projects";
import { useAddProject } from "@renderer/hooks/use-add-project";

let lastPage = "general";
const PROJECT_PREFIX = "project:";
export function SettingsPage({
  initialCategoryKey,
  initialSignInProviderId,
  initialScope,
}: {
  initialCategoryKey?: string;
  initialSignInProviderId?: string;
  initialScope?: "app" | "project";
} = {}) {
  const logs = useLogViewerEnabled();
  const hosts = useCloudEnabled();
  // Runners exist only in a Volli Cloud launch, fixed for the process (VC-895).
  const runners = launchStore() === "cloud";
  const experiments = useExperimentsStore((state) => state.snapshot);
  // Stable hides the experiment, but retains enrollment into the invite-only preview.
  const account = hosts || hasAccountEnrollment(experiments);
  React.useEffect(() => {
    void useExperimentsStore.getState().ensure();
  }, []);
  // A project pane asked for by name (⌘K): taken on mount, or while Settings
  // is already open on another page, then spent so the next visit is ordinary.
  const requestedPane = useUiStore((state) => state.configureCategory);
  const projects = useProjectsStore((s) => s.projects);
  const selectedId = useProjectsStore((s) => s.selectedProjectId);
  const addProject = useAddProject();
  const [projectId, setProjectId] = React.useState(selectedId);
  const project = projects.find((p) => p.id === projectId) ?? null;
  const [activeKey, setActiveKey] = React.useState(
    () =>
      resolveSettingsCategory(initialCategoryKey) ??
      (requestedPane !== null
        ? `${PROJECT_PREFIX}${requestedPane}`
        : initialScope === "project"
          ? "project:overview"
          : lastPage),
  );
  const scope = activeKey.startsWith(PROJECT_PREFIX) ? "project" : "app";
  const appGroups = React.useMemo(
    () => settingsGroups(initialSignInProviderId, { logs, hosts, moves: hosts, account, runners, experiments }),
    [initialSignInProviderId, logs, hosts, account, runners, experiments],
  );
  const projectGroups = React.useMemo<readonly PrefGroup[]>(
    () =>
      project
        ? configureGroups(project).map((group) =>
            Object.assign({}, group, {
              categories: group.categories.map((category) => ({
                ...category,
                key: `${PROJECT_PREFIX}${category.key}`,
              })),
            }),
          )
        : [
            {
              key: "project",
              label: "Project",
              categories: [
                {
                  key: "project:overview",
                  label: "Your project",
                  icon: FolderOpenIcon,
                  content: (
                    <SettingsProjectWelcome
                      hasProjects={projects.length > 0}
                      onOpen={() => void addProject()}
                    />
                  ),
                },
              ],
            },
          ],
    [project, projects.length, addProject],
  );
  React.useEffect(() => {
    if (initialCategoryKey !== undefined)
      setActiveKey(resolveSettingsCategory(initialCategoryKey) ?? "general");
  }, [initialCategoryKey]);
  React.useEffect(() => {
    if (projectId === null && selectedId !== null) setProjectId(selectedId);
  }, [projectId, selectedId]);
  const select = React.useCallback((key: string) => {
    setActiveKey(key);
    lastPage = key;
  }, []);
  React.useEffect(() => {
    if (requestedPane === null) return;
    select(`${PROJECT_PREFIX}${requestedPane}`);
    useUiStore.getState().consumeConfigureCategory();
  }, [requestedPane, select]);
  const navigation = React.useMemo(
    () => ({
      openProject: (id: string, page: string) => {
        setProjectId(id);
        select(`project:${page}`);
      },
    }),
    [select],
  );
  return (
    <SettingsNavigation.Provider value={navigation}>
      <PrefShell
        surfaceLabel="Settings"
        groups={scope === "app" ? appGroups : projectGroups}
        searchGroups={[...appGroups, ...projectGroups]}
        activeKey={activeKey}
        onSelect={select}
        header={
          <SettingsScope
            scope={scope}
            project={project}
            projects={projects}
            onScope={(next) => select(next === "app" ? "general" : "project:overview")}
            onProject={(id) => {
              setProjectId(id);
              select("project:overview");
            }}
            onAdd={() => void addProject()}
          />
        }
      />
    </SettingsNavigation.Provider>
  );
}
