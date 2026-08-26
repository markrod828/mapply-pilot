import {
  DEFAULT_SETTINGS,
  DEFAULT_TAILOR_OPTIONS,
  EMPTY_PROFILE,
  type AtsScore,
  type JobRecord,
  type Profile,
  type ResumeDoc,
  type Settings,
  type TailoredResume,
} from './types';
import { parseStructured, renderResumeText } from './tailor';

const KEYS = {
  settings: 'settings',
  profile: 'profile',
  resume: 'resume',
  jobs: 'jobs',
  activeJobKey: 'activeJobKey',
} as const;

async function read<T>(key: string, fallback: T): Promise<T> {
  const stored = await chrome.storage.local.get(key);
  return (stored[key] as T | undefined) ?? fallback;
}

export async function getSettings(): Promise<Settings> {
  return { ...DEFAULT_SETTINGS, ...(await read<Partial<Settings>>(KEYS.settings, {})) };
}

export async function setSettings(settings: Settings): Promise<void> {
  await chrome.storage.local.set({ [KEYS.settings]: settings });
}

export async function getProfile(): Promise<Profile> {
  return { ...EMPTY_PROFILE, ...(await read<Partial<Profile>>(KEYS.profile, {})) };
}

export async function setProfile(profile: Profile): Promise<void> {
  await chrome.storage.local.set({ [KEYS.profile]: profile });
}

export async function getResume(): Promise<ResumeDoc | null> {
  return read<ResumeDoc | null>(KEYS.resume, null);
}

export async function setResume(resume: ResumeDoc | null): Promise<void> {
  await chrome.storage.local.set({ [KEYS.resume]: resume });
}

export async function getJobs(): Promise<Record<string, JobRecord>> {
  const jobs = await read<Record<string, JobRecord>>(KEYS.jobs, {});
  return Object.fromEntries(
    Object.entries(jobs).map(([key, record]) => [key, normalizeRecord(record)]),
  );
}

/** Records saved by older versions are missing newer fields; fill them in on read. */
function normalizeRecord(record: JobRecord): JobRecord {
  return {
    ...record,
    baseScore: record.baseScore && normalizeScore(record.baseScore),
    tailoredScore: record.tailoredScore && normalizeScore(record.tailoredScore),
    tailored: record.tailored && normalizeTailored(record.tailored),
  };
}

function normalizeScore(score: AtsScore): AtsScore {
  const matchedKeywords = score.matchedKeywords ?? [];
  const missingKeywords = score.missingKeywords ?? [];
  return {
    ...score,
    matchedKeywords,
    missingKeywords,
    mustHaveGaps: score.mustHaveGaps ?? [],
    comparison: score.comparison ?? [],
    summaryVerdict: score.summaryVerdict ?? '',
    keywords:
      score.keywords ??
      [
        ...matchedKeywords.map((term) => ({ term, category: 'Other', present: true })),
        ...missingKeywords.map((term) => ({ term, category: 'Other', present: false })),
      ],
  };
}

function normalizeTailored(tailored: TailoredResume): TailoredResume {
  const structured = parseStructured(tailored);
  const options = tailored.options ?? DEFAULT_TAILOR_OPTIONS;
  const text = tailored.text || renderResumeText(structured);

  return {
    ...tailored,
    ...structured,
    text,
    changeNotes: tailored.changeNotes ?? [],
    addedKeywords: tailored.addedKeywords ?? [],
    omittedKeywords: tailored.omittedKeywords ?? [],
    refinements: tailored.refinements ?? [],
    options,
    stats: tailored.stats ?? { summaryUpdated: false, bulletsRewritten: 0, skillsAdded: 0 },
  };
}

export async function getJob(jobKey: string): Promise<JobRecord | undefined> {
  return (await getJobs())[jobKey];
}

export async function saveJob(record: JobRecord): Promise<void> {
  const jobs = await getJobs();
  jobs[record.job.jobKey] = record;
  await chrome.storage.local.set({ [KEYS.jobs]: pruneJobs(jobs, record.job.jobKey) });
}

export async function updateJob(
  jobKey: string,
  update: (record: JobRecord) => JobRecord,
): Promise<JobRecord | undefined> {
  const jobs = await getJobs();
  const existing = jobs[jobKey];
  if (!existing) return undefined;
  const next = update(existing);
  jobs[jobKey] = next;
  await chrome.storage.local.set({ [KEYS.jobs]: pruneJobs(jobs, jobKey) });
  return next;
}

const MAX_JOBS = 50;

/**
 * Keep storage bounded: retain the most recently captured jobs. `keepKey` is the
 * record the caller just wrote, which must survive even when it is an old capture
 * the user has come back to.
 */
function pruneJobs(jobs: Record<string, JobRecord>, keepKey: string): Record<string, JobRecord> {
  const entries = Object.entries(jobs);
  if (entries.length <= MAX_JOBS) return jobs;

  entries.sort((a, b) => b[1].job.capturedAt - a[1].job.capturedAt);
  const kept = entries.slice(0, MAX_JOBS);
  if (jobs[keepKey] && !kept.some(([key]) => key === keepKey)) {
    kept[kept.length - 1] = [keepKey, jobs[keepKey]];
  }
  return Object.fromEntries(kept);
}

export async function getActiveJobKey(): Promise<string | null> {
  return read<string | null>(KEYS.activeJobKey, null);
}

export async function setActiveJobKey(jobKey: string | null): Promise<void> {
  await chrome.storage.local.set({ [KEYS.activeJobKey]: jobKey });
}

export async function getActiveJob(): Promise<JobRecord | null> {
  const key = await getActiveJobKey();
  if (!key) return null;
  return (await getJob(key)) ?? null;
}

export function onStorageChanged(listener: () => void): () => void {
  const handler = (_changes: unknown, areaName: string) => {
    if (areaName === 'local') listener();
  };
  chrome.storage.onChanged.addListener(handler);
  return () => chrome.storage.onChanged.removeListener(handler);
}

/** Stable, cheap hash used to invalidate cached scores when the resume changes. */
export function hashText(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}
