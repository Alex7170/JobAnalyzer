import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { logger } from "../utils/logger.js";
import type { JobListing, JobAssessment, JobRecord } from "./types.js";
import { DATA_DIR } from "../config/paths.js";

const DATABASE_PATH = new URL("jobs.sqlite", DATA_DIR);

type JobRow = {
  id: string;
  url: string;
  title: string;
  company: string | null;
  location: string | null;
  salary: string | null;
  postedLabel: string | null;
  scrapedAt: string;
  description: string;
  summary: string | null;
  evaluation: number | null;
  answer: string | null;
  answered: number;
};

let database: Database.Database | undefined;

function getDatabase(): Database.Database {
  if (database) {
    return database;
  }

  mkdirSync(fileURLToPath(DATA_DIR), { recursive: true });
  database = new Database(fileURLToPath(DATABASE_PATH));
  database.pragma("journal_mode = WAL");
  database.pragma("busy_timeout = 5000");
  database.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      title TEXT NOT NULL,
      company TEXT,
      location TEXT,
      salary TEXT,
      posted_label TEXT,
      scraped_at TEXT NOT NULL,
      description TEXT NOT NULL,
      summary TEXT,
      evaluation INTEGER CHECK (evaluation BETWEEN 0 AND 10),
      answer TEXT,
      answered INTEGER NOT NULL DEFAULT 0 CHECK (answered IN (0, 1))
    );
  `);

  // Existing databases were created before the manual answered flag existed.
  const columns = database.prepare("PRAGMA table_info(jobs)").all() as Array<{
    name: string;
  }>;
  if (!columns.some((column) => column.name === "answered")) {
    database.exec(
      "ALTER TABLE jobs ADD COLUMN answered INTEGER NOT NULL DEFAULT 0 CHECK (answered IN (0, 1))",
    );
  }

  return database;
}

function toJobRecord(row: JobRow): JobRecord {
  return {
    id: row.id,
    url: row.url,
    title: row.title,
    company: row.company,
    location: row.location,
    salary: row.salary,
    postedLabel: row.postedLabel,
    scrapedAt: row.scrapedAt,
    description: row.description,
    ...(row.evaluation === null ? {} : { evaluation: row.evaluation }),
    ...(row.summary === null ? {} : { summary: row.summary }),
    ...(row.answer === null ? {} : { answer: row.answer }),
    answered: Boolean(row.answered),
  };
}

export async function upsertScraped(jobs: JobListing[]): Promise<void> {
  const db = getDatabase();
  const upsert = db.prepare(`
    INSERT INTO jobs (
      id, url, title, company, location, salary, posted_label, scraped_at, description, answered
    ) VALUES (
      @id, @url, @title, @company, @location, @salary, @postedLabel, @scrapedAt, @description, @answered
    ) ON CONFLICT(id) DO UPDATE SET
      url = excluded.url,
      title = excluded.title,
      company = excluded.company,
      location = excluded.location,
      salary = excluded.salary,
      posted_label = excluded.posted_label,
      scraped_at = excluded.scraped_at,
      description = excluded.description
  `);

  db.transaction((records: JobListing[]) => {
    for (const job of records) {
      // SQLite has no native boolean type. Keep the domain model boolean,
      // but bind its INTEGER representation at the persistence boundary.
      upsert.run({ ...job, answered: job.answered ? 1 : 0 });
    }
  })(jobs);

  const total = (db.prepare("SELECT COUNT(*) AS count FROM jobs").get() as {
    count: number;
  }).count;

  logger.info({ count: jobs.length, total }, "Upserted scraped jobs into SQLite store");
}

export async function upsertAssessment(assessment: JobAssessment): Promise<void> {
  const result = getDatabase()
    .prepare(`
      UPDATE jobs
      SET summary = @summary, evaluation = @evaluation, answer = @answer
      WHERE id = @id
    `)
    .run(assessment);

  if (result.changes === 0) {
    logger.warn(
      { id: assessment.id },
      "Got an assessment for an id that isn't in the store yet — skipping merge",
    );
  }
}

export async function getAllRecords(): Promise<JobRecord[]> {
  const rows = getDatabase()
    .prepare(`
      SELECT
        id, url, title, company, location, salary,
      posted_label AS postedLabel, scraped_at AS scrapedAt, description,
      evaluation, summary, answer, answered
      FROM jobs
      ORDER BY scraped_at DESC, id ASC
    `)
    .all() as JobRow[];

  return rows.map(toJobRecord);
}

export async function getExistingIds(): Promise<Set<string>> {
  const rows = getDatabase().prepare("SELECT id FROM jobs").all() as Array<{
    id: string;
  }>;
  return new Set(rows.map((row) => row.id));
}

/** Removes records confirmed to no longer exist at their source URL. */
export async function deleteRecords(ids: readonly string[]): Promise<number> {
  if (ids.length === 0) {
    return 0;
  }

  const db = getDatabase();
  const remove = db.prepare("DELETE FROM jobs WHERE id = ?");
  let deleted = 0;

  db.transaction((recordIds: readonly string[]) => {
    for (const id of recordIds) {
      deleted += remove.run(id).changes;
    }
  })(ids);

  return deleted;
}

/**
 * Applies manual answered-status changes in one SQLite transaction. This is
 * deliberately narrower than a general record update: external tools may
 * only change this user-owned field.
 */
export async function updateAnsweredStatuses(
  statuses: ReadonlyMap<string, boolean>,
): Promise<number> {
  const db = getDatabase();
  const update = db.prepare(`
    UPDATE jobs
    SET answered = ?
    WHERE id = ? AND answered <> ?
  `);

  let changed = 0;
  db.transaction((updates: ReadonlyMap<string, boolean>) => {
    for (const [id, answered] of updates) {
      const value = answered ? 1 : 0;
      changed += update.run(value, id, value).changes;
    }
  })(statuses);

  return changed;
}
