import { fileURLToPath } from "node:url";
import XLSX from "xlsx";
import { logger } from "../utils/logger.js";
import { getAllRecords } from "../cores/store.js";
import { DATA_DIR } from "../config/paths.js";

async function main() {
  const jobs = await getAllRecords();

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
    evaluation: job.evaluation ?? "",
    summary: job.summary ?? "",
    answer: job.answer ?? "",
    answered: job.answered,
  }));

  const worksheet = XLSX.utils.json_to_sheet(rows);

  const workbook = XLSX.utils.book_new();

  XLSX.utils.book_append_sheet(
    workbook,
    worksheet,
    "Jobs"
  );

  const outPath = new URL("jobs.xlsx", DATA_DIR);

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
