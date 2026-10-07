/**
 * What a Ticket can be made to RUN, as context-menu rows — the one nested menu
 * VC-112 names, drawn once and hosted twice.
 *
 * Two surfaces mount it, and both obey VC-234's universal landing rule: a Run
 * stays in place and toasts with an "Open session" action:
 *
 *  - **The ticket rail's Automations rows** right-click onto it (VC-129).
 *  - **The board card's context menu** — VC-112's "run one without opening the
 *    Ticket" — hosts it under one `Automations ▸` row.
 *
 * Neither offers Run once any more (VC-406). The rail was its only host, and
 * stripped to what it did it minted a chat Session with a typed first
 * message, in the background, wearing the bolt — `+ Chat ▾` with a worse text
 * box. Only SAVED records are run from here; a one-off is a chat and typing.
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
import { SlidersIcon } from "@phosphor-icons/react/dist/csr/Sliders";
import {
  displayTicketId,
  type Automation,
  type ModelSelection,
  type Ticket,
  type TicketStatus,
} from "@volli/shared";

import { SWITCHED_OFF_NOTE } from "./automations-page-model";
import { guardWrite, useCanWrite } from "@renderer/components/hosts/use-hosts";
import { ModelName } from "@renderer/components/models/model-identity";
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
  railReadFeedback,
  type RailReadFeedback,
  type RailReadState,
} from "@renderer/components/ticket/rail-read-feedback";
import {
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@renderer/components/ui/context-menu";
import { EMPTY_INLINE } from "@renderer/components/ui/empty-classes";
import { useProjectsStore } from "@renderer/stores/projects";
import {
  selectArmings,
  selectColumnOrders,
  selectAutomations,
  selectPlanningLoaded,
  selectRailFresh,
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
 *
 * WHAT AN ARRIVAL COSTS (VC-373): nothing, when the four caches already
 * answer for the planning version the app is on. A ticket switch inside one
 * project used to re-read all four — `refreshEnablement` is machine-global, and
 * `refresh`/`refreshArming`/`refreshOrder` are this project's, so none of them
 * can have moved just because another ticket came to the front. `refreshRail`
 * reads only what the planning clock has moved past; a version everything
 * already carries paints the rail as ready from the first frame, with no
 * unread flash and no IPC.
 *
 * Until a fresh read lands the answer is `ready: false` rather than a guess.
 * An empty cache and an unarmed column are one value (VC-112), so a rail
 * rendered from a cold one would offer a clickable Run once on a Ticket whose
 * column IS armed, and one rendered from a stale one would press the
 * Automation that column USED to arm. This is the same refusal to decide from
 * an unwarmed cache `armed-run.ts` makes for an arrival; what differs is only
 * what each does about it — the drop waits, the button says it is reading.
 *
 * "Landed" means every one of the four reads succeeded, not merely that they
 * all settled. A failed read toasts and leaves its slice as it found it, which
 * on a cold cache is empty — but on a warm one is the very stale value this
 * rail must not press. So the answer stays unread unless all four came back
 * ok: a press whose backing read failed runs nothing, exactly as a press that
 * arrived before the read runs nothing.
 *
 * This is the unchanged, launch-safe answer: `ready` is a coherent fresh
 * snapshot or nothing. A surface that also wants to SHOW what it last read
 * while a re-read is out asks {@link useAutomationRunOfferRead} for the same
 * answer plus the read's own state.
 */
export function useAutomationRunOffer(
  projectId: string,
  status: TicketStatus,
): TicketRailAutomations {
  return useAutomationRunOfferRead(projectId, status).offer;
}

/**
 * The same read, with what the block needs to SAY about it (VC-406).
 *
 * `offer` is unchanged and still the only thing anything may launch from.
 * What is added is the part a surface with rows on screen cannot do without:
 * the last COHERENT offer, so a refresh does not blank rows that were true a
 * second ago, and the three bits `rail-read-feedback.ts` decides the wording
 * from. A failed first read used to leave `ready: false` forever with no way
 * back but a planning change; `retry` is that way back, local to the block.
 *
 * RETAINED IS A SNAPSHOT, NOT A RE-READ OF THE SLICES. A refresh that failed
 * halfway leaves the store holding a new list beside an old arming set, and
 * recomposing from that would draw a combination no read ever returned — the
 * exact stale-armed press the rail refuses. So the retained value is the whole
 * `TicketRailAutomations` captured when a read last landed, kept only for the
 * project and column it was read for.
 */
