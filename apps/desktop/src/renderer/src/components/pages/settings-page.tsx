/** One Settings surface for machine configuration and project overrides. */
import { SettingsNavigation } from "@renderer/components/settings/settings-navigation";
import * as React from "react";
import { FolderOpenIcon } from "@renderer/components/ui/icon";

import { hasAccountEnrollment, useExperimentsStore } from "@renderer/stores/experiments";
import { launchStore } from "@renderer/stores/launch";
import { useUiStore } from "@renderer/stores/ui";
import { useCloudEnabled } from "@renderer/components/hosts/use-hosts";
import { useLogViewerEnabled } from "@renderer/components/logs/log-viewer";
import { configureGroups, globalAgentGroups } from "@renderer/components/settings/configure-groups";
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
import { useThemeStore } from "@renderer/stores/theme";
import { useAddProject } from "@renderer/hooks/use-add-project";

let lastPage = "general";
const PROJECT_PREFIX = "project:";
// Configure requests name a project's pane; the app's Appearance route is separate.
const configurePaneKey = (key: string) => (key === "appearance" ? "project:appearance" : key);
/** Legacy pane requests keep their spelling; machine inventories have one destination. */
function settingsPaneKey(key: string, cloud: boolean): string {
  const pane = key.replace(/^project:/, "");
  if (!cloud && (pane === "mcp" || pane === "skills")) return pane;
  if (key.startsWith(PROJECT_PREFIX)) return key;
  return ["overview", "sessions", "worktrees", "commands", "secrets"].includes(key) ||
    (cloud && (pane === "mcp" || pane === "skills"))
    ? `${PROJECT_PREFIX}${key}`
    : key;
}
export function SettingsPage({
  initialCategoryKey,
  initialSignInProviderId,
  initialScope,
  navigationRevision,
  initialProjectId,
  onScopeReady,
}: {
  initialCategoryKey?: string;
  initialSignInProviderId?: string;
  initialScope?: "app" | "project";
  navigationRevision?: number;
  initialProjectId?: string | null;
  onScopeReady?: (revision: number, error?: string) => void;
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
  const [projectId, setProjectId] = React.useState(initialProjectId === undefined ? selectedId : initialProjectId);
  React.useEffect(() => {
    if (initialProjectId !== undefined) setProjectId(initialProjectId);
  }, [initialProjectId, navigationRevision]);
  const [previousSelection, setPreviousSelection] = React.useState(selectedId);
  // A scope choice is local to Settings; an explicit workspace switch still
  // follows that workspace, without painting the previous project's controls.
  if (previousSelection !== selectedId) {
    setPreviousSelection(selectedId);
    if (initialProjectId === undefined) setProjectId(selectedId);
  }
  const project = projects.find((p) => p.id === projectId) ?? null;
  const [activeKey, setActiveKey] = React.useState(
    () =>
      resolveSettingsCategory(
        initialCategoryKey === undefined ? undefined : settingsPaneKey(initialCategoryKey, runners),
      ) ??
      (requestedPane !== null
        ? settingsPaneKey(configurePaneKey(requestedPane), runners)
        : initialScope === "project"
          ? "project:overview"
          : settingsPaneKey(lastPage, runners)),
  );
  const scope = activeKey.startsWith(PROJECT_PREFIX) ? "project" : "app";
  const readyNavigation = React.useRef<number | null>(null);
  React.useEffect(() => {
    if (window.location?.hash !== "#settings") return;
    let active = true;
    let completed = false;
    let frame = 0;
    let committedFrame = 0;
    const revision = navigationRevision;
    const finish = (error?: string) => {
      if (!active || completed || revision === undefined) return;
      completed = true;
      readyNavigation.current = revision;
      onScopeReady?.(revision, error);
    };
    const timeout = setTimeout(() => finish("Couldn't load the theme. Try opening Settings again."), 10_000);
    // The first requested scope is a hard cut while hidden, not a transition
    // from App colors. Later user scope changes keep their ordinary motion.
    void useThemeStore.getState().hydrate(
      scope === "project" && project !== null
        ? {
            projectId: project.id,
            canvas: project.themeCanvas ?? null,
            appearance: project.themeAppearance ?? null,
          }
        : null,
      revision !== undefined && readyNavigation.current !== revision ? "keyboard" : undefined,
    ).then((hydrated: unknown) => {
      if (!active || completed) return;
      if (hydrated === false) {
        finish("Couldn't load the theme. Try opening Settings again.");
        return;
      }
      clearTimeout(timeout);
      // A completed scope read is not yet a committed native frame. Leave a
      // rendering opportunity between token adoption and its acknowledgement.
      frame = requestAnimationFrame(() => {
        committedFrame = requestAnimationFrame(() => finish());
      });
    }).catch(() => finish("Couldn't load the theme. Try opening Settings again."));
    return () => {
      active = false;
      clearTimeout(timeout);
      cancelAnimationFrame(frame);
      cancelAnimationFrame(committedFrame);
    };
  }, [scope, project, navigationRevision, onScopeReady]);
  const appGroups = React.useMemo(() => {
    const groups = settingsGroups(initialSignInProviderId, {
      logs,
      hosts,
      moves: hosts,
      account,
      runners,
      experiments,
    });
    return [
      ...groups.slice(0, 1),
      ...(!runners ? globalAgentGroups(project) : []),
      ...groups.slice(1),
    ];
  }, [initialSignInProviderId, logs, hosts, account, runners, experiments, project]);
  const projectGroups = React.useMemo<readonly PrefGroup[]>(
    () =>
      project
        ? configureGroups(project).map((group) =>
            Object.assign({}, group, {
              categories: group.categories
                .filter(
                  (category) => runners || (category.key !== "mcp" && category.key !== "skills"),
                )
                .map((category) =>
                  Object.assign({}, category, {
                    key: `${PROJECT_PREFIX}${category.key}`,
                  }),
                ),
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
    [project, projects.length, addProject, runners],
  );
  React.useEffect(() => {
    if (initialCategoryKey !== undefined)
      setActiveKey(
        resolveSettingsCategory(settingsPaneKey(initialCategoryKey, runners)) ?? "general",
      );
  }, [initialCategoryKey, runners, navigationRevision]);
  const select = React.useCallback((key: string) => {
    setActiveKey(key);
    lastPage = key;
  }, []);
  React.useEffect(() => {
    if (requestedPane === null) return;
    setProjectId(initialProjectId === undefined ? selectedId : initialProjectId);
    select(settingsPaneKey(configurePaneKey(requestedPane), runners));
    useUiStore.getState().consumeConfigureCategory();
  }, [requestedPane, select, runners, selectedId, initialProjectId]);
  const navigation = React.useMemo(
    () => ({
      selectPolicyProject: (id: string) => setProjectId(id),
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
              if (activeKey !== "skills" && activeKey !== "mcp") select("project:overview");
            }}
            onAdd={() => void addProject()}
          />
        }
      />
    </SettingsNavigation.Provider>
  );
}
