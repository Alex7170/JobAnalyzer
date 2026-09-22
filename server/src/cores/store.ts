import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { logger } from "../utils/logger.js";
import type { JobListing, JobAssessment, JobRecord, JobStatus } from "./types.js";
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
  status: JobStatus;
  summary: string | null;
  evaluation: number | null;
  answer: string | null;
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
      status TEXT NOT NULL DEFAULT 'SCRAPED' CHECK (status IN ('SCRAPED', 'ANALYZED', 'APPROVED', 'SKIPPED', 'ANSWERED')),
      summary TEXT,
      evaluation INTEGER CHECK (evaluation BETWEEN 0 AND 10),
      answer TEXT
    );
  `);

  const columns = database.prepare("PRAGMA table_info(jobs)").all() as Array<{
    name: string;
  }>;

  if (!columns.some((column) => column.name === "status")) {
    database.exec(
      "ALTER TABLE jobs ADD COLUMN status TEXT NOT NULL DEFAULT 'SCRAPED' CHECK (status IN ('SCRAPED', 'ANALYZED', 'APPROVED', 'SKIPPED', 'ANSWERED'))",
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
    status: row.status,
    ...(row.evaluation === null ? {} : { evaluation: row.evaluation }),
    ...(row.summary === null ? {} : { summary: row.summary }),
    ...(row.answer === null ? {} : { answer: row.answer }),
  };
}

export async function upsertScraped(jobs: JobListing[]): Promise<void> {
  const db = getDatabase();
  const upsert = db.prepare(`
    INSERT INTO jobs (
      id, url, title, company, location, salary, posted_label, scraped_at, description, status
    ) VALUES (
      @id, @url, @title, @company, @location, @salary, @postedLabel, @scrapedAt, @description, @status
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
      upsert.run(job);
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
      SET summary = @summary,
          evaluation = @evaluation,
          answer = @answer,
          status = CASE
            WHEN status = 'SCRAPED' THEN 'ANALYZED'
            ELSE status
          END
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
      status, evaluation, summary, answer
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
 * Applies manual status changes in one SQLite transaction. This is intentionally
 * narrower than a general record update: external tools may only change the
 * user-owned lifecycle status.
 */
export async function updateStatuses(
  statuses: ReadonlyMap<string, JobStatus>,
): Promise<number> {
  const db = getDatabase();
  const update = db.prepare(`
    UPDATE jobs
    SET status = ?
    WHERE id = ? AND status <> ?
  `);

  let changed = 0;
  db.transaction((updates: ReadonlyMap<string, JobStatus>) => {
    for (const [id, status] of updates) {
      changed += update.run(status, id, status).changes;
    }
  })(statuses);

  return changed;
}
