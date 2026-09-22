import "../config/loadEnv.js";
import { readFile } from "node:fs/promises";
import Groq from "groq-sdk";
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

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

type Prompts = {
  systemPrompt: string;
  candidateProfile: string;
  userTemplate: string;
};

async function loadPrompts(): Promise<Prompts> {
  const [systemPrompt, candidateProfile, userTemplate] = await Promise.all([
    readFile(new URL("system.txt", PROMPTS_DIR), "utf-8"),
    readFile(new URL("candidate-profile.txt", PROMPTS_DIR), "utf-8"),
    readFile(new URL("assess-job.cz", PROMPTS_DIR), "utf-8"),
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

async function assessJob(
  job: JobListing,
  prompts: Prompts
): Promise<JobAssessment> {
  const response = await groq.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    temperature: 0,
    max_tokens: 1000,
    response_format: {
      type: "json_object",
    },
    messages: [
      {
        role: "system",
        content: prompts.systemPrompt,
      },
      {
        role: "user",
        content: buildUserMessage(prompts, job),
      },
    ],
  });

  const raw = response.choices[0]?.message?.content ?? "";

  if (!raw.trim()) {
    throw new Error("Groq returned an empty response");
  }

  const cleaned = raw
    .replace(/```json|```/g, "")
    .trim();

  const parsedJson = JSON.parse(cleaned);

  return JobAssessmentSchema.parse({
    ...parsedJson,
    id: job.id,
  });
}

async function main() {
  const prompts = await loadPrompts();

  logger.info(
    { promptsDir: PROMPTS_DIR.pathname },
    "Loaded prompt templates from disk"
  );

  const records = await getAllRecords();

  // Only assess jobs that don't already have an evaluation in the store —
  // re-running this script won't burn API calls re-assessing everything.
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
