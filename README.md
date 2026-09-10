# jobscz-scraper

A small pipeline that scrapes job listings from jobs.cz (Playwright),
scores each one with an AI model, and merges everything into a single
Excel sheet — one row per job, scraped fields and AI verdict together.

```
jobs.cz  →  scrape.ts  →  data/jobs.json  →  AI processors  →  jobs.xlsx
                            (single store,        (Gemini / Grok,
                             keyed by id)           merged back by id)
```

## Install

```bash
npm install
npm run playwright:install   # headless Chromium for Playwright
cp .env.example .env         # then fill in your API key(s) below
```

**Environment variables** (`.env`):

| Variable          | Required | Description                                      |
|-------------------|:--------:|---------------------------------------------------|
| `SCRAPE_START_URL`| yes      | jobs.cz listing URL to start scraping from        |
| `GEMINI_API_KEY`  | for `processGemini` | Google Gemini API key                   |
| `GROQ_API_KEY`    | for `processGroq`   | Groq API key                             |
| `HEADLESS`        | no       | `true`/`false`, run browser headless (default: true) |
| `MIN_DELAY_MS` / `MAX_DELAY_MS` | no | random delay range between requests, for politeness |
| `MAX_JOBS`        | no       | cap on how many listings to scrape per run        |
| `MAX_PAGES`       | no       | cap on how many listing pages (`?page=N`) to walk before stopping, even if `MAX_JOBS` hasn't been reached yet (default: 10) |
| `LOG_LEVEL`       | no       | pino log level (default: `info`)                  |

## Scripts

| Command                | What it does                                                          |
|-------------------------|------------------------------------------------------------------------|
| `npm run scrape`        | Scrapes listings and **upserts** them into `data/jobs.json` by `id`   |
| `npm run processGemini` | Scores unassessed jobs with Gemini, merges results back by `id`       |
| `npm run processGroq`   | Same, using Groq (Llama) instead of Gemini                            |
| `npm run export`        | Reads the store and writes `data/jobs.xlsx` with all fields           |
| `npm run dev`           | Runs `src/index.ts` in watch mode                                     |

Run them in order: `scrape` → `processGemini` and/or `processGroq` → `export`.
Re-running `scrape` or a process script is safe — everything merges into
the same record by `id`, and already-assessed jobs are skipped.

## Pagination

`scrape.ts` walks listing pages (`?page=2`, `?page=3`, ...) starting from
`SCRAPE_START_URL`, collecting job links page by page until either:

- it has collected `MAX_JOBS` unique job links, or
- a page comes back with zero job links (end of results), or
- it hits the `MAX_PAGES` safety cap (guards against an infinite loop if
  the site's markup changes and "no more jobs" is never detected).

Before opening any detail page, it also checks `data/jobs.json` and skips
ids that are already in the store — a re-run only spends time and
requests scraping jobs it hasn't seen before.

## robots.txt / anti-bot notes

`jobs.cz/robots.txt` allows `/prace/` (listing pages) and `/rpd/` (job
detail pages) — the only paths the scraper touches. `/muj/`, `/api/`,
`/iapi/`, `/asmt/`, `/status/`, `/translations/`, `/js/`,
`/nabidky-podle-cv/`, and `/session-log/` are disallowed; `scrape.ts`
guards this with `assertAllowedUrl`, which throws if a disallowed URL
ever ends up in `.env`.

Separately, the site appears to also rate-limit / fingerprint at the
network level (third-party scrapers report datacenter-proxy blocks), so:

- a real headless browser is used, not a bare `fetch`;
- requests are spaced out via `MIN_DELAY_MS` / `MAX_DELAY_MS` (this now
  also applies between listing pages, not just detail pages);
- avoid pushing `MAX_JOBS` into the hundreds or running many tabs in parallel.

## Markup is unstable — expect to tweak selectors

jobs.cz's markup isn't documented, so `extractJobsFromPage` in
`src/scraper/scrape.ts` finds cards heuristically: it looks for links
matching `/rpd/{id}/` and pulls company/location/salary from the
surrounding block's text. That's a working starting point, but if it
breaks:

1. Set `HEADLESS=false` in `.env` and run `npm run scrape` to watch the browser.
2. Open the same page in Chrome DevTools → Elements and find one job
   card's container (usually an `<article>` or `<li>` with a `data-*` attribute).
3. Replace the heuristic (`container.parentElement` walk + text parsing)
   with exact selectors for that container.

## Project structure

```
src/
  types.ts                  # zod schemas: JobListing, JobAssessment, JobRecord
  store.ts                  # single read/write layer for data/jobs.json,
                             #   merges scraped + AI data by id, queues
                             #   read-modify-write calls so concurrent
                             #   upserts don't race and corrupt the file
  logger.ts                 # pino logger
  scraper/
    scrape.ts                # Playwright: paginates listing pages, skips
                              #   ids already in the store, then scrapes
                              #   detail pages -> upsertScraped()
    utils.ts                 # extractJobId, randomDelay, cleanText
  ai/
    processJobsGemini.ts      # Gemini: unassessed jobs -> upsertAssessment()
    processJobsGrok.ts        # Groq (Llama): same, different provider
  export/
    exportToExcel.ts          # store -> data/jobs.xlsx (all fields)
  index.ts                   # orchestrator stub

data/
  jobs.json                 # single source of truth — one record per job,
                             #   scraped fields + AI verdict merged by id
  jobs.xlsx                 # generated by `npm run export`
```

## Next steps

- **Automatic replies** — for jobs where `evaluation` clears the reply
  threshold and `answer` is filled in, send it out automatically
  (email/contact form) instead of copying it by hand.
- **Scheduling** — `node-cron` (or a system cron job) to run
  `scrape` → `processGemini`/`processGroq` → `export` periodically.
- **Move off flat JSON** — if the store grows large, `better-sqlite3`
  with a `jobs` table (`id` as primary key, `UPDATE ... WHERE id = ?`)
  would avoid reading/rewriting the whole file on every upsert.
- **Delete expired vacancies** - Delete already used or bad `(evaluate<4)`
  vacancies.