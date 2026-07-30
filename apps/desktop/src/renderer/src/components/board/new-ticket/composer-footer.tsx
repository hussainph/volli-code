import { CaretDownIcon } from "@phosphor-icons/react/dist/csr/CaretDown";
import { CheckIcon } from "@phosphor-icons/react/dist/csr/Check";
import * as React from "react";
import {
  FIRST_CLASS_HARNESS_IDS,
  HARNESS_LABELS,
  harnessLabel,
  type HarnessId,
} from "@volli/shared";

import { ComposerFileAttach } from "@renderer/components/board/new-ticket/composer-file-attach";
import { Button } from "@renderer/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@renderer/components/ui/dropdown-menu";
import { Switch } from "@renderer/components/ui/switch";
import type { FileIndexHandle } from "@renderer/hooks/use-file-index";
import { hydrateHarnessCatalog, useHarnessCatalogStore } from "@renderer/stores/sessions";

/**
 * The composer footer: the paperclip file-ref picker, a "Create more" toggle,
 * a quiet "Choose agent" picker showing the active harness, the secondary
 * "Create" button, and the primary "Create & start" action
 * (`data-testid="composer-kickoff"`, its harness carried in the accessible
 * name).
 *
 * The picker offers the built-ins and every harness the user has registered and
 * trusted, in one list and under one kind of name — a manifest's own label,
 * exactly as a built-in's. Nothing marks which is which, because nothing about
 * choosing depends on it: the user wrote the manifest, and the launch door
 * refuses an untrusted id whatever this list says.
 */
export function ComposerFooter({
  fileIndex,
  onInsertRef,
  createMore,
  onCreateMoreChange,
  harnessId,
  onHarnessChange,
  onCreate,
  onKickoff,
  disabled,
}: {
  fileIndex: FileIndexHandle;
  onInsertRef: (relPath: string) => void;
  createMore: boolean;
  onCreateMoreChange: (createMore: boolean) => void;
  harnessId: HarnessId;
  onHarnessChange: (harnessId: HarnessId) => void;
  onCreate: () => void;
  onKickoff: () => void;
  disabled: boolean;
}) {
  const registered = useHarnessCatalogStore((state) => state.registered);
  // Radix mounts this fresh on every composer open, so "on mount" is "per open"
  // — which is when the answer can have gone stale: a verdict recorded since
  // the last open regenerated the wrappers and moved the set.
  React.useEffect(() => {
    void hydrateHarnessCatalog();
  }, []);

  const harnesses: { id: HarnessId; label: string }[] = [
    ...FIRST_CLASS_HARNESS_IDS.map((id) => ({ id, label: HARNESS_LABELS[id] })),
    ...registered.map((adapter) => ({ id: adapter.id, label: adapter.label })),
  ];
  // The manifest's own label, since `harnessLabel` can only fall back to the raw
  // slug for a harness @volli/shared does not ship.
  const activeLabel =
    harnesses.find((harness) => harness.id === harnessId)?.label ?? harnessLabel(harnessId);

  return (
    <div className="flex items-center gap-2">
      <ComposerFileAttach fileIndex={fileIndex} onInsert={onInsertRef} />

      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        <Switch
          aria-label="Create more"
          checked={createMore}
          onCheckedChange={onCreateMoreChange}
        />
        Create more
      </label>

      <div className="ml-auto flex items-center gap-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            {/* Never disabled by an empty title — picking the agent is
                independent of whether the ticket is ready to submit. */}
            <Button
              aria-label="Choose agent"
              variant="ghost"
              size="sm"
              className="text-muted-foreground"
            >
              {activeLabel}
              <CaretDownIcon weight="bold" className="size-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {harnesses.map((harness) => (
              <DropdownMenuItem key={harness.id} onSelect={() => onHarnessChange(harness.id)}>
                {harness.label}
                {harness.id === harnessId ? (
                  <CheckIcon weight="bold" className="ml-auto size-3.5" />
                ) : null}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        <Button variant="secondary" size="sm" onClick={onCreate} disabled={disabled}>
          Create
        </Button>

        <Button
          data-testid="composer-kickoff"
          aria-label={`Create & start · ${activeLabel}`}
          onClick={onKickoff}
          disabled={disabled}
          size="sm"
        >
          Create &amp; start
        </Button>
      </div>
    </div>
  );
}
