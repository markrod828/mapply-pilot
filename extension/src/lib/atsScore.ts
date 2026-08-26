import { chatJson } from './openai';
import type { AtsScore, ComparisonRow, ComparisonStatus, JobPosting, ScoredKeyword } from './types';

const SYSTEM_PROMPT = `You are an applicant tracking system (ATS) screening engine.
Score how a resume would rank for a specific job requisition in a keyword-and-requirements screen.
Be strict and literal: only credit skills, titles and experience that actually appear in the resume
text. Recruiters see hundreds of resumes, so most real resumes are a mediocre match. Do not be
generous, and never reward enthusiasm, formatting or generic filler.

Calibrate the overall score to these bands:
- 0-39: wrong role or missing most required skills; would be filtered out immediately.
- 40-59: same broad field but the title, seniority or several core skills do not line up; likely
  filtered out by a keyword screen.
- 60-74: plausible candidate with real gaps a recruiter would notice.
- 75-89: strong match; title, seniority and most required skills line up.
- 90-100: near-exact match on title, seniority, domain and nearly every required skill.

Judge content, not presentation. Plain text with no styling is not worse than a designed layout, and
a shorter resume is not worse than a longer one. Score only what the words say.

Judge role fit on the work the resume describes, not job titles alone. A candidate who did the
requisition's work counts as aligned even when their official title used different words, and a
headline or summary stating the target role is legitimate positioning. Reduce
titleExperienceAlignment when the seniority, scope or domain genuinely differs - not merely because
the title strings are not identical.

Only an unmet hard requirement (missing degree, certification, licence, work authorization, or
clearly insufficient years) caps the overall score, at 55. Do not treat a requirement as unmet
unless the resume gives you positive reason to believe it is missing.

Buckets (each 0-100):
- keywordCoverage: share of important job-description terms present in the resume.
- skillsOverlap: hard skills, tools and technologies required vs present.
- titleExperienceAlignment: seniority, scope, domain and years of experience fit.
- mustHaveRequirements: explicit non-negotiables.

Also produce a side-by-side comparison a candidate can act on. Use these rows in this order:
"Job Title", "Years of Experience", "Industry Experience", "Education". For each row set status to
"match", "partial" or "miss", put the requisition's requirement in jobValue and what the resume
actually shows in resumeValue (short phrases, not sentences).

Extract the 8-14 ATS keywords that matter most for this requisition. Categorise each as
"Functional Skills", "Tools", "Domain" or "Certifications", and mark present=true only when the
term (or an obvious variant) literally appears in the resume.

Respond ONLY with JSON of the shape:
{
  "overall": number,
  "buckets": {
    "keywordCoverage": number,
    "skillsOverlap": number,
    "titleExperienceAlignment": number,
    "mustHaveRequirements": number
  },
  "keywords": [{ "term": string, "category": string, "present": boolean }],
  "comparison": [{ "label": string, "status": string, "jobValue": string, "resumeValue": string }],
  "mustHaveGaps": string[],
  "summaryVerdict": string,
  "rationale": string
}
mustHaveGaps lists unmet hard requirements (empty array when none). summaryVerdict is one sentence
judging whether the resume's own summary/profile sells this specific job. rationale is one sentence
explaining the overall score.`;

interface RawScore {
  overall?: number;
  buckets?: Partial<AtsScore['buckets']>;
  keywords?: unknown;
  comparison?: unknown;
  mustHaveGaps?: unknown;
  summaryVerdict?: unknown;
  rationale?: unknown;
}

export interface ScoreRequest {
  apiKey: string;
  model: string;
  resumeText: string;
  job: JobPosting;
  source: AtsScore['source'];
}

