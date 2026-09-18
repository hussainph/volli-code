/**
 * The New-ticket composer after VC-56 — the real dialog, over the real board.
 *
 * Five things to look at, and four of them are rows rather than pictures.
 *
 * **The metadata row is one line.** Status / Priority / Labels on the left,
 * `base → destination` on the right. It had been two lines: the terminal-harness
 * chip that used to end the left group was ~110px, which pushed the branch pair
 * past the wrap, and a right-aligned second line reads as a layout accident
 * rather than as the split it was meant to be. The chip is gone with the
 * terminal kickoff it described.
 *
 * **The bottom rail carries the run.** Model and effort — the chat composer's
 * own controls, imported rather than re-drawn — sit beside the paperclip,
 * because they belong to the ACT of creating rather than to the ticket, and
 * because pressing Create & start lands you in a chat pane showing these exact
 * two values. Seeded from Model Access's TICKET default: the fake catalog below
 * sets the Board default to `haiku-4.5` and the ticket default to
 * `sonnet-4.5`, so the pill naming sonnet is the row proving which purpose it
 * read. At the dialog's own width they are ONE control naming both values, and
 * Expand is what parts them — this tray's three commits leave no room for a
 * second chip at 36rem (VC-382), so the fold is worth watching both ways.
 *
 * **Attach something.** `+` → Attach files…, any file: the strip lands in a band
 * of its own between the chips and the tray, and it pays the same air above the
 * tiles as below them. It used to pay none below, which sat 64px thumbnails on
 * the tray's hairline beside the buttons.
 *
 * **The two commits explain themselves on hover.** Rest on Create, then on
 * Create & start — one clause each, naming what it does and its chord. Hover
 * them BEFORE typing a title too: both are disabled then, which is exactly when
 * a first-timer is reading the footer, and the labels still appear.
 *
 * **Expand, then collapse.** The button at the top right. Collapsing used to
 * leave the composer stuck at the wide width and spilling out of its own panel
 * until the next open — the dialog is a grid item whose automatic minimum size
 * was Monaco's own pixel width, so the editor could not re-measure because the
 * host could not shrink, and the host could not shrink because the editor was
 * holding it open. Type a paragraph first so the wrap has something to show.
 *
 * The board behind it is the real one, and the toggle empties it: an empty
 * board offers one line and one button rather than five collapsed column pills
 * (VC-42 audit F6).
 *
 * WHAT THE LAB CANNOT SHOW: the press itself. Create & start mints a durable
 * Session over the Session RPC edge, which needs the main process — here it
 * fails into the app's real error path. Judge the surface; confirm the kickoff
 * in the app.
 */
import * as React from "react";
import {
  DEFAULT_COMPACTION_POLICY,
  DEFAULT_MODEL_PICKER_VIEW,
  EMPTY_MODEL_ACCESS_DEFAULTS,
} from "@volli/shared";
import type {
  HiddenModelRef,
  ModelAccessDefaults,
  ModelAccessSnapshot,
  ModelPickerView,
  ModelSelection,
  ModelPurpose,
} from "@volli/shared";

import { Board } from "@renderer/components/board/board";
import { NewTicketDialog } from "@renderer/components/board/new-ticket-dialog";
import { Button } from "@renderer/components/ui/button";
import { TooltipProvider } from "@renderer/components/ui/tooltip";
import { ModelAccessProvider, type ModelAccessClient } from "@renderer/lib/model-access-client";
import { useBoardStore } from "@renderer/stores/board";
import { useUiStore } from "@renderer/stores/ui";

import { labels, project, tickets } from "../fixtures";
import { appApi, seedApp } from "../seed";

export const title = "New-ticket composer · Create & start";
export const note = "Model + effort in the rail, one metadata line, expand/collapse, empty board";
export const viewport = "window" as const;

export const seed = seedApp;

/**
 * The branch listing the base chip reads, on top of the app-level stubs.
 *
 * Left failing it would say "unknown", which is an honest state but not the one
 * this scratch is about — the row's width, and whether the pair still sits
 * beside the metadata chips, is the thing being judged.
 */
export const api = {
  ...appApi,
  worktree: {
    branches: () =>
      Promise.resolve({
        ok: true,
        branches: ["main", "develop", "release/0.2"],
        current: "main",
        remotes: ["origin/main", "origin/develop"],
        fetchedAt: Date.now() - 90 * 60_000,
      }),
  },
  /**
   * Files staged on a Ticket that does not exist yet (VC-50), so the strip
   * between the chips and the tray can be looked at here — `+` → Attach files…
   * and pick anything. Without this the lab's unstubbed door refuses and the
   * one band whose spacing this scratch is meant to judge never draws (VC-382).
   *
   * No bytes are stored: the hash is derived from the name, and the tile it
   * addresses over `volli-blob:` resolves only in Electron — an image tile
   * draws as an empty square of the right size here, exactly as the composer
   * states rig's own fixtures do.
   */
  attachments: {
    pathForFile: (file: File) => `/lab/${file.name}`,
    attach: (input: { fileName: string; mime?: string }) =>
      Promise.resolve({
        ok: true,
        relPath: null,
        blob: {
          linkId: null,
          blobHash: [...input.fileName]
            .map((character) => (character.codePointAt(0) ?? 0).toString(16).padStart(2, "0"))
            .join("")
            .padEnd(64, "0")
            .slice(0, 64),
          label: input.fileName,
          originalName: input.fileName,
          mime: input.mime ?? "application/octet-stream",
          sizeBytes: 182_000,
        },
      }),
    remove: () => Promise.resolve({ ok: true }),
  },
};

/* ------------------------------------------------------------ model access */

