import type { sheets_v4 } from "googleapis";
import { JobStatusSchema, type JobRecord } from "../cores/types.js";

type RgbColor = { red: number; green: number; blue: number };

type TableColumn = {
  key: keyof JobRecord;
  header: string;
  width: number;
  clip?: boolean;
  horizontalAlignment?: "LEFT" | "CENTER";
  checkbox?: boolean;
  oneOfList?: readonly string[];
  colorByValue?: Readonly<Record<string, RgbColor>>;
};

const STATUS_COLORS: Readonly<Record<string, RgbColor>> = {
  SCRAPED: { red: 0.93, green: 0.93, blue: 0.93 }, // light gray — fresh, untouched
  APPROVED: { red: 0.2, green: 1, blue: 0.20 }, // green — ready to apply
  SKIPPED: { red: 0.96, green: 0.80, blue: 0.80 }, // red/pink — declined
  ANSWERED: { red: 0.80, green: 0, blue: 0.96 }, // purple — done
  // ANALYZED is intentionally missing here — it's split into two shades
  // below, based on evaluation, instead of one flat color.
};

const REPLY_THRESHOLD = 7;

const ANALYZED_LOW_COLOR: RgbColor = { red: 0.80, green: 0.89, blue: 0.98 }; // light blue
const ANALYZED_HIGH_COLOR: RgbColor = { red: 0.99, green: 0.80, blue: 0.40 }; // amber — needs your attention

export const TABLE_COLUMNS: readonly TableColumn[] = [
  { key: "id", header: "id", width: 100 },
  { key: "url", header: "url", width: 150 },
  { key: "title", header: "title", width: 150 },
  { key: "company", header: "company", width: 150 },
  { key: "location", header: "location", width: 120 },
  { key: "salary", header: "salary", width: 120 },
  { key: "postedLabel", header: "postedLabel", width: 120 },
  { key: "scrapedAt", header: "scrapedAt", width: 150 },
  { key: "description", header: "description", width: 150, clip: true },
  { key: "evaluation", header: "evaluation", width: 90, horizontalAlignment: "CENTER" },
  { key: "summary", header: "summary", width: 150, horizontalAlignment: "LEFT" },
  { key: "answer", header: "answer", width: 150, horizontalAlignment: "LEFT" },
  { key: "status", header: "status", width: 110, horizontalAlignment: "CENTER",
    oneOfList: JobStatusSchema.options, colorByValue: STATUS_COLORS}
];

export const TABLE_HEADERS = TABLE_COLUMNS.map((column) => column.header);

export const LAST_TABLE_COLUMN = columnLetter(TABLE_COLUMNS.length);

