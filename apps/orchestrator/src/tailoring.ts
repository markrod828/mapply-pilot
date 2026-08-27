import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { scoreResume } from '@mapply/core/atsScore';
import { createOpenAiClient } from '@mapply/core/llm/openai';
import { buildResumePdfBytes } from '@mapply/core/resumePdf';
import { tailorResume } from '@mapply/core/tailor';
import { DEFAULT_TAILOR_OPTIONS, type AtsScore, type JobPosting, type LlmPort } from '@mapply/core';
import type { Store } from '@mapply/db';
import type { Identity } from './identity';
import { paths } from './paths';

/**
 * How much effort a given job is worth.
 *
 * The gate is the fit score, because that is the only number available before
 * the expensive call. A job the resume already suits gets a full rewrite and the
 * cost that goes with it; a marginal one gets the resume as it stands. The point
 * is not to save money for its own sake - it is that a bespoke rewrite for a job
 * that was never going to answer is effort taken from one that might.
 */
export type TailorTier = 'full' | 'mini' | 'base';

export interface TailorSettings {
  apiKey: string;
  scoreModel: string;
  tailorModel: string;
  /** Below this the job is not worth applying to at all. */
  floor: number;
  /** At or above this the resume is rewritten for the job. */
  fullFrom: number;
  template: 'classic' | 'modern';
}

export function settingsFromEnv(): TailorSettings | null {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) return null;
  return {
    apiKey,
    scoreModel: process.env.MAPPLY_SCORE_MODEL ?? 'gpt-4o-mini',
    tailorModel: process.env.MAPPLY_TAILOR_MODEL ?? 'gpt-4o',
    floor: Number(process.env.MAPPLY_SCORE_FLOOR ?? 40),
    fullFrom: Number(process.env.MAPPLY_TAILOR_FROM ?? 55),
    template: (process.env.MAPPLY_RESUME_TEMPLATE as 'classic' | 'modern') ?? 'classic',
  };
}

export interface Prepared {
  tier: TailorTier;
  score?: AtsScore;
  /** Absolute path to the resume this application should send. */
  resumePath?: string;
  resumeText: string;
  /** Set when the job scored below the floor and should not be applied to. */
  skip?: string;
}

/**
 * Scores a job and, if it is worth it, writes a resume tailored to it.
 *
 * Every model call is recorded as it happens rather than totalled at the end, so
 * a run that dies halfway still shows what it spent.
 */
export async function prepare(
  store: Store,
  applicationId: number,
  jobId: number,
  posting: JobPosting,
  identity: Identity,
  settings: TailorSettings,
): Promise<Prepared> {
  const llm = clientFor(store, settings, applicationId, jobId);

  const score = await scoreResume({
    llm,
    model: settings.scoreModel,
    resumeText: identity.resume.text,
    job: posting,
    source: 'default',
  });

  store.sqlite
    .prepare('UPDATE jobs SET ats_score = ?, ats_score_json = ?, scored_at = ? WHERE id = ?')
    .run(score.overall, JSON.stringify(score), Date.now(), jobId);

  if (score.overall < settings.floor) {
    return {
      tier: 'base',
      score,
      resumeText: identity.resume.text,
      skip: `scored ${score.overall}, below the floor of ${settings.floor}`,
    };
  }

  if (score.overall < settings.fullFrom) {
    // Worth applying to, not worth a rewrite. The base resume goes as it is.
    return { tier: 'base', score, resumePath: identity.resumePath, resumeText: identity.resume.text };
  }

  const tailored = await tailorResume({
    llm,
    model: settings.tailorModel,
    resumeText: identity.resume.text,
    baseData: identity.resume.data,
    job: posting,
    baseScore: score,
    options: {
      ...DEFAULT_TAILOR_OPTIONS,
      // Only the gaps the scorer actually found, and only a handful: a keyword
      // list long enough to rewrite the whole resume around stops being tailoring.
      selectedKeywords: score.missingKeywords.slice(0, 12),
    },
  });

  const bytes = await buildResumePdfBytes(identity.profile, tailored, settings.template);
  const file = resolve(paths.forApplication(applicationId), 'resume.pdf');
  writeFileSync(file, bytes);

  store.sqlite
    .prepare('UPDATE applications SET tailored_json = ?, resume_path = ?, tailor_tier = ? WHERE id = ?')
    .run(JSON.stringify(tailored), file, 'full', applicationId);

  return { tier: 'full', score, resumePath: file, resumeText: tailored.text };
}

/**
 * A model client bound to one application.
 *
 * Bound rather than shared so that every call it makes is attributed without the
 * calling code having to carry a usage object back up through core.
 */
function clientFor(
  store: Store,
  settings: TailorSettings,
  applicationId: number | null,
  jobId: number | null,
): LlmPort {
  return createOpenAiClient({
    apiKey: settings.apiKey,
    concurrency: 2,
    onUsage: (usage) => {
      store.sqlite
        .prepare(
          `INSERT INTO llm_calls (application_id, job_id, purpose, model, prompt_tokens,
                                  completion_tokens, cost_usd, latency_ms, ok, error, at)
           VALUES (@applicationId, @jobId, @purpose, @model, @promptTokens,
                   @completionTokens, @cost, @latency, @ok, @error, @at)`,
        )
        .run({
          applicationId,
          jobId,
          purpose: usage.purpose,
          model: usage.model,
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          cost: estimateCost(usage.model, usage.promptTokens, usage.completionTokens),
          latency: usage.latencyMs,
          ok: usage.ok ? 1 : 0,
          error: usage.error ?? null,
          at: Date.now(),
        });
    },
  });
}

/**
 * Rough dollars for a call.
 *
 * Deliberately approximate and kept in one place. Prices move, and a number that
 * is close enough to notice a tenfold change is worth more than an exact one
 * that nobody updates.
 */
const PRICES: Record<string, { in: number; out: number }> = {
  'gpt-4o': { in: 2.5, out: 10 },
  'gpt-4o-mini': { in: 0.15, out: 0.6 },
  'gpt-4.1': { in: 2, out: 8 },
  'gpt-4.1-mini': { in: 0.4, out: 1.6 },
};

function estimateCost(model: string, promptTokens: number, completionTokens: number): number {
  const price = PRICES[model] ?? PRICES['gpt-4o-mini'];
  return (promptTokens * price.in + completionTokens * price.out) / 1_000_000;
}

export function spendToday(store: Store): number {
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const row = store.sqlite
    .prepare('SELECT COALESCE(SUM(cost_usd), 0) AS total FROM llm_calls WHERE at >= ?')
    .get(midnight.getTime()) as { total: number };
  return row.total;
}
