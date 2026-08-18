/**
 * The New-ticket composer after VC-56 — the real dialog, over the real board.
 *
 * Four things to look at, and three of them are rows rather than pictures.
 *
 * **The metadata row is one line.** Status / Priority / Labels on the left,
 * `base → destination` on the right. It had been two lines: the terminal-harness
 * chip that used to end the left group was ~110px, which pushed the branch pair
 * past the wrap, and a right-aligned second line reads as a layout accident
 * rather than as the split it was meant to be. The chip is gone with the
 * terminal kickoff it described.
 *
 * **The bottom rail carries the run.** Model and effort — the chat composer's
 * own two pills, imported rather than re-drawn — sit beside the paperclip,
 * because they belong to the ACT of creating rather than to the ticket, and
 * because pressing Create & start lands you in a chat pane showing these exact
 * two controls with these exact two values. Seeded from Model Access's TICKET
 * default: the fake catalog below sets the project default to `haiku-4.5` and
 * the ticket default to `sonnet-4.5`, so the pill naming sonnet is the row
 * proving which purpose it read.
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
import type {
  HiddenModelRef,
  ModelAccessDefaults,
  ModelAccessSnapshot,
  ModelSelection,
  ModelPurpose,
} from "@volli/shared";

import { Board } from "@renderer/components/board/board";
import { NewTicketDialog } from "@renderer/components/board/new-ticket-dialog";
import { Button } from "@renderer/components/ui/button";
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
};

/* ------------------------------------------------------------ model access */

const MODELS: ModelAccessSnapshot["models"] = [
  {
    providerId: "anthropic",
    modelId: "sonnet-4.5",
    label: "sonnet-4.5",
    state: "available",
    reasoningLevels: ["low", "medium", "high"],
    contextWindow: 200_000,
  },
  {
    providerId: "anthropic",
    modelId: "haiku-4.5",
    label: "haiku-4.5",
    state: "available",
    reasoningLevels: ["off", "low", "medium", "high"],
    contextWindow: 200_000,
  },
  {
    providerId: "openai-codex",
    modelId: "gpt-5.6-luna",
    label: "gpt-5.6-luna",
    state: "available",
    // Seven stops: the widest set the effort rail has to hold, and the reason
    // to open the chip on THIS model rather than on the seeded one.
    reasoningLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
    contextWindow: 400_000,
  },
  {
    providerId: "openai-codex",
    modelId: "gpt-5.3-codex-spark",
    label: "gpt-5.3-codex-spark",
    state: "available",
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
 */
const SEEDED_DEFAULTS: ModelAccessDefaults = {
  global: { providerId: "anthropic", modelId: "haiku-4.5", reasoningLevel: "medium" },
  ticket: { providerId: "anthropic", modelId: "sonnet-4.5", reasoningLevel: "high" },
  utility: null,
};

/** A Model Access client with no main process behind it — reads only. */
function labModelAccess(): ModelAccessClient {
  let defaults: ModelAccessDefaults = SEEDED_DEFAULTS;
  let hidden: readonly HiddenModelRef[] = [];
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
    beginSignIn: () => Promise.reject(new Error("Sign-in needs the main process")),
    signOut: () => Promise.reject(new Error("Sign-out needs the main process")),
  };
}

/* ------------------------------------------------------------------ scratch */

export default function TicketKickoffScratch() {
  const client = React.useMemo(labModelAccess, []);
  const [empty, setEmpty] = React.useState(false);

  // The board's own store, emptied and refilled in place: `BoardEmpty` keys off
  // the PROJECT's tickets, not off a filter, so this is the only way to reach it.
  React.useEffect(() => {
    useBoardStore.setState({
      ticketsByProject: { [project.id]: empty ? [] : tickets },
      labelsByProject: { [project.id]: labels },
    });
  }, [empty]);

  return (
    <ModelAccessProvider client={client}>
      <div className="flex h-full flex-col overflow-hidden bg-background p-2">
        <div className="flex shrink-0 items-center gap-2 px-2 pb-2">
          <Button size="sm" onClick={() => useUiStore.getState().setNewTicketOpen(true)}>
            Open composer
          </Button>
          <Button variant="secondary" size="sm" onClick={() => setEmpty((value) => !value)}>
            {empty ? "Fill the board" : "Empty the board"}
          </Button>
          <span className="text-ui text-muted-foreground">⌘↵ creates · ⇧⌘↵ creates and starts</span>
        </div>
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border">
          <Board projectId={project.id} ticketPrefix={project.ticketPrefix} />
        </div>
      </div>
      {/* The real dialog, mounted exactly where the app shell mounts it. */}
      <NewTicketDialog />
    </ModelAccessProvider>
  );
}