export function buildTableFormatting(
  sheetId: number,
  rowCount: number,
  existingConditionalFormatRuleCount = 0,
): sheets_v4.Schema$Request[] {
  const lastRow = Math.max(rowCount, 2);
  const columnCount = TABLE_COLUMNS.length;
  const requests: sheets_v4.Schema$Request[] = [
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: columnCount },
        cell: { userEnteredFormat: { textFormat: { bold: true, fontFamily: "Roboto", fontSize: 10 }, verticalAlignment: "MIDDLE" } },
        fields: "userEnteredFormat(textFormat,verticalAlignment)",
      },
    },
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 1, endRowIndex: lastRow, startColumnIndex: 0, endColumnIndex: columnCount },
        cell: { userEnteredFormat: { textFormat: { fontFamily: "Roboto", fontSize: 10 }, verticalAlignment: "MIDDLE" } },
        fields: "userEnteredFormat(textFormat,verticalAlignment)",
      },
    },
    {
      updateDimensionProperties: {
        range: { sheetId, dimension: "ROWS", startIndex: 0, endIndex: lastRow },
        properties: { pixelSize: 30 },
        fields: "pixelSize",
      },
    },
    {
      updateSheetProperties: {
        properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
        fields: "gridProperties.frozenRowCount",
      },
    },
    
    // deleting rules after each synchronization
    ...Array.from({ length: existingConditionalFormatRuleCount }, () => ({
      deleteConditionalFormatRule: {
        sheetId,
        index: 0,
      },
    })),
  ];

  for (const [index, column] of TABLE_COLUMNS.entries()) {
    requests.push({
      updateDimensionProperties: {
        range: { sheetId, dimension: "COLUMNS", startIndex: index, endIndex: index + 1 },
        properties: { pixelSize: column.width },
        fields: "pixelSize",
      },
    });

    if (column.clip || column.horizontalAlignment) {
      requests.push({
        repeatCell: {
          range: { sheetId, startRowIndex: 1, endRowIndex: lastRow, startColumnIndex: index, endColumnIndex: index + 1 },
          cell: {
            userEnteredFormat: {
              ...(column.clip ? { wrapStrategy: "CLIP" } : {}),
              ...(column.horizontalAlignment
                ? { horizontalAlignment: column.horizontalAlignment }
                : {}),
              verticalAlignment: "MIDDLE",
            },
          },
          fields: `userEnteredFormat(${column.clip ? "wrapStrategy," : ""}${column.horizontalAlignment ? "horizontalAlignment," : ""}verticalAlignment)`,
        },
      });
    }

    if (column.checkbox) {
      requests.push({
        repeatCell: {
          range: { sheetId, startRowIndex: 1, endRowIndex: lastRow, startColumnIndex: index, endColumnIndex: index + 1 },
          cell: { dataValidation: { condition: { type: "BOOLEAN" }, strict: true, showCustomUi: true } },
          fields: "dataValidation",
        },
      });
    }

    if (column.oneOfList) {
      requests.push({
        repeatCell: {
          range: { sheetId, startRowIndex: 1, endRowIndex: lastRow, startColumnIndex: index, endColumnIndex: index + 1 },
          cell: {
            dataValidation: {
              condition: {
                type: "ONE_OF_LIST",
                values: column.oneOfList.map((value) => ({ userEnteredValue: value })),
              },
              strict: true,
              showCustomUi: true,
            },
          },
          fields: "dataValidation",
        },
      });
    }

    if (column.colorByValue) {
      for (const [value, color] of Object.entries(column.colorByValue)) {
        requests.push({
          addConditionalFormatRule: {
            rule: {
              ranges: [
                {
                  sheetId,
                  startRowIndex: 1,
                  endRowIndex: lastRow,
                  startColumnIndex: index,
                  endColumnIndex: index + 1,
                },
              ],
              booleanRule: {
                condition: {
                  type: "TEXT_EQ",
                  values: [{ userEnteredValue: value }],
                },
                format: { backgroundColor: color },
              },
            },
          },
        });
      }
    }
  }
  // managing color split of analyzed status depending on evaluation score
  const statusColumnIndex = TABLE_COLUMNS.findIndex((column) => column.key === "status");
  const evaluationColumnIndex = TABLE_COLUMNS.findIndex((column) => column.key === "evaluation");

  if (statusColumnIndex !== -1 && evaluationColumnIndex !== -1) {
    const statusRef = `$${columnLetter(statusColumnIndex + 1)}2`;
    const evaluationRef = `$${columnLetter(evaluationColumnIndex + 1)}2`;

    const analyzedSplitRules: Array<{ formula: string; color: RgbColor }> = [
      {
        formula: `=(${statusRef}="ANALYZED")*(${evaluationRef}>=${REPLY_THRESHOLD})`,
        color: ANALYZED_HIGH_COLOR,
      },
      {
        formula: `=(${statusRef}="ANALYZED")*(${evaluationRef}<${REPLY_THRESHOLD})`,
        color: ANALYZED_LOW_COLOR,
      },
    ];

    for (const { formula, color } of analyzedSplitRules) {
      requests.push({
        addConditionalFormatRule: {
          rule: {
            ranges: [
              {
                sheetId,
                startRowIndex: 1,
                endRowIndex: lastRow,
                startColumnIndex: statusColumnIndex,
                endColumnIndex: statusColumnIndex + 1,
              },
            ],
            booleanRule: {
              condition: {
                type: "CUSTOM_FORMULA",
                values: [{ userEnteredValue: formula }],
              },
              format: { backgroundColor: color },
            },
          },
        },
      });
    }
  }

  return requests;
}

function columnLetter(columnCount: number): string {
  let column = columnCount;
  let result = "";

  while (column > 0) {
    column -= 1;
    result = String.fromCharCode(65 + (column % 26)) + result;
    column = Math.floor(column / 26);
  }

  return result;
}