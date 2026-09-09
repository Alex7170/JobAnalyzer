import { readFile, writeFile, mkdir } from "node:fs/promises";
import { logger } from "./logger.js";
import type { JobListing, JobAssessment, JobRecord } from "./types.js";

const DATA_DIR = new URL("../data/", import.meta.url);
const DATA_PATH = new URL("../data/jobs.json", import.meta.url);

async function loadRecords(): Promise<JobRecord[]> {
  try {
    const raw = await readFile(DATA_PATH, "utf-8");
    return JSON.parse(raw) as JobRecord[];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw err;
  }
}

async function saveRecords(records: JobRecord[]): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(DATA_PATH, JSON.stringify(records, null, 2), "utf-8");
}

/**
 * Merge freshly scraped jobs into the store.
 *
 * Re-running the scraper will refresh scraped fields (title, salary,
 * description, ...) for a given id WITHOUT wiping out an AI
 * assessment that was already saved for that same id.
 */
export async function upsertScraped(jobs: JobListing[]): Promise<void> {
  const records = await loadRecords();
  const byId = new Map(records.map((r) => [r.id, r]));

  for (const job of jobs) {
    byId.set(job.id, { ...byId.get(job.id), ...job });
  }

  await saveRecords([...byId.values()]);

  logger.info(
    { count: jobs.length, total: byId.size },
    "Upserted scraped jobs into store",
  );
}

/**
 * Merge one AI assessment into the matching job record (by id).
 *
 * Called per-job right after the model responds, so progress isn't
 * lost if the process gets interrupted halfway through a batch.
 */
export async function upsertAssessment(assessment: JobAssessment): Promise<void> {
  const records = await loadRecords();
  const byId = new Map(records.map((r) => [r.id, r]));

  const existing = byId.get(assessment.id);

  if (!existing) {
    logger.warn(
      { id: assessment.id },
      "Got an assessment for an id that isn't in the store yet — skipping merge",
    );
    return;
  }

  byId.set(assessment.id, { ...existing, ...assessment });

  await saveRecords([...byId.values()]);
}

export async function getAllRecords(): Promise<JobRecord[]> {
  return loadRecords();
}
