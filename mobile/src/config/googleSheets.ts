export const GOOGLE_SHEETS_CONFIG = {
  spreadsheetId: '1WjJZzHoAtBxPI7VLM9wTE1Mz4TYez0zMYi5ktCzfNfg',
  // Which dataset profile this build was started with (default / noit / ...).
  dataset: process.env.EXPO_PUBLIC_DATASET?.trim() || 'default',
  // Which tab of the spreadsheet that dataset lives in — mirrors the
  // server's GOOGLE_SHEETS_TAB env var (e.g. "Jobs" vs "Noit").
  sheetName: process.env.EXPO_PUBLIC_GOOGLE_SHEETS_TAB?.trim() || 'Jobs',
  apiUrl: process.env.EXPO_PUBLIC_GOOGLE_SHEETS_URL?.trim() || '',
};
