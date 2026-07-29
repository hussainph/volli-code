import { HARNESS_LABELS } from "../ticket";
import { PLUGIN_LOAD_NATIVE } from "./plugin";
import type { HarnessAdapter } from "./types";

/**
 * `OPENCODE_CONFIG` layers over the user's configuration — the user's
 * providers and auth load first — so a config naming an absolute plugin path
 * loads that plugin with zero writes under `~/.config/opencode`.
 *
 * The documented `permission.ask` blocking hook does not fire; the generic
 * `event` hook observes `permission.asked` instead, and the published SDK
 * types are stale relative to the binary (`permission.updated` in the `.d.ts`),
 * so the native names here come from a live event dump, not from the types.
 *
 * `sessionID` rides on nearly every event, which is why no id is minted at
 * launch. Never set `--pure` / `OPENCODE_PURE=1` or
 * `OPENCODE_DISABLE_DEFAULT_PLUGINS=1` — they disable plugins outright.
 *
 * The startup signal is the plugin LOADING, not anything in the stream, and
 * that is measured rather than chosen: on 1.17.18 a TUI left alone after launch
 * emits `catalog.updated`, `reference.updated`, `integration.updated` and
 * nothing session-shaped at all, because opencode creates no session until the
 * user submits a prompt. (`opencode run` does emit `session.created` 100ms in,
 * but Volli launches the TUI.) The factory call is the one thing that happens at
 * boot, and it happens first — see {@link PLUGIN_LOAD_NATIVE}.
 */
export const opencodeAdapter: HarnessAdapter = {
  id: "opencode",
  label: HARNESS_LABELS.opencode,
  command: "opencode",
  promptFlag: "--prompt",
  surfaces: {
    skillsDir: null,
    commandsDir: "{home}/.config/opencode/command",
    instructionsFile: null,
  },
  injection: { kind: "opencode-plugin", envVar: "OPENCODE_CONFIG", filename: "opencode.json" },
  sessionId: { kind: "reported" },
  resume: {
    byId: ["--session", "{id}"],
    latest: ["--continue"],
    userResumeTokens: ["--session", "-s", "--continue", "-c"],
  },
  events: [
    { event: "session.started", native: PLUGIN_LOAD_NATIVE, delivery: "async" },
    { event: "turn.started", native: "message.updated", delivery: "async" },
    { event: "turn.completed", native: "session.idle", delivery: "async" },
    { event: "input.needed", native: "permission.asked", delivery: "async" },
    {
      event: "permission.requested",
      native: "permission.asked",
      delivery: "async",
    },
  ],
  startupEvent: "session.started",
  launchSettings: [],
  // Empty until a marker is observed on a real opencode session — a guessed name
  // is a variable deleted from the user's environment for no reason.
  sessionMarkers: [],
};
