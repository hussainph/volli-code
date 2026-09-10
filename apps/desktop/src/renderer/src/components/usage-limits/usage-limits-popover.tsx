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
 * WHAT IT ASKS FOR AND WHEN. Opening the popover inspects; the Refresh in its
 * header inspects again and skips the freshness hold. Nothing polls, nothing
 * subscribes, and closing it ends the surface's interest entirely — a
 * rate-limited endpoint is not something a piece of window chrome may keep
 * asking about in the background. The runtime's own five-minute hold means an
 * open-close-open costs no request at all.
 *
 * The trigger is always here rather than appearing when there is something to
 * show. A control in window chrome that comes and goes is one a person cannot
 * learn the position of, and its absence would say "nothing to report" in
 * exactly the same way as "not signed in to anything metered".
 */

import { CaretDownIcon } from "@phosphor-icons/react/dist/csr/CaretDown";
import { ArrowClockwiseIcon } from "@phosphor-icons/react/dist/csr/ArrowClockwise";
import { GaugeIcon } from "@phosphor-icons/react/dist/csr/Gauge";
import * as React from "react";
import { remainingPercent, usageTone, type UsageTone, type UsageWindow } from "@volli/shared";

import {
  usageLimitAccounts,
  type UsageLimitAccount,
} from "@renderer/components/usage-limits/accounts";
import { AccountUsage } from "@renderer/components/usage-limits/account-usage";
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

/** What the surface currently knows. `null` is "has not asked yet". */
type Reading = { kind: "read"; accounts: readonly UsageLimitAccount[] } | { kind: "failed" };

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
      try {
        const snapshot = await client.inspect({ refresh });
        if (requestId.current === request) {
          setReading({ kind: "read", accounts: usageLimitAccounts(snapshot.providers) });
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
    [client],
  );

  const changeOpen = React.useCallback((next: boolean) => {
    setOpen(next);
    if (!next) {
      requestId.current += 1;
      setBusy(false);
    }
  }, []);

  // Inspect on open, every open. The runtime holds each provider's endpoint to
  // one completed attempt per five minutes, so this is cheap by construction.
  //
  // `load` also changes identity when Model Access bumps its shared revision —
  // a sign-in or a sign-out — so an account added or removed while this is
  // open re-reads rather than showing a list that no longer describes the
  // profile.
  React.useEffect(() => {
    if (open) void load(false);
  }, [open, load]);

  return (
    <Popover open={open} onOpenChange={changeOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className="app-region-no-drag"
          aria-label="Usage limits"
          title="Usage limits"
        >
          <GaugeIcon />
          <span className="sr-only">Usage limits</span>
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
        <ReadingView reading={reading} now={now} />
      </PopoverContent>
    </Popover>
  );
}

function ReadingView({ reading, now }: { reading: Reading | null; now: number | undefined }) {
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
        <AccountItem key={account.providerId} account={account} now={now} />
      ))}
    </Accordion>
  );
}

function AccountItem({ account, now }: { account: UsageLimitAccount; now: number | undefined }) {
  return (
    <AccordionItem value={account.providerId}>
      <AccordionTrigger className="group">
        <span className="min-w-0 truncate text-ui font-medium">{account.label}</span>
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
        <AccountUsage limits={account.limits} now={now} testId={`usage-${account.providerId}`} />
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
