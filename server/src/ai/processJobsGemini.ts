import { readFile } from "node:fs/promises";
import { GoogleGenAI } from "@google/genai";
import pLimit from "p-limit";
import { logger } from "../utils/logger.js";
import {
  JobAssessmentSchema,
  JobListingSchema,
  type JobAssessment,
  type JobListing,
} from "../cores/types.js";
import { getAllRecords, upsertAssessment } from "../cores/store.js";
import { DATA_DIR, PROMPTS_DIR } from "../config/paths.js";

const genAI = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
});

const MAX_RETRIES = 5;
const INITIAL_RETRY_DELAY = 10_000;

type Prompts = {
  systemPrompt: string;
  candidateProfile: string;
  userTemplate: string;
};

async function loadPrompts(): Promise<Prompts> {
  const [systemPrompt, candidateProfile, userTemplate] = await Promise.all([
    readFile(new URL("system.txt", PROMPTS_DIR), "utf-8"),
    readFile(new URL("candidate-profile.txt", PROMPTS_DIR), "utf-8"),
    readFile(new URL("assess-job.txt", PROMPTS_DIR), "utf-8"),
  ]);

  return {
    systemPrompt: systemPrompt.trim(),
    candidateProfile: candidateProfile.trim(),
    userTemplate,
  };
}

function buildUserMessage(prompts: Prompts, job: JobListing): string {
  return prompts.userTemplate
    .replaceAll("{{CANDIDATE_PROFILE}}", prompts.candidateProfile)
    .replaceAll("{{JOB_JSON}}", JSON.stringify(job, null, 2));
}

function getErrorStatus(err: unknown): number | undefined {
  if (
    typeof err === "object" &&
    err !== null &&
    "status" in err
  ) {
    const status = (err as { status: unknown }).status;

    if (typeof status === "number") {
      return status;
    }
  }

  return undefined;
}

function isRetryableError(err: unknown): boolean {
  const status = getErrorStatus(err);
  return (
    status === 429 ||
    status === 500 ||
    status === 503
  );
}

function getRetryDelay(attempt: number): number {
  return Math.min(
    INITIAL_RETRY_DELAY * 2 ** attempt,
    60_000
  );
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function assessJob(
  job: JobListing,
  prompts: Prompts
): Promise<JobAssessment> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await genAI.models.generateContent({
        model: "gemini-3.1-flash-lite",

        config: {
          temperature: 0,
          maxOutputTokens: 1000,
          responseMimeType: "application/json",
          systemInstruction: prompts.systemPrompt,
        },

        contents: [
          {
            role: "user",
            parts: [
              {
                text: buildUserMessage(prompts, job),
              },
            ],
          },
        ],
      });

      const raw = response.text ?? "";

      if (!raw.trim()) {
        throw new Error("Gemini returned an empty response");
      }

      const cleaned = raw
        .replace(/```json|```/g, "")
        .trim();

      const parsedJson = JSON.parse(cleaned);

      return JobAssessmentSchema.parse({
        ...parsedJson,
        id: job.id,
      });
    } catch (err) {
      const status = getErrorStatus(err);

      logger.error(
        {
          err,
          id: job.id,
          status,
          attempt: attempt + 1,
        },
        "Gemini request failed"
      );

      if (
        isRetryableError(err) &&
        attempt < MAX_RETRIES
      ) {
        const delay = getRetryDelay(attempt);

        logger.warn(
          {
            id: job.id,
            status,
            retryInSeconds: delay / 1000,
            nextAttempt: attempt + 2,
          },
          "Retryable Gemini error, waiting before retry"
        );

        await wait(delay);

        continue;
      }

      throw err;
    }
  }

  throw new Error(
    `Failed to assess job ${job.id} after ${MAX_RETRIES + 1} attempts`
  );
}

async function main() {
  const prompts = await loadPrompts();

  logger.info(
    { promptsDir: PROMPTS_DIR.pathname },
    "Loaded prompt templates from disk"
  );

  const records = await getAllRecords();

  const jobs: JobListing[] = records
    .filter((r) => r.status === "SCRAPED" && r.evaluation === undefined)
    .map((r) => JobListingSchema.parse(r));

  logger.info(
    { count: jobs.length, skipped: records.length - jobs.length },
    "Loaded jobs for processing"
  );

  const limit = pLimit(3);

  await Promise.all(
    jobs.map((job) =>
      limit(async () => {
        try {
          const assessment = await assessJob(job, prompts);

          await upsertAssessment(assessment);

          logger.info(
            {
              title: job.title,
              evaluation: assessment.evaluation,
            },
            "Assessed job"
          );
        } catch (err) {
          logger.error(
            { err, id: job.id },
            "Failed to assess job"
          );
        }
      })
    )
  );

  logger.info(
    { dataPath: new URL("jobs.sqlite", DATA_DIR).pathname },
    "Assessments merged into SQLite store"
  );
}

main().catch((err) => {
  logger.error(err, "Processing failed");
  process.exit(1);
});
