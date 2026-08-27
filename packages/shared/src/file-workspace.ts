/**
 * The Project Files tab workspace (decisions #55/#56): which files are open,
 * their order, which one is active, and which single tab is the replaceable
 * *preview* slot. Pure reducer-style state transitions — no persistence, no
 * document contents, no editor bindings; the renderer holds one of these per
 * project (and one per ticket workspace, since the same relPath in two
 * checkouts is two different documents, decision #54) and main persists the
 * serialized shape verbatim.
 */
import { isSafeRelPath } from "./file-ref";

/** One open tab. A preview tab is unpinned; at most one preview tab exists. */
export interface FileWorkspaceTab {
  readonly relPath: string;
  readonly pinned: boolean;
}

/**
 * One workspace's restorable state: the tab strip left-to-right plus the
 * focused file. `activeRelPath` always names one of `tabs` (or is `null` when
 * there are none) — every operation here maintains that, and
 * {@link sanitizeFileWorkspace} re-establishes it for restored state.
 */
export interface FileWorkspaceState {
  readonly tabs: readonly FileWorkspaceTab[];
  readonly activeRelPath: string | null;
}

/** The workspace a project starts with, and the fallback for unusable rehydrated state. */
export const EMPTY_FILE_WORKSPACE: FileWorkspaceState = { tabs: [], activeRelPath: null };

/**
 * Single-click: open `relPath` in the preview slot, replacing an existing
 * preview tab IN PLACE (same index). Focuses it. An already-open file is only
 * activated — re-previewing a pinned tab must never demote it back to
 * replaceable, and must not evict whatever is sitting in the preview slot.
 */
export function previewFile(state: FileWorkspaceState, relPath: string): FileWorkspaceState {
  if (state.tabs.some((tab) => tab.relPath === relPath)) return activateFile(state, relPath);
  const previewIndex = state.tabs.findIndex((tab) => !tab.pinned);
  const tabs = [...state.tabs];
  const opened: FileWorkspaceTab = { relPath, pinned: false };
  // Replacing in place (not remove-then-append) is what keeps a glance from
  // reshuffling the strip under the pointer.
  if (previewIndex === -1) tabs.push(opened);
  else tabs[previewIndex] = opened;
  return { tabs, activeRelPath: relPath };
}

/**
 * Double-click or explicit Pin: make `relPath` persistent, opening it (pinned,
 * appended, active) when it isn't open yet. Pinning an already-open tab leaves
 * it where it sits and does not steal focus — the pin action can come from a
 * context menu on a tab the user isn't looking at. An already-pinned tab is
 * returned by identity, so a redundant pin costs subscribers no re-render.
 */
export function pinFile(state: FileWorkspaceState, relPath: string): FileWorkspaceState {
  const index = state.tabs.findIndex((tab) => tab.relPath === relPath);
  if (state.tabs[index]?.pinned === true) return state;
  if (index === -1) {
    return {
      tabs: [...state.tabs, { relPath, pinned: true }],
      activeRelPath: relPath,
    };
  }
  const tabs = [...state.tabs];
  tabs[index] = { relPath, pinned: true };
  return { tabs, activeRelPath: state.activeRelPath };
}

/**
 * First edit of a tab promotes it out of the preview slot (decision #56: "a
 * dirty tab is never replaced"). No-op when the file isn't open or is already
 * persistent, so callers can fire it on every keystroke.
 */
export function markFileEdited(state: FileWorkspaceState, relPath: string): FileWorkspaceState {
  // Deliberately not `pinFile`: an edit reports on a tab that already exists;
  // it must never conjure one for a path the workspace never opened.
  if (!state.tabs.some((tab) => tab.relPath === relPath && !tab.pinned)) return state;
  return pinFile(state, relPath);
}

/**
 * Activate an already-open tab (tab-strip click, navigator focus). A path that
 * isn't open is ignored rather than opened — restoring a stale selection must
 * not resurrect a tab the user closed.
 */
export function activateFile(state: FileWorkspaceState, relPath: string): FileWorkspaceState {
  if (state.activeRelPath === relPath) return state;
  if (!state.tabs.some((tab) => tab.relPath === relPath)) return state;
  return { tabs: state.tabs, activeRelPath: relPath };
}

