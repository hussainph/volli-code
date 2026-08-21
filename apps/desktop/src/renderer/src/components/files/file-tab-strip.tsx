/**
 * The Project Files tab strip (CONCEPT #55/#56) — the full-width row above the
 * editor in the Files workbench. The drawing and the focus mechanics are
 * `ui/tab-strip.tsx`'s (the folder variant, shared with the ticket detail);
 * what is left here is the editor vocabulary this strip speaks:
 *
 *  - a PREVIEW tab (unpinned, the single replaceable slot) is italic — the
 *    convention every code editor already taught the user;
 *  - double-clicking a preview tab, or "Keep Open" in its context menu, pins it;
 *  - two tabs that share a basename carry a parent-directory hint;
 *  - a DIRTY tab's close button is a dot until you point at it, so unsaved work
 *    is visible from across the strip and can still be closed in one click.
 *
 * Purely presentational: labels come from the pure {@link fileTabLabels}, and
 * every gesture is reported to the workbench, which owns the store writes and
 * the dirty-close guard.
 */
import { PushPinIcon } from "@phosphor-icons/react/dist/csr/PushPin";
import { XIcon } from "@phosphor-icons/react/dist/csr/X";
import { XSquareIcon } from "@phosphor-icons/react/dist/csr/XSquare";
import type { FileWorkspaceTab } from "@volli/shared";

import { ExternalAppContextMenu } from "@renderer/components/files/external-app-menu";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@renderer/components/ui/context-menu";
import { Tab, TabStrip, tabStopIndex } from "@renderer/components/ui/tab-strip";

import { fileTabLabels } from "./file-tab-labels";

export interface FileTabStripProps {
  /** The Project Files checkout that every tab in this strip resolves against. */
  projectId: string;
  /** The workspace's tabs in strip order (`@volli/shared`'s FileWorkspaceState.tabs). */
  tabs: readonly FileWorkspaceTab[];
  activeRelPath: string | null;
  /** relPaths whose editor holds unsaved work — drives the dot and the close guard. */
  dirtyPaths: ReadonlySet<string>;
  onSelect(relPath: string): void;
  /** Double-click / "Keep Open": promote the preview tab to persistent. */
  onPin(relPath: string): void;
  /** Close request — the workbench decides whether a guard is needed first. */
  onClose(relPath: string): void;
  onCloseOthers(relPath: string): void;
}

function FileTab({
  projectId,
  relPath,
  name,
  hint,
  preview,
  dirty,
  active,
  tabStop,
  onSelect,
  onPin,
  onClose,
  onCloseOthers,
}: {
  projectId: string;
  relPath: string;
  name: string;
  hint: string | null;
  preview: boolean;
  dirty: boolean;
  active: boolean;
  /** This tab is the strip's single roving-tabindex entry point (see {@link FileTabStrip}). */
  tabStop: boolean;
  onSelect(): void;
  onPin(): void;
  onClose(): void;
  onCloseOthers(): void;
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <Tab
          data-testid="file-tab"
          data-rel-path={relPath}
          data-preview={preview ? "true" : "false"}
          data-dirty={dirty ? "true" : "false"}
          label={name}
          hint={hint ?? undefined}
          active={active}
          tabStop={tabStop}
          dirty={dirty}
          labelClassName={preview ? "italic" : undefined}
          onActivate={onSelect}
          onDoubleClick={preview ? onPin : undefined}
          onClose={onClose}
        />
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ExternalAppContextMenu target={{ kind: "file", projectId, relPath }} />
        <ContextMenuSeparator />
        <ContextMenuItem icon={PushPinIcon} disabled={!preview} onSelect={onPin}>
          Keep Open
        </ContextMenuItem>
        <ContextMenuItem icon={XIcon} onSelect={onClose}>
          Close
        </ContextMenuItem>
        <ContextMenuItem icon={XSquareIcon} onSelect={onCloseOthers}>
          Close Others
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

export function FileTabStrip({
  projectId,
  tabs,
  activeRelPath,
  dirtyPaths,
  onSelect,
  onPin,
  onClose,
  onCloseOthers,
}: FileTabStripProps) {
  // Not memoized: a strip holds a handful of tabs, and the store hands over a
  // fresh array on most updates anyway, so a memo keyed on it would never hit.
  const labels = fileTabLabels(tabs.map((tab) => tab.relPath));
  const stop = tabStopIndex(
    tabs.length,
    tabs.findIndex((tab) => tab.relPath === activeRelPath),
  );

  if (tabs.length === 0) return null;

  return (
    <TabStrip data-testid="file-tab-strip" label="File tabs">
      {tabs.map((tab, index) => {
        const label = labels[index] ?? { name: tab.relPath, hint: null };
        return (
          <FileTab
            key={tab.relPath}
            projectId={projectId}
            relPath={tab.relPath}
            name={label.name}
            hint={label.hint}
            preview={!tab.pinned}
            dirty={dirtyPaths.has(tab.relPath)}
            active={tab.relPath === activeRelPath}
            tabStop={index === stop}
            onSelect={() => onSelect(tab.relPath)}
            onPin={() => onPin(tab.relPath)}
            onClose={() => onClose(tab.relPath)}
            onCloseOthers={() => onCloseOthers(tab.relPath)}
          />
        );
      })}
    </TabStrip>
  );
}
