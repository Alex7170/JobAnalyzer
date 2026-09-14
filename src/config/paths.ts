import "./loadEnv.js";

/**
 * Everything the pipeline reads/writes (data/*.json, data/*.xlsx, prompts/*)
 * lives under a "dataset" subfolder, picked with the DATASET env var:
 *
 *   data/<DATASET>/jobs.json, assessments.json, jobs.xlsx
 *   prompts/<DATASET>/system.txt, candidate-profile.txt, assess-job.txt
 *
 * This lets one image/codebase run several independent scrape+prompt
 * profiles just by pointing DATASET (and the rest of the env) at a
 * different value — no code changes, no rebuild.
 *
 * Defaults to "default" so existing setups without DATASET set keep
 * working exactly as before.
 */
const DATASET = (process.env.DATASET ?? "default").trim();

if (!/^[a-zA-Z0-9_-]+$/.test(DATASET)) {
  throw new Error(
    `Invalid DATASET "${DATASET}" — use only letters, numbers, "-" and "_" (it becomes a folder name).`
  );
}

export { DATASET };

// Resolved relative to this file (src/paths.ts), so these stay correct
// regardless of which script imports them.
export const DATA_DIR = new URL(`../../data/${DATASET}/`, import.meta.url);
export const PROMPTS_DIR = new URL(`../../prompts/${DATASET}/`, import.meta.url);
