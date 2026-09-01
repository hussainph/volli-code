/**
 * Schedule policy (VC-112, VC-130): when a schedule Trigger is next due.
 *
 * This module is a PURE FUNCTION of the schedule, its stored IANA zone and a
 * current time. It answers WHEN; `automation-schedule-pass.ts` beside it
 * answers what a host owes about that; and the Electron timer that acts on
 * both is a thin caller (`main/automations/scheduler.ts`). That split is the
 * ticket's ruled architecture rather than a preference:
 *
 *  - **Testability first.** Every hard rule this feature owns — reschedule and
 *    never replay, never start early, stagger a top-of-hour schedule, let the
 *    stored zone win over travel — is a statement about *which instant comes
 *    next*. Each is a table test here; through a live timer each would be a
 *    sleep and a guess.
 *  - **The policy travels, the timer does not.** The scheduler is the first
 *    module whose correctness depends on which machine is awake. If the
 *    Automation record moves to an account (VC-112), this file moves with the
 *    record and only the timer stays local — so it deliberately knows nothing
 *    about hosts, processes or clocks it did not receive as an argument.
 *
 * **No cron.** VC-112 rules that no cron expression is accepted anywhere in the
 * UI and therefore that no cron parser ships. The preset set is closed —
 * hourly, daily, weekdays, weekly — and the shapes below cannot spell anything
 * else. Never accepting cron syntax also means never inheriting its foot-guns:
 * OpenClaw's own docs record that day-of-month and day-of-week OR together, so
 * `0 9 15 * 1` fires five or six times a month instead of once. There is no
 * spelling of that bug here.
 *
 * Zone handling uses `Intl` and nothing else — no date library, no offset
 * arithmetic of our own. The stored zone is the authority: a schedule computed
 * on a laptop in Tokyo and the same schedule computed in London produce the
 * same instants, because neither reads the host's zone at any point.
 */

/** The whole preset set for V1: hourly, every day, Mon–Fri, and weekly. */
export const AUTOMATION_SCHEDULE_PRESETS = ["hourly", "daily", "weekdays", "weekly"] as const;

export type AutomationSchedulePreset = (typeof AUTOMATION_SCHEDULE_PRESETS)[number];

/**
 * The days a weekly schedule can name, in `Date`'s own order so the index IS
 * the `getUTCDay()` value and no lookup table can drift from one.
 *
 * Spelled as words rather than stored as a number because these rows outlive
 * the build that wrote them: `{"weekday":1}` needs this file to be read, while
 * `{"weekday":"monday"}` is legible in a database viewer during an incident.
 */
export const SCHEDULE_WEEKDAYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
] as const;

export type ScheduleWeekday = (typeof SCHEDULE_WEEKDAYS)[number];

/**
 * One authored schedule — the structured data behind a self-contained cadence
 * sentence such as `Every day at 21:00 Europe/London`.
 *
 * A DISCRIMINATED UNION rather than one shape with ignorable fields, for the
 * reason `ModelSelection` keeps model and reasoning together: a type that can
 * spell "hourly, at 09:00" can spell a schedule that does not exist, and then
 * every reader needs a rule for which half to believe. An hourly schedule has
 * no hour; a weekly one has a weekday and the others do not.
 *
 * `timeZone` is on every arm rather than beside the union because it is not
 * optional in any of them: VC-112 rules that the zone is stored beside the
 * schedule, always shown, and that the stored zone wins. A schedule with no
 * zone would have to fall back to the host's, which is exactly the travelling
 * behaviour that ruling exists to forbid.
 */
export type AutomationSchedule =
  | { preset: "hourly"; minute: number; timeZone: string }
  | { preset: "daily"; hour: number; minute: number; timeZone: string }
  | { preset: "weekdays"; hour: number; minute: number; timeZone: string }
  | {
      preset: "weekly";
      weekday: ScheduleWeekday;
      hour: number;
      minute: number;
      timeZone: string;
    };

