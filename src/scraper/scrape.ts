import "dotenv/config";
import { chromium, type Browser, type Page } from "playwright";
import { writeFile, mkdir } from "node:fs/promises";
import { logger } from "../logger.js";
import { JobListingSchema, type JobListing } from "../types.js";
import { extractJobId, randomDelay } from "./utils.js";

const START_URL =
  process.env.SCRAPE_START_URL ?? "https://www.jobs.cz/prace/programator/";
const MAX_JOBS = Number(process.env.MAX_JOBS ?? 20);
const MIN_DELAY_MS = Number(process.env.MIN_DELAY_MS ?? 1200);
const MAX_DELAY_MS = Number(process.env.MAX_DELAY_MS ?? 3000);
const HEADLESS = (process.env.HEADLESS ?? "true") !== "false";

// jobs.cz robots.txt (checked manually) disallows /muj/, /asmt/, /api/, /iapi/,
// /status/, /translations/, /js/, /nabidky-podle-cv/, /session-log/ and a couple
// of parameterised urls. It does NOT disallow /prace/ (listings) or /rpd/ (job
// detail pages) — that's what this scraper touches. Keep it that way: don't
// point this at /api/ or /iapi/ even if you spot them in devtools.
const FORBIDDEN_PATH_PREFIXES = [
  "/muj/",
  "/asmt/",
  "/api/",
  "/iapi/",
  "/status/",
  "/translations/",
  "/js/",
  "/nabidky-podle-cv/",
  "/session-log/",
];

function assertAllowedUrl(url: string): void {
  const path = new URL(url).pathname;
  if (FORBIDDEN_PATH_PREFIXES.some((prefix) => path.startsWith(prefix))) {
    throw new Error(`Refusing to scrape disallowed path per robots.txt: ${path}`);
  }
}

/**
 * Extracts job cards from a jobs.cz listing page.
 *
 * NOTE: jobs.cz's markup isn't stable/documented, so this uses a heuristic:
 * find every link to a job detail page (/rpd/{id}/), then walk up a few
 * parent elements to grab the surrounding card's text for company/location/
 * salary. If this comes back empty or noisy, open devtools on a real listing
 * page and replace the selectors below with the actual card container
 * (e.g. `article[data-...]`) — this is the one part of the project you'll
 * likely need to tune by hand as the site changes.
 */
async function extractJobsFromPage(page: Page): Promise<JobListing[]> {
  const raw = await page.evaluate(() => {
    const anchors = Array.from(
      document.querySelectorAll<HTMLAnchorElement>('a[href*="/rpd/"]')
    );

    const seen = new Set<string>();
    const results: {
      href: string;
      title: string;
      cardText: string;
    }[] = [];

    for (const anchor of anchors) {
      const href = anchor.href;
      if (seen.has(href)) continue;
      seen.add(href);

      const title = anchor.textContent?.trim() ?? "";
      if (!title) continue; // skip icon-only / duplicate wrapper links 

      // TODO   fix finfing the best container for parsing context if needed
      // Walk up to find a reasonably sized card container for context text.
      let container: HTMLElement | null = anchor;
      for (let i = 0; i < 4 && container?.parentElement; i++) {
        container = container.parentElement;
      }
      const cardText = container?.innerText?.trim() ?? "";

      results.push({ href, title, cardText });
    }

    return results;
  });

  const now = new Date().toISOString();
  const jobs: JobListing[] = [];

  for (const item of raw) {
    const id = extractJobId(item.href);
    if (!id) continue;

    const lines = item.cardText
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);

    // TODO fix finding key values in rows
    const salary = lines.find((l) => /K[čc]|EUR|CZK/.test(l)) ?? null;
    const posted = lines.find((l) => /^(Přidáno|Aktualizováno)/.test(l)) ?? null;
    // Company/location are usually the two short lines right after the title,
    // often preceded by bullet markers in rendered text.
    const titleIdx = lines.findIndex((l) => l === item.title);
    const company = titleIdx >= 0 ? lines[titleIdx + 1] ?? null : null;
    const location = titleIdx >= 0 ? lines[titleIdx + 2] ?? null : null;

    const candidate = {
      id,
      url: item.href.split("?")[0],
      title: item.title,
      company,
      location,
      salary,
      postedLabel: posted,
      scrapedAt: now,
    };

    const parsed = JobListingSchema.safeParse(candidate);
    if (parsed.success) {
      jobs.push(parsed.data);
    } else {
      logger.warn({ candidate, issues: parsed.error.issues }, "Skipping malformed job card");
    }
  }

  return jobs;
}

async function scrapeListing(browser: Browser, url: string): Promise<JobListing[]> {
  assertAllowedUrl(url);

  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
    locale: "cs-CZ",
    viewport: { width: 1366, height: 900 },
  });
  const page = await context.newPage();

  logger.info({ url }, "Navigating to listing page");
  await page.goto(url, { waitUntil: "domcontentloaded" });

  // waiting for page to render some time
  await page.waitForTimeout(1500); 

  // TODO   fix cookie acception button if needed 
  const cookieButton = page.getByRole("button", { name: /souhlas|přijmout|accept/i });
  if (await cookieButton.first().isVisible().catch(() => false)) {
    await cookieButton.first().click().catch(() => {});
  }

  await page.waitForSelector('a[href*="/rpd/"]', { timeout: 10_000 }).catch(() => {
    logger.warn("No job links found on page — site markup may have changed, or the page was blocked");
  });

  const jobs = await extractJobsFromPage(page);
  await context.close();
  return jobs;
}

async function main() {
  const browser = await chromium.launch({ headless: HEADLESS });

  try {
    const jobs = await scrapeListing(browser, START_URL);
    const limited = jobs.slice(0, MAX_JOBS);

    logger.info({ count: limited.length }, "Scraped jobs");

    await mkdir(new URL("../../data/", import.meta.url), { recursive: true });
    const outPath = new URL("../../data/jobs.json", import.meta.url);
    await writeFile(outPath, JSON.stringify(limited, null, 2), "utf-8");
    logger.info({ outPath: outPath.pathname }, "Saved jobs to disk");

    // Being polite: even though we only load one listing page per run right
    // now, keep this delay here for when you extend to multiple pages/detail
    // pages — don't hammer the site in a tight loop.
    await randomDelay(MIN_DELAY_MS, MAX_DELAY_MS);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  logger.error(err, "Scrape failed");
  process.exit(1);
});
