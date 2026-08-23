/**
 * The self-update door (VC-59): the four `volli:update-*` invoke channels
 * that let the sidebar's download icon drive the VC-24 updater. Everything
 * here takes its seams injected — the auto-update handle, the live-work
 * readers, the quit latch — so the riskiest ordering in the slice (latch
 * BEFORE `quitAndInstall()`, un-latch on a synchronous throw) is testable
 * under plain Node, the same way `auto-update.ts` itself is.
 *
 * Deliberately NOT session-rpc: `startAutoUpdate` is wired outside the
 * `dbHandle.ok` block precisely so a broken db cannot strand the install on a
 * stale build, and session-rpc is null in exactly that case. These channels
 * ride the same guarded invoke surface the retention watch uses.
 */
import { errorMessage } from "@volli/shared";

import type { UpdateChannel } from "../ipc/contract";
import type { AutoUpdateHandle } from "./auto-update";
import { UPDATE_IPC } from "./ipc-descriptors";
import { registerGuardedIpcHandlers } from "./ipc-registry";

export interface UpdateIpcDeps {
  /** The running updater's command surface — `startAutoUpdate`'s handle. */
  update: Pick<AutoUpdateHandle, "state" | "checkNow" | "quitAndInstall">;
  /** The foreground process of each busy PTY — `ptyManager.busySessions()`, the input both native gates read. */
  busyCommands(): string[];
  /** How many structured agent Sessions have a turn open right now — 0 when no runtime exists. */
  openAgentTurns(): Promise<number>;
  /** The renderer's last unsaved-drafts report — `unsavedDocumentNames()`. */
  unsavedDrafts(): readonly string[];
  /** Raises the quit-gate latch (`beginAcceptedUpdateInstall`) — the native gates stand down. */
  beginInstall(): void;
  /** Lowers it again (`abandonAcceptedUpdateInstall`) after a quitAndInstall that threw. */
  abandonInstall(): void;
  /**
   * The release-line setting (VC-111). Injected like everything else here, and
   * OPTIONAL because these channels are registered outside the `dbHandle.ok`
   * block — the same reason this whole module is not session-rpc. With no db
   * there is nowhere to store a channel, so the surface reports the honest
   * default and refuses the write rather than pretending it landed.
   */
  channel?: {
    read(): UpdateChannel;
    write(channel: UpdateChannel): UpdateChannel;
  };
}

export function registerUpdateIpcHandlers(deps: UpdateIpcDeps): void {
  registerGuardedIpcHandlers(UPDATE_IPC, {
    "volli:update-state-get": () => ({ ok: true as const, state: deps.update.state() }),

    // Fire-and-forget, like `volli:retention-poll`: the outcomes arrive as
    // `volli:update-state` pushes, and `checkNow` already owns its failures
    // (they land in the error state, never as a rejection).
    "volli:update-check": () => {
      void deps.update.checkNow();
      return { ok: true as const };
    },

    /**
     * The confirmed install — the ONE prompt's accept. Order is the whole
     * point: the latch must be up before `quitAndInstall()` starts closing
     * windows (Electron's native updater closes them all, then quits, and
     * `before-quit` comes after the window `close` events — every gate on
     * that path checks the latch). Phase is re-read here, not trusted from
     * the renderer: a stray invoke with nothing staged must not raise a
     * latch that lets the next ordinary ⌘Q bypass every confirm.
     */
    "volli:update-install": () => {
      if (deps.update.state().phase !== "downloaded") {
        return { ok: false as const, error: "No update has been downloaded yet." };
      }
      deps.beginInstall();
      try {
        deps.update.quitAndInstall();
      } catch (error) {
        // The app is staying up after all — lower the latch or the next
        // plain quit runs gateless over live work.
        deps.abandonInstall();
        return { ok: false as const, error: errorMessage(error) };
      }
      return { ok: true as const };
    },

    "volli:update-live-work": async () => ({
      ok: true as const,
      busyCommands: deps.busyCommands(),
      openAgentSessions: await deps.openAgentTurns(),
      unsavedDrafts: [...deps.unsavedDrafts()],
    }),

    "volli:update-channel-get": () =>
      deps.channel === undefined
        ? { ok: false as const, error: "The release channel isn't readable right now." }
        : { ok: true as const, channel: deps.channel.read() },

    /**
     * The write's own doc (`writeUpdateChannel`) carries the effect story:
     * entering canary widens the running updater immediately; leaving canary
     * applies at the next launch on stable installs, and never forces a
     * canary install off the prerelease feed. Nothing here re-runs a check —
     * one fired mid-write would race the row it depends on.
     */
    "volli:update-channel-set": (channel: UpdateChannel) =>
      deps.channel === undefined
        ? { ok: false as const, error: "The release channel isn't writable right now." }
        : { ok: true as const, channel: deps.channel.write(channel) },
  });
}
