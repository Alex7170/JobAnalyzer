import { GOOGLE_SHEETS_CONFIG } from '../config/googleSheets';
import type { JobCardData, JobStatus } from '../components/JobCard';

export interface FetchVacanciesResult {
  jobs: JobCardData[];
  isFallback: boolean;
  message?: string;
}

function normalizeJobItem(raw: Record<string, unknown>): JobCardData | null {
  if (!raw || typeof raw !== 'object') return null;

  const id = raw.id != null ? String(raw.id).trim() : '';
  const rawStatus = String(raw.status || 'ANALYZED').trim().toUpperCase();
  const validStatuses: JobStatus[] = ['SCRAPED', 'ANALYZED', 'APPROVED', 'SKIPPED', 'ANSWERED'];
  const status: JobStatus = validStatuses.includes(rawStatus as JobStatus)
    ? (rawStatus as JobStatus)
    : 'ANALYZED';

  const evaluation =
    typeof raw.evaluation === 'number'
      ? raw.evaluation
      : Number.parseInt(String(raw.evaluation ?? '0'), 10) || 0;

  return {
    id: id || undefined,
    url: raw.url ? String(raw.url) : undefined,
    title: String(raw.title || '').trim(),
    company: String(raw.company || '').trim(),
    location: String(raw.location || '').trim(),
    salary: raw.salary != null ? String(raw.salary) : null,
    postedLabel: raw.postedLabel != null ? String(raw.postedLabel) : null,
    scrapedAt: raw.scrapedAt != null ? String(raw.scrapedAt) : undefined,
    description: String(raw.description || '').trim(),
    summary: String(raw.summary || '').trim(),
    answer: String(raw.answer || '').trim(),
    status,
    evaluation,
  };
}

/**
 * Parses response from Google Sheets server.
 * Expects a flat JSON array of objects: [{ id, title, status, ... }, ...],
 * or a 2D array with the header row first (rare — kept as a fallback).
 */
function parseServerResponse(data: unknown): JobCardData[] {
  if (!Array.isArray(data) || data.length === 0) return [];

  if (Array.isArray(data[0])) {
    const headers = (data[0] as unknown[]).map((h) => String(h || '').trim());
    const rows = data.slice(1) as unknown[][];
    return rows
      .map((row) => {
        const item: Record<string, unknown> = {};
        headers.forEach((key, idx) => {
          if (key) item[key] = row[idx];
        });
        return normalizeJobItem(item);
      })
      .filter((item): item is JobCardData => item !== null);
  }

  return (data as Record<string, unknown>[])
    .map(normalizeJobItem)
    .filter((item): item is JobCardData => item !== null);
}

/**
 * Filter for "new" job vacancies that need user review.
 */
export function filterNewVacancies(jobs: JobCardData[]): JobCardData[] {
  return jobs.filter((job) => job.status === 'ANALYZED' || job.status === 'SCRAPED');
}

/**
 * Requests new job vacancies data in JSON from the Google Sheets server.
 */
export async function fetchNewJobVacancies(): Promise<FetchVacanciesResult> {
  try {
    const url = new URL(GOOGLE_SHEETS_CONFIG.apiUrl);
    if (!url.searchParams.has('status')) {
      url.searchParams.set('status', 'ANALYZED');
    }
    if (!url.searchParams.has('sheet') && GOOGLE_SHEETS_CONFIG.sheetName) {
      url.searchParams.set('sheet', GOOGLE_SHEETS_CONFIG.sheetName);
    }

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });

    if (!response.ok) {
      throw new Error(`Google Sheets server returned HTTP ${response.status}: ${response.statusText}`);
    }

    const json = await response.json();
    const parsedJobs = parseServerResponse(json);
    const newVacancies = filterNewVacancies(parsedJobs);

    return {
      jobs: newVacancies.length > 0 ? newVacancies : parsedJobs,
      isFallback: false,
    };
  } catch (error) {
    console.warn('Failed to fetch from Google Sheets server:', error);
    return {
      jobs: [],
      isFallback: true,
      message: (error as Error).message,
    };
  }
}

/**
 * Sends a status update for a single job vacancy to the Google Sheets
 * server. Shared by approve/reject so both stay in sync with the same
 * request shape (and the same spreadsheet tab).
 */
export async function updateJobStatus(
  jobId: string,
  status: JobStatus,
  answer?: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const response = await fetch(GOOGLE_SHEETS_CONFIG.apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: status === 'APPROVED' ? 'approve' : 'reject',
        id: jobId,
        status,
        answer: answer ?? null,
        // Which spreadsheet tab to write to — set via EXPO_PUBLIC_GOOGLE_SHEETS_TAB
        // in .env.default / .env.noit (see config/googleSheets.ts).
        sheet: GOOGLE_SHEETS_CONFIG.sheetName || undefined,
      }),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return { success: true };
  } catch (err) {
    console.warn(`Failed to sync status ${status} for job ${jobId} to Google Sheets:`, err);
    return { success: false, error: (err as Error).message };
  }
}

export async function approveJobVacancy(
  jobId: string,
  answer: string
): Promise<{ success: boolean; error?: string }> {
  return updateJobStatus(jobId, 'APPROVED', answer);
}

export async function rejectJobVacancy(
  jobId: string
): Promise<{ success: boolean; error?: string }> {
  return updateJobStatus(jobId, 'SKIPPED');
}