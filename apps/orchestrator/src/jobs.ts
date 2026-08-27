import { createHash } from 'node:crypto';
import type { JobPosting } from '@mapply/core';
import type { Store } from '@mapply/db';

export interface JobInput {
  source: 'jobright' | 'url';
  sourceId: string;
  url: string;
  applyUrl?: string;
  atsKind?: string;
  title: string;
  company: string;
  location?: string;
  description?: string;
}

export interface StoredJob {
  id: number;
  posting: JobPosting;
  isNew: boolean;
}

/**
 * Strips a name down to what makes it the same name.
 *
 * Suffixes and punctuation are noise for matching - "Acme, Inc." and "Acme" are
 * one company - and keeping them would let the same posting through twice under
 * two spellings.
 */
export function keyOf(value: string): string {
  return value
    .toLowerCase()
    .replace(/\b(inc|llc|ltd|corp|co|gmbh|plc)\b\.?/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * The part of a job title that identifies the role.
 *
 * Employers relist the same job with the location, a requisition number or a
 * seniority marker bolted on. Those come off before comparing.
 */
export function titleKeyOf(title: string): string {
  return keyOf(
    title
      .replace(/\(([^)]*(remote|hybrid|onsite|on-site|contract|us|usa)[^)]*)\)/gi, ' ')
      .replace(/[-–—]\s*(remote|hybrid|onsite|us|usa|united states)\b.*$/i, ' ')
      .replace(/#\s*\w+/g, ' ')
      .replace(/\b(i{1,3}|iv|v)\b/gi, ' '),
  );
}

export function jobHash(company: string, title: string, location: string): string {
  return createHash('sha1')
    .update(`${keyOf(company)}|${titleKeyOf(title)}|${keyOf(location)}`)
    .digest('hex');
}

/**
 * Records a posting, reusing the row when it has been seen before.
 *
 * Two guards, deliberately different. The unique index on (source, source_id)
 * stops the same listing being stored twice; the job hash catches the same role
 * relisted under a new id, which is what actually causes duplicate applications.
 */
export function upsertJob(store: Store, input: JobInput): StoredJob {
  const now = Date.now();
  const hash = jobHash(input.company, input.title, input.location ?? '');

  const existing = store.sqlite
    .prepare('SELECT * FROM jobs WHERE source = ? AND source_id = ?')
    .get(input.source, input.sourceId) as Record<string, unknown> | undefined;

  const row =
    existing ??
    (store.sqlite
      .prepare(
        `INSERT INTO jobs (source, source_id, job_hash, url, apply_url, ats_kind,
                           company, company_key, title, title_key, location, description, discovered_at)
         VALUES (@source, @sourceId, @hash, @url, @applyUrl, @atsKind,
                 @company, @companyKey, @title, @titleKey, @location, @description, @now)
         RETURNING *`,
      )
      .get({
        source: input.source,
        sourceId: input.sourceId,
        hash,
        url: input.url,
        applyUrl: input.applyUrl ?? null,
        atsKind: input.atsKind ?? null,
        company: input.company,
        companyKey: keyOf(input.company),
        title: input.title,
        titleKey: titleKeyOf(input.title),
        location: input.location ?? null,
        description: input.description ?? null,
        now,
      }) as Record<string, unknown>);

  // A re-crawl can learn the apply URL for a posting stored before it was resolved.
  if (existing && input.applyUrl && !existing.apply_url) {
    store.sqlite
      .prepare('UPDATE jobs SET apply_url = ?, ats_kind = ? WHERE id = ?')
      .run(input.applyUrl, input.atsKind ?? null, existing.id);
    row.apply_url = input.applyUrl;
    row.ats_kind = input.atsKind ?? null;
  }

  return {
    id: row.id as number,
    isNew: !existing,
    posting: {
      jobKey: `${input.source}:${input.sourceId}`,
      url: (row.url as string) ?? input.url,
      title: row.title as string,
      company: row.company as string,
      location: (row.location as string) ?? '',
      description: (row.description as string) ?? '',
      capturedAt: row.discovered_at as number,
    },
  };
}

/** True when this role has already been applied to under a different listing. */
export function alreadyAppliedElsewhere(store: Store, jobId: number): boolean {
  const row = store.sqlite
    .prepare(
      `SELECT 1 FROM jobs other
         JOIN applications a ON a.job_id = other.id
        WHERE other.job_hash = (SELECT job_hash FROM jobs WHERE id = @id)
          AND other.id != @id
          AND a.state IN ('submitted', 'submitting')
        LIMIT 1`,
    )
    .get({ id: jobId });
  return Boolean(row);
}

export interface OpenedApplication {
  id: number;
  state: string;
  isNew: boolean;
}

/**
 * Opens (or reopens) the application for a job.
 *
 * A submitted application is never reopened. That is the outermost duplicate
 * guard, and it is a refusal rather than a no-op because silently doing nothing
 * would read as success to whatever asked.
 */
export function openApplication(
  store: Store,
  jobId: number,
  options: { dryRun: boolean; state?: string } = { dryRun: true },
): OpenedApplication {
  const existing = store.sqlite
    .prepare('SELECT id, state FROM applications WHERE job_id = ?')
    .get(jobId) as { id: number; state: string } | undefined;

  if (existing) {
    if (existing.state === 'submitted') {
      throw new Error(
        `Application ${existing.id} for this job is already submitted. Refusing to apply twice.`,
      );
    }
    return { ...existing, isNew: false };
  }

  const now = Date.now();
  const row = store.sqlite
    .prepare(
      `INSERT INTO applications (job_id, state, dry_run, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?) RETURNING id, state`,
    )
    .get(jobId, options.state ?? 'queued', options.dryRun ? 1 : 0, now, now) as {
    id: number;
    state: string;
  };
  return { ...row, isNew: true };
}
