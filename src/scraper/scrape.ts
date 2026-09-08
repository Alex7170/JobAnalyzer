import "dotenv/config";

import { chromium, type Browser, type Page } from "playwright";
import { writeFile, mkdir } from "node:fs/promises";

import { logger } from "../logger.js";
import { JobListingSchema, type JobListing } from "../types.js";
import { extractJobId, randomDelay, cleanText } from "./utils.js";

const START_URL =
  process.env.SCRAPE_START_URL ??
  "https://www.jobs.cz/prace/programator/";

const MAX_JOBS = Number(process.env.MAX_JOBS ?? 20);

const MIN_DELAY_MS = Number(process.env.MIN_DELAY_MS ?? 1200);
const MAX_DELAY_MS = Number(process.env.MAX_DELAY_MS ?? 3000);

const HEADLESS = (process.env.HEADLESS ?? "true") !== "false";

// jobs.cz robots.txt restrictions.
// We only scrape public listing pages and public job detail pages.
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

  if (
    FORBIDDEN_PATH_PREFIXES.some((prefix) => path.startsWith(prefix))
  ) {
    throw new Error(
      `Refusing to scrape disallowed path per robots.txt: ${path}`,
    );
  }
}

type JobLink = {
  id: string;
  url: string;
  title: string;  
  company: string | null;
  location: string | null;
  salary: string | null;
  postedLabel: string | null;
};

type ScrapedJob = {
  id: string;
  url: string;
  title: string;
  company: string | null;
  location: string | null;
  salary: string | null;
  postedLabel: string | null;
  description: string;
  scrapedAt: string;
};


/**
 * STEP 1
 *
 * Extract job cards from the listing page.
 *
 * We DO NOT open individual job pages here.
 * We only collect:
 * - URL
 * - title
 * - company
 * - location
 * - salary
 * - postedLabel
 */
async function extractJobLinksFromPage(
  page: Page,
): Promise<JobLink[]> {
  const raw = await page.evaluate(() => {
    const cards = Array.from(
      document.querySelectorAll<HTMLElement>(
        "article.SearchResultCard",
      ),
    );

    const results: {
      id: string;
      href: string;
      title: string;
      company: string | null;
      location: string | null;
      salary: string | null;
      postedLabel: string | null;
    }[] = [];

    const seen = new Set<string>();

    for (const card of cards) {
      const link = card.querySelector<HTMLAnchorElement>(
        'a[href*="/rpd/"]',
      );

      if (!link) {
        continue;
      }

      const href = link.href.split("?")[0];

      if (!href || seen.has(href)) {
        continue;
      }

      seen.add(href);

      const title = card.querySelector<HTMLElement>(
          ".SearchResultCard__title",
        )
        ?.innerText
        ?.trim() ?? "";

      if (!title) {
        continue;
      }

      const footerItems = Array.from(
        card.querySelectorAll<HTMLElement>(
          ".SearchResultCard__footerItem",
        ),
      );

      const company = footerItems.find(
          (item) => !item.matches('[data-test="serp-locality"]'),
        )
        ?.innerText
        ?.trim() || null;

      const location = card.querySelector<HTMLElement>(
        '[data-test="serp-locality"]',
        )
        ?.innerText
        ?.trim() || null;

      const postedLabel = card.querySelector<HTMLElement>(
          '[data-test-ad-status]',
        )
        ?.innerText 
        ?.trim() || null;

      const salary = card.querySelector<HTMLElement>(
          ".SearchResultCard__body .Tag--success",
        )
        ?.innerText
        ?.trim() || null;

      results.push({
        id: "",
        href,
        title,
        company,
        location,
        salary,
        postedLabel,
      });
    }

    return results;
  });

  const jobs: JobLink[] = [];

  for (const item of raw) {
    const id = extractJobId(item.href);

    if (!id) {
      continue;
    }

    jobs.push({
      id,
      url: item.href,
      title: item.title,
      company: item.company,
      location: item.location,
      salary: item.salary,
      postedLabel: item.postedLabel,
    });
  }

  return jobs;
}

/**
 * STEP 2
 *
 * Extract job description from an individual detail page.
 *
 * Priority:
 *
 * 1. Rich text:
 *
 *    <div
 *      data-jobad="body"
 *      data-test="jd-body-richtext"
 *      class="RichContent mb-1400"
 *    >
 *
 * 2. If rich text does not exist:
 *    document.body.innerText
 *
 * The result is always plain text.
 */
async function extractJobDescription(
  page: Page,
): Promise<string> {
  const description = await page.evaluate(() => {
    const richText = document.querySelector<HTMLElement>(
      'div[data-jobad="body"][data-test="jd-body-richtext"]',
    );

    if (richText) {
      return richText.innerText;
    }

    // Fallback if rich text container doesn't exist.
    return document.body?.innerText ?? "";
  });

  return cleanText(description);
}

/**
 * STEP 3
 *
 * Open ONE individual job page.
 *
 * Extract:
 * - title
 * - location
 * - salary
 * - description
 */
