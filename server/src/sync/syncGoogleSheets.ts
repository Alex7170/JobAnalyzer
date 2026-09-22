import { resolve } from "node:path";
import { google } from "googleapis";
import { logger } from "../utils/logger.js";

import {
  getAllRecords,
  updateStatuses,
} from "../cores/store.js";

import {
  JobStatusSchema,
  type JobRecord,
  type JobStatus,
} from "../cores/types.js";
import {
  buildTableFormatting,
  LAST_TABLE_COLUMN,
  TABLE_COLUMNS,
  TABLE_HEADERS,
} from "./googleSheetsTable.js";

import "../config/loadEnv.js";

const SPREADSHEET_ID =
  process.env.GOOGLE_SHEETS_SPREADSHEET_ID?.trim();

const SHEET_NAME =
  process.env.GOOGLE_SHEETS_TAB?.trim() || "Jobs";

function sheetRange(range: string): string {
  // A tab title can legally contain apostrophes; A1 notation escapes them.
  return `'${SHEET_NAME.replaceAll("'", "''")}'!${range}`;
}

function parseStatus(value: unknown): JobStatus | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim().toUpperCase();
  const parsed = JobStatusSchema.safeParse(normalized);

  return parsed.success ? parsed.data : undefined;
}

function cellValue(
  job: JobRecord,
  key: (typeof TABLE_COLUMNS)[number]["key"],
): string | number | boolean {
  const value = job[key];

  if (value === null || value === undefined) {
    return "";
  }

  return value;
}

function getCredentials(): {
  credentials?: object;
  keyFile?: string;
} {
  const rawJson =
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim();

  const keyFile =
    process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE?.trim();

  if (rawJson) {
    try {
      return {
        credentials: JSON.parse(rawJson) as object,
      };
    } catch {
      throw new Error(
        "GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON.",
      );
    }
  }

  if (keyFile) {
    return {
      keyFile: resolve(keyFile),
    };
  }

  throw new Error(
    "Set GOOGLE_SERVICE_ACCOUNT_JSON or GOOGLE_SERVICE_ACCOUNT_KEY_FILE to authenticate with Google Sheets.",
  );
}

async function main(): Promise<void> {
  if (!SPREADSHEET_ID) {
    throw new Error(
      "Set GOOGLE_SHEETS_SPREADSHEET_ID before running npm run sync.",
    );
  }

  const auth = new google.auth.GoogleAuth({
    ...getCredentials(),
    scopes: [
      "https://www.googleapis.com/auth/spreadsheets",
    ],
  });

  const sheets = google.sheets({
    version: "v4",
    auth,
  });

  // ------------------------------------------------------------
  // Find or create the required tab
  // ------------------------------------------------------------

  let spreadsheet = await sheets.spreadsheets.get({
    spreadsheetId: SPREADSHEET_ID,
    fields: "sheets.properties,sheets.conditionalFormats",
  });

  let currentSheet = spreadsheet.data.sheets?.find(
    (sheet) => sheet.properties?.title === SHEET_NAME,
  );

  if (!currentSheet) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: {
        requests: [
          {
            addSheet: {
              properties: {
                title: SHEET_NAME,
              },
            },
          },
        ],
      },
    });

    logger.info(
      { sheet: SHEET_NAME },
      "Created Google Sheets tab",
    );

    // Reload spreadsheet information to get the new sheetId.
    spreadsheet = await sheets.spreadsheets.get({
      spreadsheetId: SPREADSHEET_ID,
      fields: "sheets.properties,sheets.conditionalFormats",
    });

    currentSheet = spreadsheet.data.sheets?.find(
      (sheet) => sheet.properties?.title === SHEET_NAME,
    );
  }

  const sheetId = currentSheet?.properties?.sheetId;

  if (sheetId == null) {
    throw new Error(
      `Could not find Google Sheets tab "${SHEET_NAME}".`,
    );
  }

  // ------------------------------------------------------------
  // Read existing sheet first
  // ------------------------------------------------------------
  // This is important because the job status is manually controlled
  // from Google Sheets.

  const existing = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: sheetRange(`A:${LAST_TABLE_COLUMN}`),
    valueRenderOption: "UNFORMATTED_VALUE",
  });

  const sheetRows = existing.data.values ?? [];

  const databaseJobs = await getAllRecords();

  const knownIds = new Set(
    databaseJobs.map((job) => job.id),
  );

  const statuses = new Map<string, JobStatus>();

  if (sheetRows.length > 0) {
    const header = sheetRows[0].map((value) =>
      String(value).trim().toLowerCase(),
    );

    const idIndex = header.indexOf("id");
    const statusIndex = header.indexOf("status");

    if (idIndex === -1 || statusIndex === -1) {
      logger.warn(
        "Google Sheet has no id/status headers; skipped importing manual status changes and will reset its table layout",
      );
    } else {
      for (const row of sheetRows.slice(1)) {
        const id = String(
          row[idIndex] ?? "",
        ).trim();

        if (!id || !knownIds.has(id)) {
          continue;
        }

        const status = parseStatus(row[statusIndex]);

        if (status === undefined) {
          logger.warn(
            {
              id,
              value: row[statusIndex],
            },
            "Ignored invalid status value in Google Sheet",
          );

          continue;
        }

        statuses.set(id, status);
      }
    }
  }

  // ------------------------------------------------------------
  // Update SQLite from Google Sheets
  // ------------------------------------------------------------

  const changed =
    await updateStatuses(statuses);

  // ------------------------------------------------------------
  // Read updated data from SQLite
  // ------------------------------------------------------------

  const jobs = await getAllRecords();

  const values = [
    TABLE_HEADERS,
    ...jobs.map((job) =>
      TABLE_COLUMNS.map(({ key }) =>
        cellValue(job, key),
      ),
    ),
  ];

  // ------------------------------------------------------------
  // Write data to Google Sheets
  // ------------------------------------------------------------

  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: sheetRange("A1"),
    valueInputOption: "RAW",
    requestBody: {
      values,
    },
  });

  // ------------------------------------------------------------
  // Remove stale rows
  // ------------------------------------------------------------

  if (sheetRows.length > values.length) {
    await sheets.spreadsheets.values.clear({
      spreadsheetId: SPREADSHEET_ID,
      range: sheetRange(
        `A${values.length + 1}:${LAST_TABLE_COLUMN}${sheetRows.length}`,
      ),
    });
  }

  const existingConditionalFormatRuleCount =
    currentSheet?.conditionalFormats?.length ?? 0;

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: {
      requests: buildTableFormatting(
        sheetId,
        values.length,
        existingConditionalFormatRuleCount,
      ),
    },
  });

  logger.info(
    {
      jobs: jobs.length,
      importedRows: statuses.size,
      changed,
      sheet: SHEET_NAME,
    },
    "Google Sheets synchronization complete",
  );
}

main().catch((err: unknown) => {
  logger.error(
    { err },
    "Google Sheets synchronization failed",
  );
  process.exit(1);
});