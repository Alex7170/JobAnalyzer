import "dotenv/config";
import { readFile, writeFile } from "node:fs/promises";
import Groq from "groq-sdk";
import pLimit from "p-limit";
import { logger } from "../logger.js";
import {
  JobAssessmentSchema,
  JobListingSchema,
  type JobAssessment,
  type JobListing,
} from "../types.js";

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

const PROMPTS_DIR = new URL("../../prompts/", import.meta.url);

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
    jobId: job.id,
  });
}

async function main() {
  const prompts = await loadPrompts();

  logger.info(
    { promptsDir: PROMPTS_DIR.pathname },
    "Loaded prompt templates from disk"
  );

  const dataPath = new URL("../../data/jobs.json", import.meta.url);

  const raw = await readFile(dataPath, "utf-8");

  const jobs = JobListingSchema.array().parse(JSON.parse(raw));

  logger.info(
    { count: jobs.length },
    "Loaded jobs for processing"
  );

  const limit = pLimit(3);

  const assessments: JobAssessment[] = [];

  await Promise.all(
    jobs.map((job) =>
      limit(async () => {
        try {
          const assessment = await assessJob(job, prompts);

          assessments.push(assessment);

          logger.info(
            {
              title: job.title,
              evaluation: assessment.evaluation,
            },
            "Assessed job"
          );
        } catch (err) {
          logger.error(
            { err, jobId: job.id },
            "Failed to assess job"
          );
        }
      })
    )
  );

  const outPath = new URL(
    "../../data/assessments.json",
    import.meta.url
  );

  await writeFile(
    outPath,
    JSON.stringify(assessments, null, 2),
    "utf-8"
  );

  logger.info(
    {
      outPath: outPath.pathname,
      count: assessments.length,
    },
    "Saved assessments"
  );
}

main().catch((err) => {
  logger.error(err, "Processing failed");
  process.exit(1);
});