const MODELS: ModelAccessSnapshot["models"] = [
  {
    providerId: "anthropic",
    modelId: "sonnet-4.5",
    label: "Claude Sonnet 4.5",
    state: "available",
    acceptsImageInput: true,
    reasoningLevels: ["low", "medium", "high"],
    contextWindow: 200_000,
  },
  {
    providerId: "anthropic",
    modelId: "haiku-4.5",
    label: "Claude Haiku 4.5",
    state: "available",
    acceptsImageInput: true,
    reasoningLevels: ["off", "low", "medium", "high"],
    contextWindow: 200_000,
  },
  {
    providerId: "openai-codex",
    modelId: "gpt-5.6-luna",
    label: "GPT-5.6 Luna",
    state: "available",
    acceptsImageInput: true,
    // Seven stops: the widest set the effort rail has to hold, and the reason
    // to open the chip on THIS model rather than on the seeded one.
    reasoningLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
    contextWindow: 400_000,
  },
  {
    providerId: "openai-codex",
    modelId: "gpt-5.3-codex-spark",
    label: "GPT-5.3 Codex Spark",
    state: "available",
    acceptsImageInput: true,
    reasoningLevels: ["low", "medium", "high"],
  },
];

const PROVIDERS: ModelAccessSnapshot["providers"] = [
  {
    id: "anthropic",
    label: "Anthropic",
    state: "available",
    accountLabel: "demo@voltaic.dev",
    billingSource: "subscription",
    recovery: null,
    hasStoredCredential: true,
    signIn: [],
  },
  {
    id: "openai-codex",
    label: "OpenAI Codex",
    state: "available",
    accountLabel: "demo@voltaic.dev",
    billingSource: "subscription",
    recovery: null,
    hasStoredCredential: true,
    signIn: [],
  },
];

/**
 * Two DIFFERENT defaults, which is the whole point of the pair.
 *
 * `ticket` is what the composer must read (VC-53's purposes); seeding both with
 * one model would look correct whichever it read.
 *
 * The advanced rows (VC-259) are seeded so the pill's Defaults view has a
 * table to show: Fast on its own model, Deep on one with seven stops, and
 * Visual left unset so one row reads through the Ticket fallback.
 */
const SEEDED_DEFAULTS: ModelAccessDefaults = {
  ...EMPTY_MODEL_ACCESS_DEFAULTS,
  global: { providerId: "anthropic", modelId: "haiku-4.5", reasoningLevel: "medium" },
  ticket: { providerId: "anthropic", modelId: "sonnet-4.5", reasoningLevel: "high" },
  fast: { providerId: "anthropic", modelId: "haiku-4.5", reasoningLevel: "low" },
  deep: { providerId: "openai-codex", modelId: "gpt-5.6-luna", reasoningLevel: "xhigh" },
};

/** A Model Access client with no main process behind it — reads only. */
function labModelAccess(): ModelAccessClient {
  let defaults: ModelAccessDefaults = SEEDED_DEFAULTS;
  let hidden: readonly HiddenModelRef[] = [];
  let pickerView: ModelPickerView = DEFAULT_MODEL_PICKER_VIEW;
  return {
    inspect: () =>
      Promise.resolve({ observedAt: Date.now(), providers: PROVIDERS, models: MODELS }),
    defaults: () => Promise.resolve(defaults),
    setDefault: (purpose: ModelPurpose, selection: ModelSelection | null) => {
      defaults = { ...defaults, [purpose]: selection };
      return Promise.resolve(defaults);
    },
    hiddenModels: () => Promise.resolve(hidden),
    setHiddenModels: (next) => {
      hidden = next;
      return Promise.resolve(hidden);
    },
    compactionPolicy: () => Promise.resolve(DEFAULT_COMPACTION_POLICY),
    setCompactionPolicy: (policy) => Promise.resolve(policy),
    pickerView: () => Promise.resolve(pickerView),
    setPickerView: (view) => {
      pickerView = view;
      return Promise.resolve(view);
    },
    beginSignIn: () => Promise.reject(new Error("Sign-in needs the main process")),
    signOut: () => Promise.reject(new Error("Sign-out needs the main process")),
  };
}

/* ------------------------------------------------------------------ scratch */

export default function TicketKickoffScratch({
  initialTickets = tickets,
}: { initialTickets?: typeof tickets } = {}) {
  const client = React.useMemo(labModelAccess, []);
  const [empty, setEmpty] = React.useState(false);

  // The board's own store, emptied and refilled in place: `BoardEmpty` keys off
  // the PROJECT's tickets, not off a filter, so this is the only way to reach it.
  React.useEffect(() => {
    useBoardStore.setState({
      ticketsByProject: { [project.id]: empty ? [] : initialTickets },
      labelsByProject: { [project.id]: labels },
    });
  }, [empty, initialTickets]);

  return (
    // The app shell mounts one `TooltipProvider` at its root; a scratch that
    // borrows the real board and dialog has to mount its own (VC-56's lesson,
    // and what `lab-boot-check.mjs` exists to catch).
    <TooltipProvider>
      <ModelAccessProvider client={client}>
        <div className="flex h-full flex-col overflow-hidden bg-background p-2">
          <div className="flex shrink-0 items-center gap-2 px-2 pb-2">
            <Button size="sm" onClick={() => useUiStore.getState().setNewTicketOpen(true)}>
              Open composer
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setEmpty((value) => !value)}>
              {empty ? "Fill the board" : "Empty the board"}
            </Button>
            <span className="text-ui text-muted-foreground">
              ⌘↵ creates · ⇧⌘↵ runs the selected action
            </span>
          </div>
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border">
            <Board projectId={project.id} ticketPrefix={project.ticketPrefix} />
          </div>
        </div>
        {/* The real dialog, mounted exactly where the app shell mounts it. */}
        <NewTicketDialog />
      </ModelAccessProvider>
    </TooltipProvider>
  );
}