/**
 * Close a tab. Closing the focused one hands focus to its nearest neighbour —
 * the tab on the left, else whatever slid into the freed index — so repeated
 * closes walk backwards through the strip instead of jumping. Focus is
 * untouched when some other tab is closed.
 */
export function closeFile(state: FileWorkspaceState, relPath: string): FileWorkspaceState {
  const index = state.tabs.findIndex((tab) => tab.relPath === relPath);
  if (index === -1) return state;
  const tabs = state.tabs.filter((_, i) => i !== index);
  if (state.activeRelPath !== relPath) return { tabs, activeRelPath: state.activeRelPath };
  const neighbour = tabs[index - 1] ?? tabs[index] ?? null;
  return { tabs, activeRelPath: neighbour === null ? null : neighbour.relPath };
}

/**
 * Follow a renamed file: the tab that was showing `from` now shows `to`, in the
 * same slot, with its pinned state and (if it had it) its focus (VC-191).
 *
 * A rename is not a close and an open — the strip must not reshuffle, and a
 * pinned tab must not come back replaceable — so this is a substitution rather
 * than `closeFile` + `pinFile`. A file that was not open stays not open: main
 * renames files, not tabs, and conjuring a tab for one would open a file nobody
 * asked to see.
 *
 * `to` already being open is the odd case, and it is real: main refuses to
 * clobber, but a tab can outlive the file it named (an agent deleted it, the
 * user is renaming another file onto the freed name). The stale tab is absorbed
 * rather than left beside its replacement, because two tabs for one relPath is
 * exactly the duplicate `sanitizeFileWorkspace` exists to collapse — pinned if
 * either was, since persistence must never be silently lost.
 */
export function renameFile(
  state: FileWorkspaceState,
  from: string,
  to: string,
): FileWorkspaceState {
  const index = state.tabs.findIndex((tab) => tab.relPath === from);
  if (index === -1 || from === to) return state;
  const existing = state.tabs.find((tab) => tab.relPath === to);
  const renamed: FileWorkspaceTab = {
    relPath: to,
    pinned: state.tabs[index]?.pinned === true || existing?.pinned === true,
  };
  const tabs = state.tabs
    .map((tab, i) => (i === index ? renamed : tab))
    .filter((tab, i) => i === index || tab.relPath !== to);
  const activeRelPath =
    state.activeRelPath === from || state.activeRelPath === to ? to : state.activeRelPath;
  return { tabs, activeRelPath };
}

/**
 * Arrange a tab: move `relPath` to `toIndex` in the strip, and PIN it (VC-189,
 * plan §4.3).
 *
 * THE PIN IS THE DECISION. Arranging a tab is a deliberate act — the person
 * said where this file belongs — and a tab the person placed must not be
 * silently replaced by the next glance from the navigator. That is decision
 * #56's "a dirty tab is never replaced" applied to the other way a tab earns
 * its slot, and it is here in the reducer rather than at the two call sites so
 * Home and the ticket workspace cannot answer it differently.
 *
 * `toIndex` is clamped into the strip rather than validated: a drop lands
 * between two tabs that exist, so an index past either end means "the end it
 * ran past". Focus is untouched — arranging a tab is not selecting it, and a
 * drag can start on a tab that is not in front. A path that is not open is
 * ignored, like every other operation here: a strip cannot arrange a tab it
 * does not have.
 */
export function moveFile(
  state: FileWorkspaceState,
  relPath: string,
  toIndex: number,
): FileWorkspaceState {
  const from = state.tabs.findIndex((tab) => tab.relPath === relPath);
  if (from === -1) return state;
  const to = Math.min(Math.max(toIndex, 0), state.tabs.length - 1);
  const pinned = state.tabs.some((tab) => tab.relPath === relPath && tab.pinned);
  // A pinned tab dropped back on its own slot changed nothing — return by
  // identity so subscribers don't re-render for a drag that went nowhere.
  if (from === to && pinned) return state;
  const tabs = state.tabs.filter((tab) => tab.relPath !== relPath);
  tabs.splice(to, 0, { relPath, pinned: true });
  return { tabs, activeRelPath: state.activeRelPath };
}

