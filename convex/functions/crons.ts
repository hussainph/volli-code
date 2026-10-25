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

export default crons;