async function scrapeJobDetail(
  browser: Browser,
  job: JobLink,
): Promise<ScrapedJob | null> {
  assertAllowedUrl(job.url);

  // imitating real browser
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
      "AppleWebKit/537.36 (KHTML, like Gecko) " +
      "Chrome/129.0.0.0 Safari/537.36",

    locale: "cs-CZ",

    viewport: {
      width: 1366,
      height: 900,
    },
  });

  const page = await context.newPage();

  try {
    logger.info(
      {
        id: job.id,
        url: job.url,
      },
      "Opening job detail page",
    );

    await page.goto(job.url, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });

    // Give JS-rendered content some time to appear.
    await page.waitForTimeout(1200);

    
    // Accept cookies if necessary. 
    const cookieButton = page.getByRole("button", {
      name: /souhlas|přijmout|accept/i,
    });

    if (
      await cookieButton
        .first()
        .isVisible()
        .catch(() => false)
    ) {
      await cookieButton
        .first()
        .click()
        .catch(() => {});
    }

    /**
     * Wait for rich text.
     *
     * This is NOT an error if it doesn't appear,
     * because we have the body fallback.
     */
    await page
      .waitForSelector(
        'div[data-jobad="body"][data-test="jd-body-richtext"]',
        {
          timeout: 3_000,
        },
      )
      .catch(() => {
        logger.debug(
          { url: job.url },
          "Rich text container not found, using body fallback",
        );
      });

    /**
     * Get description.
     *
     * Rich text first.
     * Body text if rich text doesn't exist.
     */
    const description = await extractJobDescription(page);

    const candidate: ScrapedJob = {
      id: job.id,
      url: job.url,
      title: job.title,
      company: job.company,
      location: job.location,
      salary: job.salary,
      postedLabel: job.postedLabel,
      description,
      scrapedAt: new Date().toISOString(),
    };
    /**
     * Validate result using your existing Zod schema.
     */
    const parsed =
      JobListingSchema.safeParse(candidate);

    if (!parsed.success) {
      logger.warn(
        {
          candidate,
          issues: parsed.error.issues,
        },
        "Job detail failed schema validation",
      );
    
      return candidate;
    }

    return parsed.data as ScrapedJob;
  } catch (error) {
    logger.error(
      {
        err: error,
        id: job.id,
        url: job.url,
      },
      "Failed to scrape job detail",
    );

    return null;
  } finally {
    await context.close();
  }
}

/**
 * STEP 4
 *
 * Load the listing page and collect job URLs.
 *
 * This function does NOT open individual jobs.
 */
async function scrapeListing(
  browser: Browser,
  url: string,
): Promise<JobLink[]> {
  assertAllowedUrl(url);

  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
      "AppleWebKit/537.36 (KHTML, like Gecko) " +
      "Chrome/129.0.0.0 Safari/537.36",

    locale: "cs-CZ",

    viewport: {
      width: 1366,
      height: 900,
    },
  });

  const page = await context.newPage();

  try {
    logger.info(
      { url },
      "Navigating to jobs listing page",
    );

    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });

    await page.waitForTimeout(1500);

    /**
     * Accept cookies.
     */
    const cookieButton = page.getByRole("button", {
      name: /souhlas|přijmout|accept/i,
    });

    if (
      await cookieButton
        .first()
        .isVisible()
        .catch(() => false)
    ) {
      await cookieButton
        .first()
        .click()
        .catch(() => {});
    }

    /**
     * Wait for job links.
     */
    await page
      .waitForSelector('a[href*="/rpd/"]', {
        timeout: 10_000,
      })
      .catch(() => {
        logger.warn(
          "No job links found on listing page — markup may have changed or page may be blocked",
        );
      });

    /**
     * Extract the job list.
     */
    const jobs =
      await extractJobLinksFromPage(page);

    logger.info(
      { count: jobs.length },
      "Collected job links from listing page",
    );

    return jobs;
  } finally {
    await context.close();
  }
}

/**
 * MAIN PIPELINE
 *
 * 1. Load listing page.
 * 2. Collect all job links.
 * 3. Open every link separately.
 * 4. Extract key values.
 * 5. Save to json
 */
async function main() {
  const browser = await chromium.launch({
    headless: HEADLESS,
  });

  try {
    const jobLinks =
      await scrapeListing(
        browser,
        START_URL,
      );

    const limitedJobs = jobLinks.slice(0, MAX_JOBS);

    logger.info(
      {
        totalFound: jobLinks.length,
        processing: limitedJobs.length,
      },
      "Starting job detail scraping",
    );

    const scrapedJobs: ScrapedJob[] = [];

    for (
      const [index, job]
      of limitedJobs.entries()
    ) {
      logger.info(
        {
          index: index + 1,
          total: limitedJobs.length,
          id: job.id,
          url: job.url,
        },
        "Scraping job detail",
      );

      const result =
        await scrapeJobDetail(
          browser,
          job,
        );

      if (result) {
        scrapedJobs.push(result);
      }

      /**
       * Delay between detail pages.
       */
      if (
        index <
        limitedJobs.length - 1
      ) {
        await randomDelay(
          MIN_DELAY_MS,
          MAX_DELAY_MS,
        );
      }
    }

    logger.info(
      {
        scraped: scrapedJobs.length,
        failed:
          limitedJobs.length -
          scrapedJobs.length,
      },
      "Finished scraping job details",
    );

    // saving final result
    const dataDir = new URL(
      "../../data/",
      import.meta.url,
    );

    await mkdir(dataDir, {
      recursive: true,
    });

    const outPath = new URL(
      "../../data/jobs.json",
      import.meta.url,
    );

    await writeFile(
      outPath,
      JSON.stringify(
        scrapedJobs,
        null,
        2,
      ),
      "utf-8",
    );

    logger.info(
      {
        outPath: outPath.pathname,
      },
      "Saved scraped jobs to disk",
    );
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  logger.error(
    err,
    "Scrape failed",
  );

  process.exit(1);
});