/**
 * The one tab whose PATH changed IN PLACE between two versions of a strip, or
 * `null` when this transition was not a substitution.
 *
 * READ rather than predicted, so it cannot drift from the reducers it reports
 * on. {@link previewFile} replacing the preview slot and {@link renameFile}
 * following a rename are the two transitions that keep a tab's slot while
 * changing the file under it, and both appear here as "same length, exactly one
 * index disagrees". Opening, closing, pinning and {@link moveFile} each fail
 * one of those two tests — a move disagrees at two indices at the very least —
 * so a caller may hand every transition to this and act only on the ones that
 * moved a tab's identity.
 *
 * The renderer needs it because a File tab's id carries its path, so a
 * substitution renames that tab as far as a strip ARRANGEMENT is concerned
 * (VC-189, `tab-order.ts`'s `renamedTabOrder`).
 */
export function substitutedPath(
  before: readonly FileWorkspaceTab[],
  after: readonly FileWorkspaceTab[],
): { from: string; to: string } | null {
  if (before.length !== after.length) return null;
  let found: { from: string; to: string } | null = null;
  for (let index = 0; index < after.length; index += 1) {
    // Both indices are in range: the lengths are equal, and checked above.
    const was = before[index]!.relPath;
    const now = after[index]!.relPath;
    if (was === now) continue;
    // A second disagreement means the strip was reordered, not substituted.
    if (found !== null) return null;
    found = { from: was, to: now };
  }
  return found;
}

/** Whether `relPath` is currently the replaceable preview tab. */
export function isPreviewTab(state: FileWorkspaceState, relPath: string): boolean {
  return state.tabs.some((tab) => tab.relPath === relPath && !tab.pinned);
}

/**
 * Validate rehydrated workspace JSON from a possibly-older build. Persisted
 * state is never trusted: an unusable shape degrades to
 * {@link EMPTY_FILE_WORKSPACE} rather than throwing on the restore path, since
 * a corrupt tab record must not be able to keep Project Files from opening.
 */
export function sanitizeFileWorkspace(raw: unknown): FileWorkspaceState {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return EMPTY_FILE_WORKSPACE;
  const { tabs, activeRelPath } = raw as { tabs?: unknown; activeRelPath?: unknown };
  if (!Array.isArray(tabs)) return EMPTY_FILE_WORKSPACE;

  const kept: FileWorkspaceTab[] = [];
  for (const entry of tabs) {
    if (typeof entry !== "object" || entry === null) continue;
    const { relPath, pinned } = entry as { relPath?: unknown; pinned?: unknown };
    if (typeof relPath !== "string" || typeof pinned !== "boolean") continue;
    // Persisted state is an untrusted input path into the file readers, so it
    // clears the same first-layer safety gate as any other relPath.
    if (!isSafeRelPath(relPath)) continue;
    const existing = kept.findIndex((tab) => tab.relPath === relPath);
    // A relPath identifies a document, so a duplicate is one tab written twice:
    // collapse it onto the first slot, taking the pinned reading (persistence
    // must never silently demote a tab the user made persistent).
    if (existing === -1) kept.push({ relPath, pinned });
    else if (pinned) kept[existing] = { relPath, pinned: true };
  }

  // At most one preview tab is the invariant every operation upholds, so
  // rehydrated state has to arrive already holding it. Extra unpinned tabs are
  // pinned rather than closed — the last one stays the preview slot because it
  // is the most recent glance, and no open file is lost to a format change.
  const lastPreview = kept.map((tab) => tab.pinned).lastIndexOf(false);
  const tabsOut = kept.map((tab, i) =>
    i < lastPreview && !tab.pinned ? { relPath: tab.relPath, pinned: true } : tab,
  );

  const active =
    typeof activeRelPath === "string" && tabsOut.some((tab) => tab.relPath === activeRelPath)
      ? activeRelPath
      : null;
  return { tabs: tabsOut, activeRelPath: active };
}
