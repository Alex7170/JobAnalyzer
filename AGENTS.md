## Project overview

- The main application lives in `server/`. It scrapes job listings from jobs.cz, stores them in SQLite, enriches them with AI scoring, exports them to Excel, and syncs the manual `answered` status back to Google Sheets.
- The `mobile/` directory is a separate Expo app. If you edit it, follow the Expo v58 documentation before making code changes.
- Data, prompts, and environment profile files are scoped by `DATASET` (for example `data/default/`, `data/frontend-jobs/`, `prompts/default/`).

## Build, validation, and workflow commands

From `server/`:

- `npm install` — install dependencies.
- `npx tsc --noEmit` — the repo’s quickest compile check; there is no dedicated test or lint script in `package.json`.
- `npm run scrape` — crawl jobs.cz and upsert new jobs into `data/<DATASET>/jobs.sqlite`.
- `npm run processGemini` — score unassessed jobs with Gemini and merge results back by `id`.
- `npm run processGroq` — same flow using Groq/Llama.
- `npm run export` — export the current dataset to `data/<DATASET>/jobs.xlsx`.
- `npm run sync` — import manual `answered` changes from Google Sheets, then rewrite the sheet from SQLite.
- `npm run clean` — delete records whose final source URL returns HTTP 404.
- `npm run dev` — run the project watcher for local development.
- `ENV_FILE=.env.frontend-jobs npm run sync` — sync a non-default dataset profile.

For the Expo app in `mobile/`:

- `cd mobile && npm install`
- `cd mobile && npx expo start`
- `cd mobile && npx tsc --noEmit` — verify TypeScript types in mobile
- Configure `EXPO_PUBLIC_GOOGLE_SHEETS_URL` in `mobile/.env` to point to the deployed Google Apps Script Web App or API.

## High-level architecture

- `server/src/config/loadEnv.ts` loads `.env.secrets` first and then the dataset profile (`.env.default` unless `ENV_FILE` is set), letting profile-specific variables override the shared secrets.
- `server/src/config/paths.ts` validates `DATASET` and exports `DATA_DIR` and `PROMPTS_DIR`; most code should use these resolved paths instead of string literals.
- `server/src/cores/store.ts` is the single source of truth: it creates the SQLite database, upserts scraped job rows and AI summaries by `id`, and keeps `answered` as a boolean-backed integer field.
- `server/src/scraper/scrape.ts` uses Playwright to walk paginated jobs.cz listing pages, skip duplicate ids, and scrape job detail pages. It is intentionally heuristic, because the site markup is unstable.
- `server/src/ai/processJobsGemini.ts` and `server/src/ai/processJobsGroq.ts` read unassessed jobs from SQLite, score them with an LLM, and merge the result back by `id`.
- `server/src/export/exportToExcel.ts` converts the SQLite dataset into a spreadsheet, while `server/src/sync/syncGoogleSheets.ts` ensures `answered` can be managed externally and then refreshed from the database.
- `server/src/index.ts` is still a thin orchestrator stub; the project is intentionally organized around individual scripts rather than a single app entrypoint.

## Key conventions and repo-specific rules

- Treat `DATASET` as the primary scope boundary. All reads and writes should resolve under `data/<DATASET>/` and `prompts/<DATASET>/`; do not hardcode dataset paths.
- Use `id` as the canonical merge key across scraping, AI processing, Excel export, and Google Sheets sync. Re-runs are safe because each step upserts by `id` and skips already-assessed jobs.
- `jobs.sqlite` is the source of truth for all scraped fields and AI results; Google Sheets only owns the `answered` flag, which is imported before the sheet is rewritten from SQLite.
- `jobs.cz` is anti-bot-sensitive. The scraper uses a real headless browser, random delays, and restricted URL assertions; never relax the allowlist casually.
- Expect selector breakage. README notes that job-card extraction is heuristic; if markup changes, refine the selectors in the scraper rather than changing the pipeline contract.
- Keep dataset configuration in `.env` files, not in code. Per-dataset values like `SCRAPE_START_URL`, `MAX_JOBS`, and `MAX_PAGES` are intentionally externalized.
- If you work in `mobile/`, do not assume older Expo APIs—check the versioned Expo v58 docs before editing React Native code.

## Relevant repo notes

- The root README documents the intended pipeline: `scrape -> process -> export`. The scraper intentionally tolerates repeated runs because each step merges data back by `id`.
- There are no repository-level automated tests or lint scripts in the current `package.json` files, so compile checks and focused script runs are the main validation mechanism.
