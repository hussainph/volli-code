/** The backend's scheduled sweeps. Each lives in its area's module; this file only schedules them. */

import { cronJobs } from "convex/server";

import { internal } from "./_generated/api.js";

const crons = cronJobs();

// Board receipts answer retries for seven days; expired ones read as absent already.
crons.interval("prune board receipts", { hours: 1 }, internal.boardReceipts.prune, {});

// Staging rows a committed transcript segment covers expire an hour after it.
crons.interval(
  "sweep packed transcript artifacts",
  { minutes: 15 },
  internal.transcripts.sweepPacked,
  {},
);
// A runner silent for 90 s becomes `offline` (runners.ts). Every minute, so
// "waiting for <runner>" shows within 2.5 minutes of a box going away.
crons.interval("runners: offline sweep", { minutes: 1 }, internal.runners.sweepOffline, {
  statusIndex: 0,
  cursor: null,
});
// Expired install tokens and device codes, and runner audit events past 90 days.
crons.interval("runners: expiry cleanup", { hours: 1 }, internal.runners.sweepExpired, {});
// Linking rate-limit buckets that have refilled (an absent bucket is a full one).
crons.interval(
  "runners: link rate-limit cleanup",
  { hours: 1 },
  internal.runnerLinkRateLimit.sweep,
  {},
);
// Runner inbox: delete finished jobs once their keep time has passed.
crons.interval("purge finished runner jobs", { hours: 1 }, internal.runnerJobs.sweep, {});
crons.interval("watches: expiry and access sweep", { hours: 1 }, internal.watches.sweep, {});
// GitHub: redeliver webhook deliveries that never arrived (GitHub does not
// retry), purge old delivery ids and finished flows, and once a day compare
// the App's installations with the table.
crons.interval("github webhook sweep", { hours: 1 }, internal.githubIngest.sweep, {});
crons.interval("github purge", { hours: 1 }, internal.githubIngest.purge, {});
crons.interval(
  "github installations reconcile",
  { hours: 24 },
  internal.githubIngest.reconcileAll,
  {},
);
// Viewers whose heartbeat lapsed (sessionViewers.ts): a client that vanished
// without closing stops its Session streaming within two minutes.
crons.interval(
  "sessionViewers: expiry sweep",
  { minutes: 1 },
  internal.sessionViewers.sweepExpired,
  {},
);
// The Automation clock (automationSchedules.ts): due schedules fire within a
// minute of their time, never before it.
crons.interval(
  "automations: fire due schedules",
  { minutes: 1 },
  internal.automationSchedules.fireDue,
  {},
);
// Stream chunks older than 15 minutes (streamChunks.ts), whatever their message did.
crons.interval("streamChunks: ttl sweep", { minutes: 5 }, internal.streamChunks.sweep, {});

// An aborted move's purge that failed or stalled (projectImportPurge.ts) starts again.
crons.interval("move purges: resume", { minutes: 15 }, internal.projectImportPurge.resume, {});

export default crons;
