import type { sheets_v4 } from "googleapis";

import type { JobRecord } from "../cores/types.js";

type TableColumn = {
  key: keyof JobRecord;
  header: string;
  width: number;
  clip?: boolean;
  horizontalAlignment?: "LEFT" | "CENTER";
  checkbox?: boolean;
};

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
  { key: "answered", header: "answered", width: 90, horizontalAlignment: "CENTER", checkbox: true },
];

export const TABLE_HEADERS = TABLE_COLUMNS.map((column) => column.header);

export const LAST_TABLE_COLUMN = columnLetter(TABLE_COLUMNS.length);

export function buildTableFormatting(
  sheetId: number,
  rowCount: number,
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