/**
 * How far a top-of-hour schedule may be pushed back, in milliseconds.
 *
 * Five minutes, following OpenClaw's own rule, and it exists for one reason:
 * schedules cluster on the hour, so without it every 09:00 Automation on a
 * machine wakes in the same second and contends for the same runtime. The push
 * is always LATER — VC-112's durability contract is that a Run may start late
 * but never early, and a stagger that could subtract would break it.
 */
export const AUTOMATION_SCHEDULE_STAGGER_MS = 5 * 60_000;

/**
 * One formatter per zone, kept because the launch sweep asks for thousands of
 * conversions when an app has been closed for a long time and constructing an
 * `Intl.DateTimeFormat` is the expensive half of each one. It is a cache of a
 * pure function keyed by its only argument, so it changes no answer.
 *
 * Declared above {@link isScheduleTimeZone}'s use of it on purpose: validating
 * a zone and formatting in it are the same act, so a zone that passes the check
 * has already paid for the formatter every later call will use.
 */
const zoneFormatters = new Map<string, Intl.DateTimeFormat>();

function zoneFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = zoneFormatters.get(timeZone);
  if (cached !== undefined) return cached;
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  zoneFormatters.set(timeZone, formatter);
  return formatter;
}

/**
 * Whether `Intl` in THIS build can resolve `value` as an IANA zone.
 *
 * Asked of every stored zone on the way in, because a zone this build cannot
 * resolve makes every later computation throw — and a schedule that throws is
 * a scheduler that stops, which is the one failure that would take the other
 * schedules down with it. An unresolvable zone degrades the whole Trigger to
 * "Nothing else" instead (`parseAutomationTrigger`), which only ever stops
 * something from starting on its own.
 */
