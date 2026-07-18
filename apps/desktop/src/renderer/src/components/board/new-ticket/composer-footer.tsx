import { CaretDownIcon } from "@phosphor-icons/react/dist/csr/CaretDown";
import { CheckIcon } from "@phosphor-icons/react/dist/csr/Check";
import { HARNESS_IDS, HARNESS_LABELS, harnessLabel, type HarnessId } from "@volli/shared";

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

/**
 * The composer footer: the paperclip file-ref picker, a "Create more" toggle,
 * a quiet "Choose agent" picker showing the active harness, the secondary
 * "Create" button, and the primary "Create & start" action
 * (`data-testid="composer-kickoff"`, its harness carried in the accessible
 * name).
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
              className="text-ui text-muted-foreground"
            >
              {harnessLabel(harnessId)}
              <CaretDownIcon weight="bold" className="size-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {HARNESS_IDS.map((id) => (
              <DropdownMenuItem key={id} onSelect={() => onHarnessChange(id)}>
                {HARNESS_LABELS[id]}
                {id === harnessId ? <CheckIcon weight="bold" className="ml-auto size-3.5" /> : null}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        <Button
          variant="secondary"
          size="sm"
          className="text-ui"
          onClick={onCreate}
          disabled={disabled}
        >
          Create
        </Button>

        <Button
          data-testid="composer-kickoff"
          aria-label={`Create & start · ${harnessLabel(harnessId)}`}
          onClick={onKickoff}
          disabled={disabled}
          size="sm"
          className="text-ui"
        >
          Create &amp; start
        </Button>
      </div>
    </div>
  );
}
