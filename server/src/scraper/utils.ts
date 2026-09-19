export function randomDelay(minMs: number, maxMs: number): Promise<void> {
  const ms = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function extractJobId(url: string): string | null {
  // matches https://www.jobs.cz/rpd/2001279170/ (with or without query string)
  const match = url.match(/\/rpd\/(\d+)/);
  return match ? match[1] : null;
}

/**
 * Function for cleaning text.
 * Deleting space which is not needed in final description
 */
export function cleanText(text: string): string {
  return text
    .replace(/\u00a0/g, " ")
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}