export function isScheduleTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  try {
    // Constructing IS the validation: an unknown zone throws RangeError. The
    // formatter is kept rather than discarded because every caller that
    // accepts a zone is about to need one anyway.
    zoneFormatter(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * The host's own IANA zone, for seeding a NEW schedule only.
 *
 * Read exactly once, at authoring time, and then stored — after which the
 * stored value wins forever. This is the only function in the module that
 * consults the machine, and nothing that computes an occurrence may call it:
 * that is what "travelling never moves a schedule" means in code.
 *
 * Unguarded because ECMA-402 already guarantees the answer: `resolvedOptions`
 * returns an IANA name (falling back to `"UTC"` itself when the host has no
 * usable zone), so a validity check here would be a branch nothing can enter.
 */
export function hostTimeZone(): string {
  return new Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function isHour(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 23;
}

function isMinute(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 59;
}

function isWeekday(value: unknown): value is ScheduleWeekday {
  return SCHEDULE_WEEKDAYS.some((day) => day === value);
}

/**
 * A stored/transported schedule, or `null` when this build cannot read it.
 *
 * `null` rather than a repaired guess, and the caller's degrade direction is
 * the Trigger's: an unreadable schedule becomes "Nothing else", so the
 * Automation stays runnable by hand and simply never fires on its own. Guessing
 * instead — a default hour, the host's zone for a missing one — would start
 * unattended work at a time nobody chose, which is the one failure mode this
 * feature must not have.
 */
export function parseAutomationSchedule(raw: unknown): AutomationSchedule | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const timeZone = record["timeZone"];
  if (!isScheduleTimeZone(timeZone)) return null;
  const minute = record["minute"];
  if (!isMinute(minute)) return null;
  const preset = record["preset"];
  if (preset === "hourly") return { preset: "hourly", minute, timeZone };
  const hour = record["hour"];
  if (!isHour(hour)) return null;
  if (preset === "daily") return { preset: "daily", hour, minute, timeZone };
  if (preset === "weekdays") return { preset: "weekdays", hour, minute, timeZone };
  if (preset !== "weekly") return null;
  const weekday = record["weekday"];
  if (!isWeekday(weekday)) return null;
  return { preset: "weekly", weekday, hour, minute, timeZone };
}

/* ------------------------------------------------------- the sentence ----- */

const WEEKDAY_LABELS: Record<ScheduleWeekday, string> = {
  sunday: "Sunday",
  monday: "Monday",
  tuesday: "Tuesday",
  wednesday: "Wednesday",
  thursday: "Thursday",
  friday: "Friday",
  saturday: "Saturday",
};

function twoDigits(value: number): string {
  return value.toString().padStart(2, "0");
}

/** `09:30` — the one spelling of a schedule's time, 24-hour like the control. */
export function scheduleTimeLabel(schedule: AutomationSchedule): string {
  return schedule.preset === "hourly"
    ? `:${twoDigits(schedule.minute)}`
    : `${twoDigits(schedule.hour)}:${twoDigits(schedule.minute)}`;
}

/**
 * The schedule as the sentence the editor's row reads, minus the zone:
 * "Every day at 21:00" or "Weekly on Monday at 09:00".
 *
 * One formatter for every surface. The editor composes the same words out of
 * its controls, so a saved Automation's row and the form that authored it name
 * the same schedule the same way — two spellings of one fact read as two facts.
 */
export function schedulePhrase(schedule: AutomationSchedule): string {
  switch (schedule.preset) {
    case "hourly":
      return `Hourly at ${scheduleTimeLabel(schedule)} past the hour`;
    case "daily":
      return `Every day at ${scheduleTimeLabel(schedule)}`;
    case "weekdays":
      return `Mon–Fri at ${scheduleTimeLabel(schedule)}`;
    case "weekly":
      return `Weekly on ${WEEKDAY_LABELS[schedule.weekday]} at ${scheduleTimeLabel(schedule)}`;
  }
}

/** The sentence with its zone, which VC-112 requires to be shown always. */
export function scheduleSentence(schedule: AutomationSchedule): string {
  return `${schedulePhrase(schedule)} ${schedule.timeZone}`;
}

/* --------------------------------------------------------- the stagger ---- */

/**
 * A stable 32-bit FNV-1a hash of the stagger key.
 *
 * Deliberately not a durable id and deliberately not random. It is recomputed
 * on every launch from the same key, which is what makes a schedule's stagger
 * CONSTANT — the ticket's rule is that a schedule must not wander within its
 * five minutes, so `Math.random()` here would be the bug. Changing this
 * derivation would not error either; it would silently move every top-of-hour
 * schedule on every machine by up to five minutes, so treat it as frozen.
 */
function hash32(key: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    // FNV prime, multiplied in 32-bit pieces so the result never leaves the
    // range JavaScript's own bit operators can represent exactly.
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * How long after its due time this schedule actually fires, in milliseconds.
 *
 * Applied only to a TOP-OF-HOUR schedule (`minute === 0`), which is where the
 * pile-up is: "every hour", "every day at 09:00" and "every Monday at 08:00"
 * all wake on the hour, while a schedule someone set to :17 has already
 * staggered itself. Derived from `staggerKey` — the Automation's own durable id
 * in the desktop composition — so two Automations at 09:00 wake minutes apart
 * while either one alone wakes at the same moment every day.
 */
export function scheduleStaggerMs(schedule: AutomationSchedule, staggerKey: string): number {
  if (schedule.minute !== 0) return 0;
  return hash32(staggerKey) % AUTOMATION_SCHEDULE_STAGGER_MS;
}

/* ------------------------------------------------ zone-aware arithmetic --- */

/** A wall-clock reading with no zone attached — what a person sees on a clock. */
interface WallTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

/**
 * What a clock in `timeZone` reads at `instant`.
 *
 * Filled by walking the parts rather than searching them per field: the walk
 * needs no "and if this field is missing" answer, which would be a policy
 * invented for a case `formatToParts` cannot produce. The `default` arm is the
 * separators (`-`, `, `, `:`), which are parts too.
 */
function wallTimeAt(instant: number, timeZone: string): WallTime & { second: number } {
  const wall = { year: 0, month: 0, day: 0, hour: 0, minute: 0, second: 0 };
  for (const part of zoneFormatter(timeZone).formatToParts(instant)) {
    switch (part.type) {
      case "year":
        wall.year = Number(part.value);
        break;
      case "month":
        wall.month = Number(part.value);
        break;
      case "day":
        wall.day = Number(part.value);
        break;
      case "hour":
        wall.hour = Number(part.value);
        break;
      case "minute":
        wall.minute = Number(part.value);
        break;
      case "second":
        wall.second = Number(part.value);
        break;
      default:
        break;
    }
  }
  return wall;
}

/** The zone's UTC offset at `instant`, in milliseconds. */
function zoneOffsetMs(instant: number, timeZone: string): number {
  const wall = wallTimeAt(instant, timeZone);
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  // Compare whole seconds with whole seconds: the formatter has no milliseconds
  // to report, so the sub-second part of `instant` is not part of the offset.
  return asUtc - Math.floor(instant / 1000) * 1000;
}

/** A day in milliseconds — the window either side of a wall time a transition is looked for in. */
const DAY_MS = 86_400_000;

/** Whether a clock in `timeZone` really reads `wall` at `instant`. */
function readsAs(instant: number, wall: WallTime, timeZone: string): boolean {
  const actual = wallTimeAt(instant, timeZone);
  return (
    actual.year === wall.year &&
    actual.month === wall.month &&
    actual.day === wall.day &&
    actual.hour === wall.hour &&
    actual.minute === wall.minute
  );
}

/**
 * The instant a clock in `timeZone` reads `wall`.
 *
 * The offset at an instant can only be asked of an instant, and the instant is
 * what we are solving for. So both offsets a zone could be on around this wall
 * time are asked for — a day either side, which brackets any transition that
 * could touch it — and each yields one candidate instant. A candidate is real
 * only if the zone actually reads `wall` there, and **the answer is always the
 * LATEST candidate**, whether or not any of them was real. That single rule is
 * VC-112's durability contract ("a Run may start late, but never early")
 * expressed in arithmetic, and it is why this cannot be an offset guess
 * corrected once: correcting once picks whichever offset the guess landed on,
 * which in a zone west of UTC is the one BEFORE the transition — 02:30 on New
 * York's spring-forward morning came back as 01:30 EST, an hour early.
 *
 * The two DST cases, both the zone's problem rather than an offset's (VC-112):
 *
 *  - **Spring forward**, where the wall time does not exist (02:30 on a morning
 *    that jumps 02:00 → 03:00). Neither candidate is real, and the later one is
 *    the instant that wall time WOULD have been under the offset still in force
 *    before the jump — 03:30 EDT for a 02:30 EST that never happened. So the
 *    occurrence runs after the gap: late, never early, and never at an instant
 *    that is not a real time at all.
 *  - **Fall back**, where the wall time happens twice (01:30 on a morning that
 *    repeats 01:00–01:59). Both candidates are real and the later reading wins,
 *    settling the ambiguity in the contract's own allowed direction. The
 *    repeated hour still produces exactly ONE occurrence, because the next one
 *    is a whole period after the instant returned here.
 */
function instantOfWallTime(wall: WallTime, timeZone: string): number {
  const naive = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
  // The offset before any transition near this wall time, and the offset after
  // it. They are equal on all but two days a year, and then both candidates
  // collapse to the one instant.
  const underEarlierOffset = naive - zoneOffsetMs(naive - DAY_MS, timeZone);
  const underLaterOffset = naive - zoneOffsetMs(naive + DAY_MS, timeZone);
  const real = [underEarlierOffset, underLaterOffset].filter((candidate) =>
    readsAs(candidate, wall, timeZone),
  );
  return real.length === 0 ? Math.max(underEarlierOffset, underLaterOffset) : Math.max(...real);
}

/** The day of week of a wall date, 0–6 with Sunday at 0 — pure calendar, no zone. */
function wallWeekday(wall: WallTime): number {
  return new Date(Date.UTC(wall.year, wall.month - 1, wall.day)).getUTCDay();
}

function addDays(wall: WallTime, days: number): WallTime {
  const shifted = new Date(Date.UTC(wall.year, wall.month - 1, wall.day + days));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: wall.hour,
    minute: wall.minute,
  };
}

function addHours(wall: WallTime, hours: number): WallTime {
  const shifted = new Date(
    Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour + hours, wall.minute),
  );
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
  };
}

