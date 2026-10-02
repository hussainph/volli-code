/**
 * What is left of every subscription, from anywhere in the app (VC-350).
 *
 * These bars used to live under the provider rows in Settings → Model Access,
 * which is the one place a person is never standing when the question occurs
 * to them. The question — "can I start this run, or am I about to hit a wall?"
 * — arrives mid-work, so the answer moved into the chrome band beside ⌘K,
 * where every page in the app can reach it without leaving the page.
 *
 * AN ACCORDION, BECAUSE THE ALTERNATIVE IS A WALL. Four accounts with three
 * windows each is twelve bars, which is a settings page hanging off a toolbar
 * rather than a glance. One account is open at a time, and every collapsed row
 * still states its own binding number — so the closed list already answers the
 * question and opening one is for the detail underneath it.
 *
 * WHAT IT ASKS FOR AND WHEN. The surface reads once on mount, again whenever
 * Model Access invalidates what it holds, and again on the first window focus
 * after the runtime's own freshness hold has lapsed. Nothing polls and nothing
 * subscribes: a rate-limited endpoint is not something a piece of window
 * chrome may keep asking about on a timer, which is why every read here is
 * tied to a MOMENT a person created. The Refresh in the header is the only one
 * that skips the hold.
 *
 * Reading on mount rather than on open is what VC-376 changed, and it is not
 * an optimisation — the trigger now DRAWS the reading, so a surface that first
 * asked when opened would have nothing to draw until someone opened it, which
 * is the click the icon exists to save. `inspect({refresh:false})` joins the
 * answer any other surface already holds for this revision, so on a launch
 * where a composer asked first it costs no request at all.
 *
 * The trigger is always here rather than appearing when there is something to
 * show. A control in window chrome that comes and goes is one a person cannot
 * learn the position of, and its absence would say "nothing to report" in
 * exactly the same way as "not signed in to anything metered".
 *
 * PINNING LIVES HERE, ON THE ROWS (VC-452). Each window row carries a pin that
 * puts that window on the glyph — up to both of its bars, from one account —
 * and a collapsed row wears a pin while it holds one, so a closed list still
 * says why the glyph is not showing the account on top. The pin is persisted
 * in the ui store; what it means is `usage-pin.ts`.
 */

import { CaretDownIcon } from "@phosphor-icons/react/dist/csr/CaretDown";
import { PushPinIcon } from "@phosphor-icons/react/dist/csr/PushPin";
import { ArrowClockwiseIcon } from "@phosphor-icons/react/dist/csr/ArrowClockwise";
import * as React from "react";
import { remainingPercent, usageTone, type UsageTone, type UsageWindow } from "@volli/shared";

import {
  usageLimitAccounts,
  type UsageLimitAccount,
} from "@renderer/components/usage-limits/accounts";
import { AccountUsage, type UsageWindowPin } from "@renderer/components/usage-limits/account-usage";
import {
  usageIconLabel,
  usageIconReading,
  type UsageIconInput,
} from "@renderer/components/usage-limits/icon-reading";
import {
  UsageLimitsIcon,
  USAGE_ICON_BUTTON_PX,
} from "@renderer/components/usage-limits/usage-limits-icon";
import { isUsageWindowPinned, type UsagePin } from "@renderer/components/usage-limits/usage-pin";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@renderer/components/ui/accordion";
import { Button } from "@renderer/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@renderer/components/ui/popover";
import { Spinner } from "@renderer/components/ui/spinner";
import { EMPTY_INLINE } from "@renderer/components/ui/empty-classes";
import { useModelAccessClient } from "@renderer/lib/model-access-client";
import { cn } from "@renderer/lib/utils";
import { useUiStore } from "@renderer/stores/ui";

/**
 * What the surface currently knows. `null` is "has not asked yet".
 *
 * This is {@link UsageIconInput} exactly, so the glyph is one call away from
 * the same state the list is drawn from — there is no second idea of what has
 * been read, and no way for the icon and the rows to describe different
 * snapshots. A successful read carries the clock it was judged against with
 * it: tone reads pace, so a reading re-derived at paint time could change
 * verdict while nothing about the numbers did.
 */
type Reading = Extract<UsageIconInput, { kind: "read" | "failed" }>;

/**
 * How stale a reading has to be before regaining focus is worth a request.
 *
 * This mirrors `USAGE_PROBE_FRESH_MS` in `@volli/agent-runtime`, which the
 * renderer may not import — and mirroring it is the point rather than a
 * duplication to tidy away: at exactly this age the providers stop answering
 * from their own hold, so a focus any sooner would spend a sweep of credential
 * reads to be handed back the numbers already on screen. Alt-tabbing all day
 * therefore costs at most what the runtime was already willing to serve.
 */
