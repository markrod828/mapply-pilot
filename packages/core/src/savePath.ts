import type { JobPosting, Profile } from './types';

/** Characters no file system accepts. Hyphens, commas and spaces are legal and kept. */
const ILLEGAL = new RegExp('[<>:"/\\\\|?*\\u0000-\\u001f]', 'g');
const MAX_SEGMENT = 60;

/**
 * Where a tailored resume is filed: `resumes/{company}/{job title}/{full name}.pdf`.
 * Returned as segments so the caller can join them for a download or walk them as
 * real directories.
 */
export function resumeSavePath(profile: Profile, job: Pick<JobPosting, 'company' | 'title'>): string[] {
  const fullName = `${profile.firstName} ${profile.lastName}`.trim();
  return [
    'resumes',
    sanitizeSegment(job.company, 'Unknown company'),
    sanitizeSegment(job.title, 'Unknown role'),
    `${sanitizeSegment(fullName, 'Resume')}.pdf`,
  ];
}

/** Strip anything a file system will not take, and never return an empty name. */
export function sanitizeSegment(value: string, fallback: string): string {
  const clean = value
    .replace(ILLEGAL, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_SEGMENT)
    // Windows silently drops trailing dots and spaces, which would break the path.
    .replace(/[. ]+$/, '');
  return clean || fallback;
}