export async function scoreResume(request: ScoreRequest): Promise<AtsScore> {
  const user = [
    `JOB TITLE: ${request.job.title || 'Unknown'}`,
    `COMPANY: ${request.job.company || 'Unknown'}`,
    `LOCATION: ${request.job.location || 'Unknown'}`,
    '',
    'JOB DESCRIPTION:',
    truncate(request.job.description, 12000),
    '',
    'RESUME:',
    truncate(request.resumeText, 12000),
  ].join('\n');

  const raw = await chatJson<RawScore>({
    apiKey: request.apiKey,
    model: request.model,
    system: SYSTEM_PROMPT,
    user,
    temperature: 0,
    maxTokens: 1800,
  });

  const keywords = toKeywords(raw.keywords);

  return {
    overall: clampScore(raw.overall),
    buckets: {
      keywordCoverage: clampScore(raw.buckets?.keywordCoverage),
      skillsOverlap: clampScore(raw.buckets?.skillsOverlap),
      titleExperienceAlignment: clampScore(raw.buckets?.titleExperienceAlignment),
      mustHaveRequirements: clampScore(raw.buckets?.mustHaveRequirements),
    },
    keywords,
    matchedKeywords: keywords.filter((item) => item.present).map((item) => item.term),
    missingKeywords: keywords.filter((item) => !item.present).map((item) => item.term),
    mustHaveGaps: toStringList(raw.mustHaveGaps),
    comparison: toComparison(raw.comparison),
    summaryVerdict: typeof raw.summaryVerdict === 'string' ? raw.summaryVerdict : '',
    rationale: typeof raw.rationale === 'string' ? raw.rationale : '',
    scoredAt: Date.now(),
    source: request.source,
  };
}

export interface ScoreVerdict {
  label: string;
  color: string;
  /** True when a keyword screen would most likely drop this resume. */
  atRisk: boolean;
}

export function scoreVerdict(score: number): ScoreVerdict {
  if (score >= 90) return { label: 'Excellent', color: '#15803d', atRisk: false };
  if (score >= 75) return { label: 'Strong', color: '#16a34a', atRisk: false };
  if (score >= 60) return { label: 'Fair', color: '#d97706', atRisk: false };
  if (score >= 40) return { label: 'Weak', color: '#ea580c', atRisk: true };
  return { label: 'Poor', color: '#dc2626', atRisk: true };
}

export function scoreColor(score: number): string {
  return scoreVerdict(score).color;
}

export function keywordsByCategory(keywords: ScoredKeyword[]): { category: string; keywords: ScoredKeyword[] }[] {
  const groups = new Map<string, ScoredKeyword[]>();
  for (const keyword of keywords) {
    const category = keyword.category || 'Other';
    groups.set(category, [...(groups.get(category) ?? []), keyword]);
  }
  return Array.from(groups, ([category, items]) => ({ category, keywords: items }));
}

function clampScore(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.min(100, Math.round(numeric)));
}

function toStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 15);
}

function toKeywords(value: unknown): ScoredKeyword[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const keywords: ScoredKeyword[] = [];

  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const entry = item as { term?: unknown; category?: unknown; present?: unknown };
    if (typeof entry.term !== 'string') continue;

    const term = entry.term.trim();
    const dedupeKey = term.toLowerCase();
    if (!term || seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    keywords.push({
      term,
      category: typeof entry.category === 'string' && entry.category.trim() ? entry.category.trim() : 'Other',
      present: entry.present === true,
    });
  }
  return keywords.slice(0, 20);
}

function toComparison(value: unknown): ComparisonRow[] {
  if (!Array.isArray(value)) return [];
  const rows: ComparisonRow[] = [];

  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const entry = item as { label?: unknown; status?: unknown; jobValue?: unknown; resumeValue?: unknown };
    if (typeof entry.label !== 'string' || !entry.label.trim()) continue;

    rows.push({
      label: entry.label.trim(),
      status: toStatus(entry.status),
      jobValue: typeof entry.jobValue === 'string' ? entry.jobValue.trim() : '',
      resumeValue: typeof entry.resumeValue === 'string' ? entry.resumeValue.trim() : '',
    });
  }
  return rows.slice(0, 8);
}

function toStatus(value: unknown): ComparisonStatus {
  return value === 'match' || value === 'partial' || value === 'miss' ? value : 'partial';
}

export function truncate(text: string, limit: number): string {
  const clean = text.replace(/\s+\n/g, '\n').trim();
  return clean.length <= limit ? clean : `${clean.slice(0, limit)}\n[truncated]`;
}