const REFRESH_AFTER_MS = 5 * 60_000;

export function UsageLimitsPopover({ now }: { now?: number } = {}) {
  const client = useModelAccessClient();
  const [open, setOpen] = React.useState(false);
  const [reading, setReading] = React.useState<Reading | null>(null);
  // Whether a read is in flight, held apart from what is on screen: a Refresh
  // over numbers already drawn must not blank them back to a spinner, but it
  // must still stop the control that started it from being pressed twice.
  const [busy, setBusy] = React.useState(false);
  // Every read owns one generation. Closing or starting another read spends
  // the previous generation, so a late answer cannot revive a surface that no
  // longer wants it or overwrite the newer inspection after the next open.
  const requestId = React.useRef(0);
  // When a read was last ASKED for, which is what the focus gate below is
  // about: one request per hold, whatever the answer turned out to be.
  const askedAt = React.useRef(Date.now());
  React.useEffect(
    () => () => {
      requestId.current += 1;
    },
    [],
  );

  const load = React.useCallback(
    async (refresh: boolean) => {
      const request = ++requestId.current;
      if (client === null) {
        // No Model Access in the tree at all. Nothing to wait for, so say so
        // rather than spinning forever on a promise nobody made.
        setReading({ kind: "failed" });
        setBusy(false);
        return;
      }
      setBusy(true);
      askedAt.current = Date.now();
      try {
        const snapshot = await client.inspect({ refresh });
        if (requestId.current === request) {
          setReading({
            kind: "read",
            accounts: usageLimitAccounts(snapshot.providers),
            // Anchored to the moment the snapshot arrived, not to render:
            // tone reads pace, and a verdict that moved between two renders of
            // one snapshot would be the surface disagreeing with itself.
            now: now ?? Date.now(),
          });
        }
      } catch {
        // No toast: the person is looking at the surface that failed, and it
        // carries the one action that retries. A toast over the top of it
        // would report the same thing twice and outlive the popover.
        if (requestId.current === request) setReading({ kind: "failed" });
      } finally {
        if (requestId.current === request) setBusy(false);
      }
    },
    [client, now],
  );

  const changeOpen = React.useCallback((next: boolean) => {
    setOpen(next);
    if (!next) {
      requestId.current += 1;
      setBusy(false);
    }
  }, []);

  // Read on mount, and again whenever Model Access drops what it holds:
  // `load` changes identity with the shared revision, so a sign-in, a sign-out
  // or another surface's Refresh re-reads here too rather than leaving the
  // glyph describing a profile that no longer exists. Opening needs no read of
  // its own — the held answer is the one this already drew.
  React.useEffect(() => {
    void load(false);
  }, [load]);

  // The one moment worth spending a request on: coming back to the window.
  // Anything that moved a meter while the app was in the background — a turn
  // in another window, a session on another machine, the five-hour window
  // rolling over — happened during exactly that absence, and a person
  // returning to the app is the person about to decide whether to start a run.
  // Gated by {@link REFRESH_AFTER_MS}, so a flurry of alt-tabs is one request
  // at most; never a timer, because a timer asks when nobody is looking.
  React.useEffect(() => {
    const refreshIfStale = (): void => {
      if (Date.now() - askedAt.current < REFRESH_AFTER_MS) return;
      void load(true);
    };
    window.addEventListener("focus", refreshIfStale);
    return () => window.removeEventListener("focus", refreshIfStale);
  }, [load]);

  // The trigger draws what has been read; `icon-reading.ts` is the only thing
  // that decides what that means, so the glyph and the rows below cannot reach
  // different verdicts about one snapshot.
  const pin = useUiStore((state) => state.usagePin);
  const glyph = React.useMemo(
    () => usageIconReading(reading ?? { kind: "unread" }, pin),
    [reading, pin],
  );
  const label = usageIconLabel(glyph);

  return (
    <Popover open={open} onOpenChange={changeOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className="app-region-no-drag shrink-0"
          // Sized from the glyph rather than beside it: `icon-sm`'s own
          // proportion is 3px of padding, and the two numbers this draws need
          // a bigger box than the Gauge did. Writing it as arithmetic on the
          // glyph's constant is what keeps a target that always fits the
          // drawing it holds.
          style={{ width: USAGE_ICON_BUTTON_PX, height: USAGE_ICON_BUTTON_PX }}
          // The name is now the reading — "Usage limits, 8% left on Anthropic
          // Session" — because a glyph that says something a screen reader
          // cannot hear has only redesigned itself for some people. It keeps a
          // stable HEAD so the control is still findable by name; no `sr-only`
          // twin, which `aria-label` would override anyway.
          aria-label={label}
          title={label}
        >
          <UsageLimitsIcon reading={glyph} />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="center" className="w-80 p-0">
        <div className="flex items-center justify-between gap-2 border-b border-border/50 px-2 py-1">
          <span className="text-ui font-medium">Usage limits</span>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Refresh usage limits"
            title="Refresh"
            disabled={busy}
            onClick={() => void load(true)}
          >
            <ArrowClockwiseIcon />
          </Button>
        </div>
        <ReadingView reading={reading} now={now} pin={pin} />
      </PopoverContent>
    </Popover>
  );
}

function ReadingView({
  reading,
  now,
  pin,
}: {
  reading: Reading | null;
  now: number | undefined;
  pin: UsagePin | null;
}) {
  if (reading === null) {
    return (
      <div className="flex items-center justify-center py-6">
        <Spinner className="size-4" />
      </div>
    );
  }
  if (reading.kind === "failed") {
    return <p className={EMPTY_INLINE}>Usage limits couldn&apos;t be read.</p>;
  }
  if (reading.accounts.length === 0) {
    return <p className={EMPTY_INLINE}>No subscriptions with usage limits.</p>;
  }
  return (
    <Accordion
      type="single"
      collapsible
      // The account closest to running out opens itself: it is the one the
      // ordering already put on top, and a list where nothing is open would
      // make every visit cost a click before it says anything.
      defaultValue={reading.accounts[0]?.providerId}
      className="p-1"
    >
      {reading.accounts.map((account) => (
        <AccountItem key={account.providerId} account={account} now={now} pin={pin} />
      ))}
    </Accordion>
  );
}

function AccountItem({
  account,
  now,
  pin,
}: {
  account: UsageLimitAccount;
  now: number | undefined;
  pin: UsagePin | null;
}) {
  const toggleUsagePin = useUiStore((state) => state.toggleUsagePin);
  const { providerId } = account;
  const windowPin = React.useMemo<UsageWindowPin>(
    () => ({
      isPinned: (windowId) => isUsageWindowPinned(pin, providerId, windowId),
      toggle: (windowId) => toggleUsagePin(providerId, windowId),
    }),
    [pin, providerId, toggleUsagePin],
  );
  const holdsPin = pin?.providerId === providerId;
  return (
    <AccordionItem value={account.providerId}>
      <AccordionTrigger className="group">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="min-w-0 truncate text-ui font-medium">{account.label}</span>
          {/* A mark, not a control: the pins that change it are the rows
              inside, and a second button in a trigger would be a button in a
              button. It is here so a closed list still says which account
              the glyph is showing, when that is not the one on top. */}
          {holdsPin ? (
            <PushPinIcon
              aria-label="Pinned to the window bar"
              role="img"
              weight="fill"
              className="size-3 shrink-0 text-muted-foreground"
            />
          ) : null}
        </span>
        <span className="flex shrink-0 items-center gap-1">
          {/* Keyed on the snapshot the reading came from, for the reason
              `account-usage.tsx` keys its rows: the tone reads the pace
              against an anchored `now`, and this row stays mounted across a
              Refresh, so without the key it would judge a new snapshot
              against the clock as it stood when the popover first opened. */}
          <BindingReading key={account.limits.checkedAt} window={account.binding} now={now} />
          <CaretDownIcon
            aria-hidden
            className="size-3 shrink-0 text-muted-foreground transition-transform duration-150 ease-out group-data-[state=open]:rotate-180 motion-reduce:transition-none"
            weight="bold"
          />
        </span>
      </AccordionTrigger>
      <AccordionContent>
        <AccountUsage
          limits={account.limits}
          now={now}
          testId={`usage-${account.providerId}`}
          pin={windowPin}
        />
      </AccordionContent>
    </AccordionItem>
  );
}

/**
 * The one number a collapsed row carries: what is left of the window that runs
 * out first, in the colour that window's own bar would wear.
 *
 * An account whose read failed has no number, and says nothing here rather
 * than a zero — the line inside it explains itself when it is opened.
 */
function BindingReading({ window, now }: { window: UsageWindow | null; now: number | undefined }) {
  // Anchored once per mount rather than per render: the tone reads the pace,
  // and a tone that changed between two renders of the same snapshot would be
  // the surface disagreeing with itself. The optional anchor keeps the lab's
  // fixed snapshot fixed; production reads the clock exactly once as before.
  const [at] = React.useState(() => now ?? Date.now());
  if (window === null) return null;
  const tone = usageTone(window, at);
  return (
    <span className={cn("text-ui tabular-nums", TONE_INK[tone])}>
      {Math.round(remainingPercent(window))}% left
    </span>
  );
}

/** The same verdict `account-usage.tsx` paints its bars with, as ink. */
const TONE_INK: Record<UsageTone, string> = {
  normal: "text-muted-foreground",
  attention: "text-attention",
  critical: "text-destructive",
};
