// Orchestrates the full pipeline: scrape jobs.cz -> process with Claude ->
// results end up in data/jobs.json and data/assessments.json.
//
// Run individually while developing:
//   npm run scrape
//   npm run process
//
// This file is a placeholder for once both steps are stable and you want
// one command that does both, e.g. wired into node-cron for a schedule.

import { logger } from "./logger.js";

logger.info(
  "Run `npm run scrape` then `npm run process` for now — wire them together here once both are solid."
);
