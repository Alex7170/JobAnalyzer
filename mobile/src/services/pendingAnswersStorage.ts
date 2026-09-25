import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY = '@job-analyzer/pending-answers';
const EXPIRY_MS = 24 * 60 * 60 * 1000;

interface StoredAnswer {
  answer: string;
  savedAt: number;
}

type StoredAnswers = Record<string, StoredAnswer>;

async function readStoredAnswers(): Promise<StoredAnswers> {
  const raw = await AsyncStorage.getItem(STORAGE_KEY);
  if (!raw) return {};

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as StoredAnswers;
  } catch (error) {
    console.warn('Failed to parse pending answers from storage:', error);
    return {};
  }
}

async function writeStoredAnswers(answers: StoredAnswers): Promise<void> {
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(answers));
}

async function removeExpiredAnswers(answers: StoredAnswers): Promise<StoredAnswers> {
  const now = Date.now();
  const activeAnswers = Object.fromEntries(
    Object.entries(answers).filter(([, entry]) =>
      entry &&
      typeof entry.answer === 'string' &&
      typeof entry.savedAt === 'number' &&
      now - entry.savedAt < EXPIRY_MS
    )
  );

  if (Object.keys(activeAnswers).length !== Object.keys(answers).length) {
    await writeStoredAnswers(activeAnswers);
  }
  return activeAnswers;
}

export async function getPendingAnswers(): Promise<Record<string, string>> {
  const activeAnswers = await removeExpiredAnswers(await readStoredAnswers());
  return Object.fromEntries(
    Object.entries(activeAnswers).map(([jobId, entry]) => [jobId, entry.answer])
  );
}

export async function savePendingAnswer(jobId: string, answer: string): Promise<void> {
  const answers = await removeExpiredAnswers(await readStoredAnswers());
  const trimmedAnswer = answer.trim();

  if (!trimmedAnswer) {
    delete answers[jobId];
  } else {
    answers[jobId] = { answer, savedAt: Date.now() };
  }

  await writeStoredAnswers(answers);
}

export async function removePendingAnswer(jobId: string): Promise<void> {
  const answers = await removeExpiredAnswers(await readStoredAnswers());
  delete answers[jobId];
  await writeStoredAnswers(answers);
}