/** Whether this schedule fires on that calendar day at all. */
function dayIsEligible(wall: WallTime, schedule: AutomationSchedule): boolean {
  switch (schedule.preset) {
    case "hourly":
    case "daily":
      return true;
    case "weekdays": {
      const weekday = wallWeekday(wall);
      return weekday >= 1 && weekday <= 5;
    }
    case "weekly":
      return wallWeekday(wall) === SCHEDULE_WEEKDAYS.indexOf(schedule.weekday);
  }
}

/** The slot after this one — one hour for hourly, otherwise the next eligible day. */
function nextSlot(wall: WallTime, schedule: AutomationSchedule): WallTime {
  if (schedule.preset === "hourly") return addHours(wall, 1);
  let candidate = addDays(wall, 1);
  while (!dayIsEligible(candidate, schedule)) candidate = addDays(candidate, 1);
  return candidate;
}

/* --------------------------------------------------- the one computation -- */

export interface ScheduleOccurrenceInput {
  schedule: AutomationSchedule;
  /**
   * The stable key the stagger is derived from — the Automation's durable id
   * in the desktop composition. Required rather than defaulted, because a
   * caller that forgot it would silently put every schedule on the same offset
   * and undo the whole point of staggering.
   */
  staggerKey: string;
  /** Epoch milliseconds. The answer is always strictly greater than this. */
  after: number;
}

