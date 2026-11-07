/** Native Settings renderer: no dialog, scrim, dismissal layer or focus trap. */
import * as React from "react";
import { SettingsPage } from "@renderer/components/pages/settings-page";
import { Toaster } from "@renderer/components/ui/sonner";
import { UpdateInstallDialog } from "@renderer/components/update/update-install-dialog";
import { CloudMovesRoot } from "@renderer/components/cloud-moves/cloud-moves";
import { HostsChrome } from "@renderer/components/hosts/hosts-chrome";
import { FolderClaimDialog } from "@renderer/components/rail/folder-claim-dialog";
import { Button } from "@renderer/components/ui/button";
import { Notice } from "@renderer/components/ui/notice";
import { LoadingLabel } from "@renderer/components/ui/loading-label";
import { useOverlayScrollbars } from "@renderer/hooks/use-overlay-scrollbars";
import { useZoomCommands } from "@renderer/hooks/use-zoom-commands";
import { useUiStore } from "@renderer/stores/ui";
import { acceptSettingsNavigation } from "@renderer/lib/settings-window";
import { toastError } from "@renderer/lib/toast";
import { errorMessage } from "@volli/shared";

/** Repeated ⌘, raises Settings; it never toggles it closed. */
export function useSettingsShortcut() {
  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented || event.repeat || !(event.metaKey || event.ctrlKey) ||
        event.altKey || event.shiftKey || event.key !== ","
      ) return;
      event.preventDefault();
      useUiStore.getState().setSettingsOpen(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

export function SettingsPanel() {
  useSettingsShortcut();
  useOverlayScrollbars();
  useZoomCommands();
  const category = useUiStore((state) => state.settingsCategory);
  const revision = useUiStore((state) => state.settingsNavigationRevision);
  const projectId = useUiStore((state) => state.settingsProjectId);
  const provider = useUiStore((state) => state.settingsSignInProviderId);
  const scale = useUiStore((state) => state.uiScale);
  const pending = useUiStore((state) => state.settingsNavigationPending);
  const failure = useUiStore((state) => state.settingsNavigationError);
  const [scopeReadyRevision, setScopeReadyRevision] = React.useState<number | null>(null);
  const onScopeReady = React.useCallback((appliedRevision: number, error?: string) => {
    const state = useUiStore.getState();
    if (state.settingsNavigationRevision !== appliedRevision || state.settingsNavigationPending) return;
    if (error !== undefined) useUiStore.setState({ settingsNavigationError: error });
    setScopeReadyRevision(appliedRevision);
  }, []);
  React.useEffect(() => {
    // A revision is ready only after its accepted Workspace/project and scoped
    // theme have arrived, or after an honest failure has been rendered.
    if (pending || (failure === null && scopeReadyRevision !== revision)) return;
    let active = true;
    let committedFrame = 0;
    const frame = requestAnimationFrame(() => {
      committedFrame = requestAnimationFrame(() => {
        if (!active || useUiStore.getState().settingsNavigationRevision !== revision) return;
        void window.api.settingsWindow.ready(revision).then((result) => {
          if (!active) return;
          if (!result.ok) toastError(`Couldn't open Settings: ${result.error}`);
          else if (result.navigation !== null) acceptSettingsNavigation(result.navigation);
        }).catch((error: unknown) => {
          if (active) toastError(`Couldn't open Settings: ${errorMessage(error)}`);
        });
      });
    });
    return () => { active = false; cancelAnimationFrame(frame); cancelAnimationFrame(committedFrame); };
  }, [revision, pending, failure, scopeReadyRevision]);
  const retry = () => {
    const state = useUiStore.getState();
    void window.api.settingsWindow.open({
      workspaceId: state.settingsWorkspaceId,
      projectId: state.settingsProjectId,
      category: state.settingsCategory ?? "general",
      configureCategory: state.configureCategory ?? undefined,
      signInProviderId: state.settingsSignInProviderId ?? undefined,
    }).then((result) => {
      if (!result.ok) toastError(`Couldn't open Settings: ${result.error}`);
    }).catch((error: unknown) => toastError(`Couldn't open Settings: ${errorMessage(error)}`));
  };
  React.useEffect(() => {
    document.querySelector<HTMLInputElement>('[data-settings-panel] input[type="search"]')?.focus();
  }, []);
  return (
    <div data-settings-panel className="settings-window flex h-svh min-h-0 flex-col">
      <header className="settings-window-toolbar app-region-drag">
        <h1 className="text-ui font-semibold">Settings</h1>
      </header>
      <div className="flex min-h-0 flex-1" style={{ zoom: scale }}>
        {pending ? (
          <div role="status" className="m-auto text-ui text-muted-foreground"><LoadingLabel>Settings</LoadingLabel></div>
        ) : failure !== null ? (
          <Notice tone="error" title="Couldn't open Settings" detail={failure} className="m-4 self-start" announce
            actions={<Button size="xs" variant="outline" onClick={retry}>Try again</Button>} />
        ) : (
          <SettingsPage key={revision} initialCategoryKey={category ?? undefined} initialSignInProviderId={provider ?? undefined}
            navigationRevision={revision} initialProjectId={projectId} onScopeReady={onScopeReady} />
        )}
      </div>
      <Toaster />
      <UpdateInstallDialog />
      <CloudMovesRoot />
      <HostsChrome />
      <FolderClaimDialog />
    </div>
  );
}
