import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import XLSX from "xlsx";
import { logger } from "../logger.js";
import {
  JobListingSchema,
  type JobListing,
} from "../types.js";

async function main() {
  const dataPath = new URL("../../data/jobs.json", import.meta.url);

  const raw = await readFile(dataPath, "utf-8");

  const jobs: JobListing[] = JobListingSchema.array().parse(
    JSON.parse(raw)
  );

  logger.info(
    { count: jobs.length },
    "Loaded jobs for Excel export"
  );

  const rows = jobs.map((job) => ({
    id: job.id,
    url: job.url,
    title: job.title,
    company: job.company,
    location: job.location,
    salary: job.salary,
    postedLabel: job.postedLabel,
  }));

  const worksheet = XLSX.utils.json_to_sheet(rows);

  const workbook = XLSX.utils.book_new();

  XLSX.utils.book_append_sheet(
    workbook,
    worksheet,
    "Jobs"
  );

  const outPath = new URL(
    "../../data/jobs.xlsx",
    import.meta.url
  );

  XLSX.writeFile(
    workbook,
    fileURLToPath(outPath)
  );

  logger.info(
    {
      outPath: outPath.pathname,
      count: jobs.length,
    },
    "Saved jobs to Excel"
  );
}

main().catch((err) => {
  logger.error(
    { err },
    "Excel export failed"
  );

  process.exit(1);
});