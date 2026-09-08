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
export const JobAssessmentSchema = z.object({
  jobId: z.string(),
  assessment: z.object({
    relevant: z.boolean(),
    matchScore: z.number().min(0).max(100),
    summary: z.string(),
    reasoning: z.string(),
  }),
  reply: z.object({
    shouldReply: z.boolean(),
    text: z.string().nullable(),
  }),
});

export type JobAssessment = z.infer<typeof JobAssessmentSchema>;