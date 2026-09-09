import { z } from "zod";

// Raw shape we pull out of the DOM. Keep this loose/nullable —
// jobs.cz markup varies between "classic" and "widget" pages,
// and fields are frequently missing (salary, etc).
export const JobListingSchema = z.object({
  id: z.string(), // numeric id parsed out of the /rpd/{id}/ url
  url: z.string().url(),
  title: z.string(),
  company: z.string().nullable(),
  location: z.string().nullable(),
  salary: z.string().nullable(),
  postedLabel: z.string().nullable(), // e.g. "Přidáno dnes"
  scrapedAt: z.string(), // ISO timestamp 
  description: z.string()
});

export type JobListing = z.infer<typeof JobListingSchema>;

// What we ask Claude to produce for each job listing. Split into two
// explicit sub-objects so "is this a good fit" and "what to reply" stay
// clearly separate, both in the JSON shape and wherever we display it later.
export const REPLY_THRESHOLD = 7;

export const JobAssessmentSchema = z
  .object({
    id: z.string(),
    summary: z.string(),
    evaluation: z.number().int().min(0).max(10),
    answer: z.string().nullable(),
  })
  .refine(
    (data) =>
      data.evaluation < REPLY_THRESHOLD ||
      (data.answer !== null && data.answer.trim().length > 0),
    {
      message: `answer must be a non-empty string when evaluation >= ${REPLY_THRESHOLD}`,
      path: ["answer"],
    },
  );

export type JobAssessment = z.infer<typeof JobAssessmentSchema>;

export type JobRecord = JobListing & Partial<Omit<JobAssessment, "id">>;