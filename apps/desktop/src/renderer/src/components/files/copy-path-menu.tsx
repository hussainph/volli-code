/**
 * Copy Path / Copy Relative Path, on every Files context menu (plan §4.1).
 *
 * The two items sit beside "Open in…" for the same reason it exists: some of the
 * work a person does with a file happens outside this window, and a path they
 * have to retype by hand is a wall. Relative is what an agent, a `git` argument
 * or a code review wants; absolute is what a shell in another terminal wants.
 *
 * WHERE THE ABSOLUTE PATH COMES FROM. Not from a new IPC round trip — the answer
 * is decision #6's resolution rule, which now lives once in `@volli/shared` and
 * is the same rule main uses to open the bytes (`resolveFileRoot`). The two
 * inputs it needs are already in the renderer's own stores: the project's
 * checkout, and the ticket's worktree when the surface belongs to a ticket. A
 * ticket whose worktree row is `null` resolves to the main checkout, exactly as
 * a read of that path would.
 */
import { CopyIcon } from "@phosphor-icons/react/dist/csr/Copy";
import { CopySimpleIcon } from "@phosphor-icons/react/dist/csr/CopySimple";
import { absoluteFilePath, errorMessage } from "@volli/shared";

import { ContextMenuItem } from "@renderer/components/ui/context-menu";
import { toastError } from "@renderer/lib/toast";
import { useBoardStore } from "@renderer/stores/board";
import { useProjectsStore } from "@renderer/stores/projects";

/** The file a Copy Path item names, in the same shape the Open-in menu takes. */
export interface CopyPathTarget {
  projectId: string;
  /** Absent on Home's Main-checkout surfaces, which have no worktree to resolve into. */
  ticketId?: string;
  relPath: string;
}

/** One item's whole content: what it says, and the string it puts on the clipboard. */
export interface CopyPathEntry {
  id: "absolute" | "relative";
  label: string;
  /** Named in the failure sentence when the clipboard refuses. */
  noun: string;
  value: string;
}

/**
 * The entries a menu draws, given what this renderer can actually say.
 *
 * `absolutePath: null` DROPS the absolute item rather than falling back to
 * something plausible. It is null only while the project row has not arrived,
 * and a Copy Path that guessed a checkout root would put a path on the clipboard
 * that names no file — worse than an item that is briefly not there, because the
 * user would find out about it in another program.
 */
export function copyPathEntries(input: {
  absolutePath: string | null;
  relPath: string;
}): CopyPathEntry[] {
  const relative: CopyPathEntry = {
    id: "relative",
    label: "Copy Relative Path",
    noun: "relative path",
    value: input.relPath,
  };
  if (input.absolutePath === null) return [relative];
  return [
    { id: "absolute", label: "Copy Path", noun: "path", value: input.absolutePath },
    relative,
  ];
}

/**
 * The absolute path, or `null` when this renderer cannot yet say what it is.
 * Reads the same two facts main resolves against: the project's checkout, and
 * the ticket's worktree when the surface belongs to one.
 */
export function useAbsoluteFilePath(target: CopyPathTarget): string | null {
  const projectPath = useProjectsStore(
    (state) => state.projects.find((project) => project.id === target.projectId)?.path ?? null,
  );
  const worktreePath = useBoardStore((state) =>
    target.ticketId === undefined
      ? null
      : (state.ticketsByProject[target.projectId]?.find((ticket) => ticket.id === target.ticketId)
          ?.worktreePath ?? null),
  );
  if (projectPath === null) return null;
  return absoluteFilePath({ projectPath, worktreePath, relPath: target.relPath });
}

/** What a clipboard write needs from `navigator.clipboard`, so a test can supply it. */
export interface ClipboardWriter {
  writeText(text: string): Promise<void>;
}

/**
 * One clipboard write. A refusal is surfaced rather than swallowed (CLAUDE.md) —
 * it is the whole outcome of a press, and a silent one would look like a copy.
 */
export async function copyPathToClipboard(
  entry: CopyPathEntry,
  clipboard: ClipboardWriter | undefined = globalThis.navigator?.clipboard,
): Promise<void> {
  try {
    if (clipboard === undefined) throw new Error("The clipboard is unavailable");
    await clipboard.writeText(entry.value);
  } catch (error) {
    toastError(`Couldn't copy the ${entry.noun}: ${errorMessage(error)}`);
  }
}

const ENTRY_ICONS = { absolute: CopyIcon, relative: CopySimpleIcon } as const;

/**
 * The pair of items. Rendered inside a `ContextMenuContent`, so it is a fragment
 * rather than a surface of its own.
 */
export function CopyPathContextMenuItems({ target }: { target: CopyPathTarget }) {
  const absolutePath = useAbsoluteFilePath(target);
  return (
    <>
      {copyPathEntries({ absolutePath, relPath: target.relPath }).map((entry) => (
        <ContextMenuItem
          key={entry.id}
          icon={ENTRY_ICONS[entry.id]}
          onSelect={() => void copyPathToClipboard(entry)}
        >
          {entry.label}
        </ContextMenuItem>
      ))}
    </>
  );
}