/**
 * The next instant this schedule is due, strictly after `after`.
 *
 * The single function the whole feature's correctness rests on, and everything
 * the ticket rules is visible in its signature: the schedule and its stored
 * zone go in, a current time goes in, one instant comes out. Nothing here reads
 * a clock, a host zone, a database or a process — which is why "the stored zone
 * wins over travel" is a property that can simply be tested rather than a
 * behaviour that has to be observed.
 *
 * **Strictly after**, and that is the never-replay rule in one operator: a
 * caller that has just fired the occurrence at `t` asks again with `after: t`
 * and receives the NEXT one. There is no input for which this returns an
 * occurrence a caller has already been handed.
 *
 * The answer includes the stagger, so it is the instant to fire at rather than
 * the instant printed on the row. That direction is deliberate — a caller that
 * added the stagger itself could add it twice, and one that forgot would fire
 * on the hour with everything else.
 */
export function nextScheduleOccurrence(input: ScheduleOccurrenceInput): number {
  const { schedule, after } = input;
  const stagger = scheduleStaggerMs(schedule, input.staggerKey);
  const nowWall = wallTimeAt(after, schedule.timeZone);
  // Start at the slot on `after`'s own day (or its own hour) rather than at a
  // computed guess: the loop below is what enforces "strictly after", so the
  // start only has to be no later than the answer.
  let slot: WallTime = {
    year: nowWall.year,
    month: nowWall.month,
    day: nowWall.day,
    hour: schedule.preset === "hourly" ? nowWall.hour : schedule.hour,
    minute: schedule.minute,
  };
  while (!dayIsEligible(slot, schedule)) slot = addDays(slot, 1);
  let at = instantOfWallTime(slot, schedule.timeZone) + stagger;
  // Terminates because each step moves the wall clock forward by at least an
  // hour while a zone's offset varies by at most a couple of hours in total, so
  // the instant is non-decreasing and rises without bound. (A spring-forward
  // gap is the one case where two adjacent slots share an instant; the step
  // after it is strictly greater.)
  while (at <= after) {
    slot = nextSlot(slot, schedule);
    at = instantOfWallTime(slot, schedule.timeZone) + stagger;
  }
  return at;
}

/*
 * What a host OWES a schedule — what it missed, whether it may run now, and
 * where its cursor lands — is the other half of this policy and lives in
 * `automation-schedule-pass.ts`. It is the only caller of the walk that counts
 * missed occurrences, which is why that walk is over there with the durability
 * rules it serves rather than here beside the calendar arithmetic.
 */
