import pLimit from "p-limit";

import "../config/loadEnv.js";
import { deleteRecords, getAllRecords } from "../cores/store.js";
import type { JobRecord } from "../cores/types.js";
import { logger } from "../utils/logger.js";

const REQUEST_TIMEOUT_MS = 30_000;
const CONCURRENCY = getConcurrency();
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

function getConcurrency(): number {
  const value = Number.parseInt(process.env.CLEAN_CONCURRENCY ?? "3", 10);

  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("CLEAN_CONCURRENCY must be a positive integer.");
  }

  return value;
}

async function isMissing(job: JobRecord): Promise<boolean> {
  try {
    const response = await fetch(job.url, {
      redirect: "follow",
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    void response.body?.cancel().catch(() => undefined);

    if (response.status === 404) {
      logger.info(
        { id: job.id, url: job.url, finalUrl: response.url },
        "Vacancy returned 404 and will be removed",
      );
      return true;
    }

    return false;
  } catch (err) {
    logger.warn(
      { err, id: job.id, url: job.url },
      "Could not check vacancy; keeping its database record",
    );
    return false;
  }
}

async function main(): Promise<void> {
  const records = await getAllRecords();
  const limit = pLimit(CONCURRENCY);
  const expiredIds = (
    await Promise.all(
      records.map((job) => limit(async () => (await isMissing(job) ? job.id : undefined))),
    )
  ).filter((id): id is string => id !== undefined);

  const deleted = await deleteRecords(expiredIds);

  logger.info(
    {
      checked: records.length,
      expired: expiredIds.length,
      deleted,
      concurrency: CONCURRENCY,
    },
    "Vacancy database cleanup complete",
  );
}

main().catch((err: unknown) => {
  logger.error({ err }, "Vacancy database cleanup failed");
  process.exitCode = 1;
});
