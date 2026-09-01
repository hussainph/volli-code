/**
 * What a Ticket can be made to RUN, as context-menu rows — the one nested menu
 * VC-112 names, drawn once and hosted twice.
 *
 * Two surfaces mount it, and both obey VC-234's universal landing rule: a Run
 * stays in place and toasts with an "Open session" action. Their only
 * difference is whether they can collect Instructions:
 *
 *  - **The ticket rail's split button** right-clicks onto it (VC-129) and
 *    offers **Run once…** because the rail owns that dialog.
 *  - **The board card's context menu** — VC-112's "run one without opening the
 *    Ticket" — hosts it under one `Automations ▸` row and offers no Run once,
 *    because an Unbound Run has to be TYPED and a card has nowhere to type it.
 *
 * Both carry the nested **Run on model ▸**: the per-invocation override on the
 * deliberate surfaces, never on the drag path (VC-112). Model and reasoning
 * travel together, so a model offering several levels opens onto them rather
 * than running at one nobody chose.
 *
 * The rows themselves are one component so the two hosts cannot drift into two
 * answers to "what may this Ticket run" — which is exactly the question an
 * arming row, a Trigger and a machine-local switch already answer between them.
 */
import * as React from "react";
import { CpuIcon } from "@phosphor-icons/react/dist/csr/Cpu";
import { LightningIcon } from "@phosphor-icons/react/dist/csr/Lightning";
import { PlayIcon } from "@phosphor-icons/react/dist/csr/Play";
import { SlidersIcon } from "@phosphor-icons/react/dist/csr/Sliders";
import {
  displayTicketId,
  UNBOUND_RUN_LABEL,
  type Automation,
  type ModelSelection,
  type Ticket,
  type TicketStatus,
} from "@volli/shared";