export interface AutomationRunOfferRead {
  /** Coherent and fresh, or unread. The only value a launch may name. */
  offer: TicketRailAutomations;
  /** The last coherent offer for this project and column, or `null`. */
  retained: TicketRailAutomations | null;
  read: RailReadState;
  feedback: RailReadFeedback;
  /** Re-runs this block's own read. Local to the block, never app-wide. */
  retry(): void;
}

/** What the read is doing, and which project+column it is doing it for. */
interface ReadScope {
  key: string;
  phase: "reading" | "ready" | "failed";
}

export function useAutomationRunOfferRead(
  projectId: string,
  status: TicketStatus,
): AutomationRunOfferRead {
  const automations = useAutomationsStore((state) => selectAutomations(state, projectId));
  const armings = useAutomationsStore((state) => selectArmings(state, projectId));
  // Every column's rank at once (VC-329 item 5): the cross-column groups are
  // each ordered the way their own lane arranges, so the menu reads the whole
  // order table rather than one column's slice of it.
  const orders = useAutomationsStore((state) => selectColumnOrders(state, projectId));
  const landed = useAutomationsStore((state) => selectPlanningLoaded(state, projectId));
  const refreshRail = useAutomationsStore((state) => state.refreshRail);
  const planningVersion = useBoardStore((state) => state.lastPlanningChange.version);
  const railFresh = useAutomationsStore((state) =>
    selectRailFresh(state, projectId, planningVersion),
  );
  const [attempt, setAttempt] = React.useState(0);
  // Initialized from the cache, not from false: a warm rail paints as ready in
  // its FIRST frame — otherwise an arrival that spends nothing would still
  // flash the unread label for the render before its effect ran.
  const scopeKey = `${projectId}\u0000${status}`;
  const [scope, setScope] = React.useState<ReadScope>(() => ({
    key: scopeKey,
    phase: railFresh ? "ready" : "reading",
  }));
  // A project or column switch is a different question, answered from this
  // render rather than from the effect that follows it: the frame between the
  // two is exactly where the previous project's ready would have licensed a
  // press, and where its rows would have been retained under the new heading.
  const current: ReadScope =
    scope.key === scopeKey ? scope : { key: scopeKey, phase: railFresh ? "ready" : "reading" };
  if (scope.key !== scopeKey) setScope(current);

  React.useEffect(() => {
    let live = true;
    if (railFresh) {
      setScope({ key: scopeKey, phase: "ready" });
      return;
    }
    // Every arrival that does need a read re-opens the question, including one
    // caused by a planning change: what is on screen now was decided from what
    // the cache held then.
    setScope({ key: scopeKey, phase: "reading" });
    void refreshRail(projectId, planningVersion).then((landedNow) => {
      // Every one of them, not just all of them SETTLING. A refresh that
      // failed toasted and returned false, leaving its slice holding whatever
      // was there before — on a warm cache, the stale arming a press would
      // otherwise spend. One failure keeps the whole rail unread, and now says
      // so rather than waiting forever for a planning change.
      if (live) setScope({ key: scopeKey, phase: landedNow ? "ready" : "failed" });
    });
    return () => {
      live = false;
    };
  }, [scopeKey, railFresh, refreshRail, projectId, planningVersion, attempt]);

  // `landed` adds the cold-cache half of the same rule: a slice that has never
  // been filled is not something to classify from either. The control keeps
  // saying it is reading rather than claiming this project has no Automations.
  const offer = ticketRailAutomations({
    automations,
    armings,
    status,
    orders,
    rankedAutomationIds: orders.find((order) => order.status === status)?.rankedAutomationIds,
    ready: current.phase === "ready" && landed,
  });

  const held = React.useRef<{ key: string; offer: TicketRailAutomations } | null>(null);
  if (offer.ready) held.current = { key: scopeKey, offer };
  else if (held.current !== null && held.current.key !== scopeKey) held.current = null;
  const retained = offer.ready ? null : (held.current?.offer ?? null);

  const read: RailReadState = {
    hasData: offer.ready || retained !== null,
    pending: current.phase === "reading",
    failed: current.phase === "failed",
  };
  return {
    offer,
    retained,
    read,
    feedback: railReadFeedback(read, "Automations"),
    retry: () => setAttempt((count) => count + 1),
  };
}

