import { CaretDownIcon } from "@phosphor-icons/react/dist/csr/CaretDown";
import { CheckIcon } from "@phosphor-icons/react/dist/csr/Check";
import { TerminalWindowIcon } from "@phosphor-icons/react/dist/csr/TerminalWindow";
import * as React from "react";
import {
  FIRST_CLASS_HARNESS_IDS,
  HARNESS_LABELS,
  harnessLabel,
  type HarnessId,
} from "@volli/shared";

import { composerChipClass } from "@renderer/components/board/new-ticket/composer-chip";
import { Button } from "@renderer/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@renderer/components/ui/dropdown-menu";
import { hydrateHarnessCatalog, useHarnessCatalogStore } from "@renderer/stores/sessions";

/**
 * The chip row's harness picker, showing the active one.
 *
 * The picker names a TERMINAL, and that is the whole of what it picks. Kickoff
 * boots a PTY and auto-launches the chosen TUI in it (`submit.ts`'s
 * `runKickoff`); it starts no structured chat, and no entry in this list is an
 * Agent Runtime. A user chooses Model Access, not an executor — a label saying
 * "agent" here would have offered a choice the product does not make. That is
 * also what the terminal glyph is for: it is the one chip in the row whose
 * subject could be misread as the agent, so it says terminal in a mark as well
 * as in its accessible name.
 *
 * It sits among Status / Priority / Labels rather than beside the submit
 * buttons because it is ticket metadata of the same kind — a property of the
 * ticket you are describing, not a modifier of the button you are about to
 * press. The kickoff button still carries the active harness in its accessible
 * name, which is what makes the pairing legible without putting the two
 * controls next to each other.
 *
 * The picker offers the built-ins and every harness the user has registered and
 * trusted, in one list and under one kind of name — a manifest's own label,
 * exactly as a built-in's. Nothing marks which is which, because nothing about
 * choosing depends on it: the user wrote the manifest, and the launch door
 * refuses an untrusted id whatever this list says.
 */
export function ComposerHarnessChip({
  harnessId,
  onChange,
}: {
  harnessId: HarnessId;
  onChange: (harnessId: HarnessId) => void;
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
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {/* Never disabled by an empty title — picking the terminal is
            independent of whether the ticket is ready to submit. */}
        <Button
          aria-label="Terminal harness"
          variant="ghost"
          size="sm"
          className={composerChipClass()}
        >
          <TerminalWindowIcon />
          {activeLabel}
          <CaretDownIcon weight="bold" className="size-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {harnesses.map((harness) => (
          <DropdownMenuItem key={harness.id} onSelect={() => onChange(harness.id)}>
            {harness.label}
            {harness.id === harnessId ? (
              <CheckIcon weight="bold" className="ml-auto size-3.5" />
            ) : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The active harness's label — the kickoff button carries it in its accessible name. */
export function useActiveHarnessLabel(harnessId: HarnessId): string {
  const registered = useHarnessCatalogStore((state) => state.registered);
  return registered.find((adapter) => adapter.id === harnessId)?.label ?? harnessLabel(harnessId);
}