import { SWITCHED_OFF_NOTE } from "./automations-page-model";
import { runAutomationOnTicket } from "./run-automation";
import {
  modelOverrideRows,
  overridePressable,
  RAIL_UNREAD_LABEL,
  ticketRailAutomations,
  type RailRunAction,
  type TicketRailAutomations,
} from "./ticket-rail-automations-model";
import { offerableModels, type ComposerModel } from "@renderer/components/chat/composer-ui";
import {
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@renderer/components/ui/context-menu";
import { EMPTY_INLINE } from "@renderer/components/ui/empty-classes";
import { useProjectsStore } from "@renderer/stores/projects";
import {
  selectArmings,
  selectColumnRank,
  selectAutomations,
  selectPlanningLoaded,
  useAutomationsStore,
} from "@renderer/stores/automations";
import { useBoardStore } from "@renderer/stores/board";
import { useModelAccessClient } from "@renderer/lib/model-access-client";

const NO_MODELS: readonly ComposerModel[] = [];

/**
 * The catalog a per-invocation override may name — signed-in, unhidden models,
 * read once per mount.
 *
 * The same read the Automation editor's pin control makes, for the same
 * catalog. An unreadable catalog costs the OVERRIDE and never the Run: with no
 * models the override menu has nothing to offer and every Run resolves its
 * Runtime the ordinary way, which is what it would have done anyway.
 */
export function useOfferableModels(): readonly ComposerModel[] {
  const access = useModelAccessClient();
  const inspect = access?.inspect;
  const hiddenModels = access?.hiddenModels;
  const [models, setModels] = React.useState<readonly ComposerModel[]>(NO_MODELS);
  React.useEffect(() => {
    if (inspect === undefined || hiddenModels === undefined) return;
    let current = true;
    void Promise.all([inspect({}), hiddenModels()])
      .then(([snapshot, hidden]) => {
        if (!current) return;
        setModels(offerableModels(snapshot.models, snapshot.providers, hidden));
      })
      .catch(() => {
        if (!current) return;
        setModels(NO_MODELS);
      });
    return () => {
      current = false;
    };
  }, [inspect, hiddenModels]);
  return models;
}

/**
 * This column's run offer, read on arrival and INERT until that read lands.
 *
 * Read on arrival and after any planning change, the way the Automations page
 * reads: opening a Ticket — or opening a card's menu — IS the moment a stale
 * Offered list or a stale arming would show, and neither surface may depend on
 * some other one having noticed a record created, armed or switched elsewhere.
 * Deliberately NOT `ensureLoaded`, which only fills a cache that has never
 * landed: that is the board arrival's rule, and it would leave this menu naming
 * an Automation disarmed an hour ago in another window.
 *
 * Until the read lands the answer is `ready: false` rather than a guess. An
 * empty cache and an unarmed column are one value (VC-112), so a rail rendered
 * from a cold one would offer a clickable Run once on a Ticket whose column IS
 * armed, and one rendered from a stale one would press the Automation that
 * column USED to arm. This is the same refusal to decide from an unwarmed cache
 * `armed-run.ts` makes for an arrival; what differs is only what each does
 * about it — the drop waits, the button says it is reading.
 *
 * "Landed" means EVERY one of the three reads succeeded, not merely that they
 * all settled. A failed read toasts and leaves its slice as it found it, which
 * on a cold cache is empty — but on a warm one is the very stale value this
 * rail must not press. So the answer stays unread unless all three came back
 * ok: a press whose backing read failed runs nothing, exactly as a press that
 * arrived before the read runs nothing.
 */
export function useAutomationRunOffer(
  projectId: string,
  status: TicketStatus,
): TicketRailAutomations {
  const automations = useAutomationsStore((state) => selectAutomations(state, projectId));
  const armings = useAutomationsStore((state) => selectArmings(state, projectId));
  const rankedAutomationIds = useAutomationsStore((state) =>
    selectColumnRank(state, projectId, status),
  );
  const landed = useAutomationsStore((state) => selectPlanningLoaded(state, projectId));
  const refresh = useAutomationsStore((state) => state.refresh);
  const refreshArming = useAutomationsStore((state) => state.refreshArming);
  const refreshEnablement = useAutomationsStore((state) => state.refreshEnablement);
  const planningVersion = useBoardStore((state) => state.lastPlanningChange.version);
  const [read, setRead] = React.useState(false);

  React.useEffect(() => {
    let current = true;
    // Every arrival re-opens the question, including one caused by a planning
    // change: what is on screen now was decided from what the cache held then.
    setRead(false);
    void Promise.all([refresh(projectId), refreshArming(projectId), refreshEnablement()]).then(
      (landings) => {
        // Every one of them, not just all of them SETTLING. A refresh that
        // failed toasted and returned false, leaving its slice holding whatever
        // was there before — on a warm cache, the stale arming a press would
        // otherwise spend. One failure keeps the whole rail unread.
        if (current && landings.every(Boolean)) setRead(true);
      },
    );
    return () => {
      current = false;
    };
  }, [refresh, refreshArming, refreshEnablement, projectId, planningVersion]);

  // `landed` adds the cold-cache half of the same rule: a slice that has never
  // been filled is not something to classify from either. The control keeps
  // saying it is reading rather than claiming this project has no Automations.
  return ticketRailAutomations({
    automations,
    armings,
    status,
    rankedAutomationIds,
    ready: read && landed,
  });
}

/**
 * The nested rows themselves: this column's Offered list, optionally Run once…,
 * and the per-invocation override.
 *
 * `onRunOnce` is omitted by hosts that have no dialog to open. That is not a
 * quieter version of the same menu — an Unbound Run is typed, and a surface
 * that cannot take the typing must not pretend to offer one.
 */
export function AutomationRunMenuItems({
  rail,
  enabledIds,
  models,
  onRun,
  onRunOnce,
}: {
  rail: TicketRailAutomations;
  enabledIds: readonly string[];
  models: readonly ComposerModel[];
  onRun(action: RailRunAction, modelOverride: ModelSelection | null): void;
  onRunOnce?: (() => void) | undefined;
}) {
  const overrides = modelOverrideRows(models);
  // An unread rail offers no record, because it knows of none: what it knows is
  // that it has not looked yet, and it says so instead of listing a guess.
  if (!rail.ready) {
    return (
      <>
        <div className={EMPTY_INLINE}>{RAIL_UNREAD_LABEL}</div>
        {onRunOnce === undefined ? null : (
          <ContextMenuItem icon={PlayIcon} onSelect={onRunOnce}>
            {UNBOUND_RUN_LABEL}…
          </ContextMenuItem>
        )}
      </>
    );
  }
  return (
    <>
      {rail.offered.map((automation) => (
        <ContextMenuItem
          key={automation.id}
          icon={LightningIcon}
          onSelect={() => onRun({ kind: "automation", automation }, null)}
        >
          <span className="min-w-0 flex-1 truncate">{automation.name}</span>
          <OffNote automation={automation} enabledIds={enabledIds} />
        </ContextMenuItem>
      ))}
      {rail.offered.length === 0 && onRunOnce === undefined ? (
        // Nothing offered and nothing to type: say which of the two it is
        // rather than leaving an empty popover (the Labels submenu's own idiom).
        <div className={EMPTY_INLINE}>No automations offered in this column</div>
      ) : null}
      {rail.offered.length > 0 && onRunOnce !== undefined ? <ContextMenuSeparator /> : null}
      {onRunOnce === undefined ? null : (
        <ContextMenuItem icon={PlayIcon} onSelect={onRunOnce}>
          {UNBOUND_RUN_LABEL}…
        </ContextMenuItem>
      )}
      {/* The nested override item VC-112 names. It spends the pick on THIS
          menu's default press — the column's Armed automation, or the Run once
          form, which opens already holding it.

          Two things can remove the row, and they are not the same: a profile
          whose catalog offers no model a Run could name, and a default press
          this host does not have (`overridePressable`). Either way there is no
          Run for a model to be chosen FOR, and an item opening onto nothing
          would be worse than one that is not there. */}
      {overrides.length === 0 ||
      !overridePressable(rail.primary, onRunOnce !== undefined) ? null : (
        <ContextMenuSub>
          <ContextMenuSubTrigger icon={CpuIcon}>Run on model</ContextMenuSubTrigger>
          <ContextMenuSubContent>
            {overrides.map(({ model, selections }) =>
              selections.length === 1 ? (
                <ContextMenuItem
                  key={model.id}
                  icon={CpuIcon}
                  onSelect={() => onRun(rail.primary, selections[0] ?? null)}
                >
                  {model.label}
                </ContextMenuItem>
              ) : (
                <ContextMenuSub key={model.id}>
                  <ContextMenuSubTrigger icon={CpuIcon}>{model.label}</ContextMenuSubTrigger>
                  <ContextMenuSubContent>
                    {selections.map((selection) => (
                      <ContextMenuItem
                        key={selection.reasoningLevel}
                        icon={SlidersIcon}
                        onSelect={() => onRun(rail.primary, selection)}
                      >
                        {selection.reasoningLevel}
                      </ContextMenuItem>
                    ))}
                  </ContextMenuSubContent>
                </ContextMenuSub>
              ),
            )}
          </ContextMenuSubContent>
        </ContextMenuSub>
      )}
    </>
  );
}

/**
 * What a switched-off Automation says where it is OFFERED — the page's own
 * words, so one record does not read as two states on two surfaces. It is still
 * offered and still runs: the switch decides what starts it BESIDES a person
 * (VC-112).
 */
export function OffNote({
  automation,
  enabledIds,
}: {
  automation: Automation;
  enabledIds: readonly string[];
}) {
  if (enabledIds.includes(automation.id)) return null;
  return (
    <span className="ml-auto shrink-0 text-label text-muted-foreground">{SWITCHED_OFF_NOTE}</span>
  );
}

/**
 * The board card's own `Automations ▸` submenu (VC-112: "run one without
 * opening the Ticket"), including the nested per-invocation override.
 *
 * It never navigates. VC-234 makes the same success toast and "Open session"
 * action universal across the board, rail, page, and palette; this menu reaches
 * that one `runAutomationOnTicket` landing.
 *
 * Its own component because it reads three project-wide slices and the whole
 * board holds one menu per card: mounted inside the submenu's content, those
 * subscriptions and that read exist only while the submenu is open.
 */
export function TicketAutomationMenuItems({
  ticket,
  projectId,
}: {
  ticket: Ticket;
  projectId: string;
}) {
  const rail = useAutomationRunOffer(projectId, ticket.status);
  const models = useOfferableModels();
  const enabledIds = useAutomationsStore((state) => state.enabledIds);
  const prefix = useProjectsStore(
    (state) => state.projects.find((project) => project.id === projectId)?.ticketPrefix,
  );

  const run = (action: RailRunAction, modelOverride: ModelSelection | null): void => {
    // Only a record can be run from here. `run-once` and `unread` are states
    // this menu never offers a press for, so they cannot arrive.
    if (action.kind !== "automation") return;
    void runAutomationOnTicket({
      target: { kind: "automation", automationId: action.automation.id },
      automationName: action.automation.name,
      ticketId: ticket.id,
      ticketDisplayId:
        prefix === undefined ? "this ticket" : displayTicketId(prefix, ticket.ticketNumber),
      modelOverride,
    });
  };

  return <AutomationRunMenuItems rail={rail} enabledIds={enabledIds} models={models} onRun={run} />;
}