/**
 * The nested rows themselves: every column's Offered list, and the
 * per-invocation override.
 */
export function AutomationRunMenuItems({
  rail,
  enabledIds,
  models,
  canWrite = true,
  onRun,
}: {
  rail: TicketRailAutomations;
  enabledIds: readonly string[];
  models: readonly ComposerModel[];
  /** Read-only (VC-576): a Run is a write to the project's host; every row stands down. */
  canWrite?: boolean;
  onRun(action: RailRunAction, modelOverride: ModelSelection | null): void;
}) {
  const overrides = modelOverrideRows(models);
  // An unread rail offers no record, because it knows of none: what it knows is
  // that it has not looked yet, and it says so instead of listing a guess.
  if (!rail.ready) {
    return <div className={EMPTY_INLINE}>{RAIL_UNREAD_LABEL}</div>;
  }
  return (
    <>
      {/* The whole cross-column answer (VC-329 item 5), grouped and labelled by
          column — the Ticket's own column first, the rest in board order. A row
          under another column's heading runs that Automation on THIS Ticket by
          hand, through the same `runAutomationOnTicket` the current column's
          rows always reached: no move, no arming, no different landing. */}
      {rail.groups.map((group) => (
        <React.Fragment key={group.status}>
          <ContextMenuLabel className="text-label text-muted-foreground">
            {group.label}
            {group.current ? " · this ticket" : ""}
          </ContextMenuLabel>
          {group.automations.map((automation) => (
            <ContextMenuItem
              key={automation.id}
              icon={LightningIcon}
              disabled={!canWrite}
              onSelect={() => onRun({ kind: "automation", automation }, null)}
            >
              <span className="min-w-0 flex-1 truncate">{automation.name}</span>
              <OffNote automation={automation} enabledIds={enabledIds} />
            </ContextMenuItem>
          ))}
        </React.Fragment>
      ))}
      {rail.offered.length === 0 ? (
        // Nothing offered: say so rather than leaving an empty popover (the
        // Labels submenu's own idiom).
        <div className={EMPTY_INLINE}>No automations offered in this column</div>
      ) : null}
      {/* The nested override item VC-112 names. It spends the pick on THIS
          menu's default press — the column's Armed automation.

          Two things can remove the row, and they are not the same: a profile
          whose catalog offers no model a Run could name, and a column that
          arms nothing (`overridePressable`). Either way there is no Run for a
          model to be chosen FOR, and an item opening onto nothing would be
          worse than one that is not there. */}
      {overrides.length === 0 || !overridePressable(rail.primary) ? null : (
        <ContextMenuSub>
          <ContextMenuSubTrigger icon={CpuIcon} disabled={!canWrite}>
            Run on model
          </ContextMenuSubTrigger>
          <ContextMenuSubContent>
            {overrides.map(({ model, selections }) =>
              selections.length === 1 ? (
                <ContextMenuItem
                  key={model.id}
                  icon={CpuIcon}
                  onSelect={() => onRun(rail.primary, selections[0] ?? null)}
                >
                  <ModelName model={model} models={models} providerLabel={model.providerLabel} />
                </ContextMenuItem>
              ) : (
                <ContextMenuSub key={model.id}>
                  <ContextMenuSubTrigger icon={CpuIcon}>
                    <ModelName model={model} models={models} providerLabel={model.providerLabel} />
                  </ContextMenuSubTrigger>
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
 * Its own component because it reads the project-wide planning slices and the whole
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

  const canWrite = useCanWrite(projectId);

  const run = (action: RailRunAction, modelOverride: ModelSelection | null): void => {
    // Only a record can be run from here. `run-once` and `unread` are states
    // this menu never offers a press for, so they cannot arrive.
    if (action.kind !== "automation") return;
    // A menu opened before the host went away cannot run through it.
    if (!guardWrite(projectId)) return;
    void runAutomationOnTicket({
      target: { kind: "automation", automationId: action.automation.id },
      automationName: action.automation.name,
      ticketId: ticket.id,
      ticketDisplayId:
        prefix === undefined ? "this ticket" : displayTicketId(prefix, ticket.ticketNumber),
      modelOverride,
    });
  };

  return (
    <AutomationRunMenuItems
      rail={rail}
      enabledIds={enabledIds}
      models={models}
      canWrite={canWrite}
      onRun={run}
    />
  );
}
