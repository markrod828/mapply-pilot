import { truncate } from './atsScore';
import type { LlmPort } from './ports';
import {
  ACTION_VERBS,
  RESUME_BUILD_RULES,
  hasWeakBullets,
  pageLengthHint,
  polishStructuredResume,
} from './resumeBuildRules';
import { formatDateRange, parseRoleHeading, splitDateRange, stripBulletPrefix } from './resumeFormat';
import type {
  AtsScore,
  EducationEntry,
  ExperienceEntry,
  JobPosting,
  ProjectEntry,
  ResumeSection,
  SkillGroup,
  StructuredResume,
  TailorOptions,
  TailorStats,
  TailoredResume,
} from './types';

const RULES = `Hard rules:
- Never invent employers, dates, degrees, certifications or metrics.
- EXPERIENCE IS LOCKED FOR COUNT, COMPANY AND DATES:
  - Keep every work experience from the original resume. Same number of roles, same order
    (most recent first).
  - Copy company, location, startDate and endDate EXACTLY from the LOCKED EXPERIENCE SKELETON. Do not merge,
    drop, rename, invent or reorder employers, and do not change date ranges.
  - You MAY update the role title (positioning toward the target job) and rewrite bullet content.
- Reproduce education and certifications fully - never drop them. A missing degree looks like a gap.
- The headline is positioning, not a claimed past title. Prefer:
  "{Target Role} | {2-4 strongest stack keywords}" e.g.
  "Full-Stack Engineer | React/TypeScript | Java/Spring Boot | AWS"
  Align the summary with that same story so frontend and backend claims match the bullets.
- Write ATS-friendly plain text: no tables, columns, graphics or special characters.
- Bullets must NOT start with "-", "•", "*", or any other marker - the renderer adds bullets.
- Keep bullets under 28 words. Prefer impact + tech over laundry lists of duties.`;

const DENSITY = `Density and structure (recruiters scan; do not dump everything):
- Experience bullet counts by role order (most recent first):
  - Role 1 (most recent): 6-8 strong bullets
  - Role 2: 5-6 strong bullets
  - Role 3 and older: 3-4 strong bullets each
  If the original role has fewer bullets than the target, keep what is true - never invent work.
- Each project: 2-3 impactful bullets max.
- Skills: group into categories such as Languages, Frontend, Backend, Cloud/DevOps, Databases,
  Testing, Tools. Put 4-8 items per group. Prefer the job's vocabulary where truthful.
- Education: one compact entry per school (school, location, degree, startDate, endDate). Most
  resumes show only a completion year - put it in endDate and leave startDate "". Put coursework in
  details only if short; otherwise omit.
- Certifications: a flat list of short strings, one credential per item.`;

const SYSTEM_PROMPT = `You rewrite a candidate's existing resume into a polished, recruiter-readable
software-engineering resume that also ranks well in an ATS keyword screen - without inventing facts.

${RESUME_BUILD_RULES}

Rewrite the resume so it answers this specific posting on three fronts, together. Each one is
about surfacing what the candidate has already done, in the job's own terms. None of them is ever
about adding something they have not done.

1. EXPERIENCE LEVEL. The posting asks for a seniority; the resume has to read at that level, or
   make clear it exceeds it. Lead bullets with the scope the candidate genuinely owned - the
   system, the team, the users, the money, what broke if they got it wrong - rather than the task
   performed. Where the resume shows leadership, put it in the verb: led, owned, drove. Where it
   does not, do not imply it. A senior posting met with task-shaped bullets reads as junior even
   when the person is not.

2. SKILLS. Every technology the posting names that the candidate has actually used belongs in the
   skill groups AND in the bullet where they used it. A skill listed but never demonstrated reads
   as filler to a person and matches thinly to a screen. Use the posting's exact spelling where
   the difference is only style.

3. INDUSTRY EXPERIENCE. Where an employer, product or user base overlaps the posting's domain,
   say so in the words the posting uses. "Payments platform serving 40k merchants" beats "backend
   service" for a fintech role - when that is what it was. Where there is no overlap, say nothing;
   a stretched claim about domain is the easiest kind for an interviewer to catch.

Rewrite every role's bullets against these three, not only the most recent. An older role is often
where the strongest evidence of the industry or the seniority actually sits, and leaving it in its
original wording wastes it.

TARGET KEYWORDS, when given, are terms the candidate has confirmed they genuinely have. Cover each
one within the three fronts above - in a skill group when it is a tool, in the bullet where it was
used when it is work. If covering one would need a fact the resume does not support, leave it out
and report it in omittedKeywords with a short reason. An empty list is not a reason to make fewer
changes; it only means nobody named terms in advance.

Prefer opening bullets with strong action verbs such as: ${ACTION_VERBS.slice(0, 12).join(', ')}.

${RULES}

${DENSITY}

Respond ONLY with JSON of the shape:
{
  "headline": string,
  "summary": string,
  "skillGroups": [{ "category": string, "items": string[] }],
  "experience": [{ "title": string, "company": string, "location": string, "startDate": string, "endDate": string, "bullets": string[] }],
  "projects": [{ "name": string, "tech": string, "bullets": string[] }],
  "education": [{ "school": string, "location": string, "degree": string, "startDate": string, "endDate": string, "details": string[] }],
  "certifications": string[],
  "addedKeywords": string[],
  "omittedKeywords": [{ "keyword": string, "reason": string }],
  "changeNotes": string[]
}
The experience array MUST have the same length and order as the LOCKED EXPERIENCE SKELETON, with
identical company, location, startDate and endDate fields. summary is 2-3 sentences that open with the target role and real
years of experience, and stay consistent with the headline stack. Every target keyword must appear
in either addedKeywords or omittedKeywords. changeNotes lists at most 6 short notes on what you
changed.`;

const REFINE_PROMPT = `You are editing a resume that was already tailored for a specific job, following
one instruction from the candidate. Apply the instruction and change nothing else.

${RESUME_BUILD_RULES}

Prefer opening bullets with strong action verbs such as: ${ACTION_VERBS.slice(0, 12).join(', ')}.

${RULES}

${DENSITY}

Respond ONLY with JSON of the same shape you were given:
{
  "headline": string,
  "summary": string,
  "skillGroups": [{ "category": string, "items": string[] }],
  "experience": [{ "title": string, "company": string, "location": string, "startDate": string, "endDate": string, "bullets": string[] }],
  "projects": [{ "name": string, "tech": string, "bullets": string[] }],
  "education": [{ "school": string, "location": string, "degree": string, "startDate": string, "endDate": string, "details": string[] }],
  "certifications": string[],
  "addedKeywords": string[],
  "omittedKeywords": [{ "keyword": string, "reason": string }],
  "changeNotes": string[]
}
Preserve every experience entry with the same company, location, startDate and endDate. changeNotes should describe only
what this instruction changed.`;

const EXTRACT_EXPERIENCE_PROMPT = `Extract every paid work experience from this resume, most recent first.
Do not invent roles. Copy company names, locations and date ranges exactly as written.
location is the city/state the role was based in, or "" when the resume does not say.
Split each date range into halves, keeping the resume's own wording: "June 2022 - Present" becomes
startDate "June 2022" and endDate "Present". A role still held ends with "Present".
Respond ONLY with JSON:
{ "experience": [{ "title": string, "company": string, "location": string, "startDate": string, "endDate": string, "bullets": string[] }] }
Include the original bullets (without leading bullet markers). If a field is missing, use "".`;

export interface RawTailored {
  headline?: unknown;
  summary?: unknown;
  skillGroups?: unknown;
  skills?: unknown;
  experience?: unknown;
  projects?: unknown;
  education?: unknown;
  certifications?: unknown;
  sections?: unknown;
  changeNotes?: unknown;
  addedKeywords?: unknown;
  omittedKeywords?: unknown;
}

export interface TailorRequest {
  llm: LlmPort;
  model: string;
  resumeText: string;
  /**
   * The base resume already parsed into fields. When present its experience is used as
   * the locked skeleton, which saves the extraction round-trip on every tailor.
   */
  baseData?: StructuredResume;
  job: JobPosting;
  baseScore?: AtsScore;
  options: TailorOptions;
}

export async function tailorResume(request: TailorRequest): Promise<TailoredResume> {
  const targets = request.options.selectedKeywords.map((item) => item.trim()).filter(Boolean);
  const { sections, workExperienceDepth } = request.options;

  const skeleton = request.baseData?.experience.length
    ? request.baseData.experience
    : await extractExperienceSkeleton({
        llm: request.llm,
        model: request.model,
        resumeText: request.resumeText,
      });

  const selectedSections = [
    sections.summary && 'Summary',
    sections.skills && 'Skills (grouped categories)',
    sections.workExperience &&
      (workExperienceDepth === 'quick'
        ? "Work Experience (rewrite every role's bullets against the three fronts; deepest on the two most recent, tighter on older ones; NEVER drop any role)"
        : "Work Experience (rewrite every role's bullets against the three fronts, in full depth; NEVER drop any role)"),
    sections.projects && 'Projects (2-3 bullets each)',
  ].filter(Boolean) as string[];

  const lockedSkeleton = skeleton.length
    ? [
        '',
        `LOCKED EXPERIENCE SKELETON (${skeleton.length} roles — copy company + location + startDate + endDate exactly; keep this count and order):`,
        JSON.stringify(
          skeleton.map((role, index) => ({
            index: index + 1,
            title: role.title,
            company: role.company,
            location: role.location ?? '',
            startDate: role.startDate,
            endDate: role.endDate,
            originalBulletCount: role.bullets.length,
            targetBulletRange:
              index === 0 ? '6-8' : index === 1 ? '5-6' : '3-4',
            targetBulletCount: bulletCapForRole(index),
          })),
          null,
          2,
        ),
      ]
    : [];

  const user = [
    `JOB TITLE: ${request.job.title || 'Unknown'}`,
    `COMPANY: ${request.job.company || 'Unknown'}`,
    `LOCATION: ${request.job.location || 'Unknown'}`,
    '',
    'JOB DESCRIPTION:',
    truncate(request.job.description, 12000),
    '',
    `SECTIONS TO ENHANCE: ${selectedSections.join('; ') || 'none - keep the resume as is'}`,
    '',
    `TARGET KEYWORDS (${targets.length}) - cover each one or explain the omission:`,
    targets.map((keyword) => `- ${keyword}`).join('\n') || '- none',
    '',
    `UNMET MUST-HAVES: ${request.baseScore?.mustHaveGaps.join(', ') || 'none'}`,
    '',
    ...weakestFronts(request.baseScore),
    '',
    pageLengthHint(skeleton.length),
    ...lockedSkeleton,
    '',
    'ORIGINAL RESUME:',
    truncate(request.resumeText, 14000),
  ].join('\n');

  const raw = await request.llm.chatJson<RawTailored>({
    purpose: 'tailor',
    model: request.model,
    system: SYSTEM_PROMPT,
    user,
    temperature: 0.3,
    maxTokens: 8000,
  });

  return buildTailored(raw, {
    jobKey: request.job.jobKey,
    originalText: request.resumeText,
    targets,
    options: request.options,
    refinements: [],
    experienceSkeleton: skeleton,
  });
}

export interface RefineRequest {
  llm: LlmPort;
  model: string;
  resumeText: string;
  job: JobPosting;
  current: TailoredResume;
  instruction: string;
}

export async function refineResume(request: RefineRequest): Promise<TailoredResume> {
  const skeleton =
    request.current.experience.length > 0
      ? request.current.experience.map((role) => ({
          title: role.title,
          company: role.company,
          location: role.location ?? '',
          startDate: role.startDate,
          endDate: role.endDate,
          bullets: role.bullets,
        }))
      : await extractExperienceSkeleton({
          llm: request.llm,
          model: request.model,
          resumeText: request.resumeText,
        });

  const user = [
    `JOB TITLE: ${request.job.title || 'Unknown'} at ${request.job.company || 'Unknown'}`,
    '',
    'INSTRUCTION FROM THE CANDIDATE:',
    request.instruction.trim(),
    '',
    `LOCKED EXPERIENCE SKELETON (${skeleton.length} roles — keep company + location + startDate + endDate exact):`,
    JSON.stringify(
      skeleton.map((role) => ({
        title: role.title,
        company: role.company,
        location: role.location ?? '',
        startDate: role.startDate,
        endDate: role.endDate,
      })),
      null,
      2,
    ),
    '',
    'CURRENT TAILORED RESUME (JSON):',
    JSON.stringify(
      {
        headline: request.current.headline,
        summary: request.current.summary,
        skillGroups: request.current.skillGroups,
        experience: request.current.experience,
        projects: request.current.projects,
        education: request.current.education,
        certifications: request.current.certifications,
      },
      null,
      2,
    ),
    '',
    'ORIGINAL RESUME (source of truth for facts):',
    truncate(request.resumeText, 12000),
  ].join('\n');

  const raw = await request.llm.chatJson<RawTailored>({
    purpose: 'refine',
    model: request.model,
    system: REFINE_PROMPT,
    user,
    temperature: 0.3,
    maxTokens: 8000,
  });

  return buildTailored(raw, {
    jobKey: request.current.jobKey,
    originalText: request.resumeText,
    targets: request.current.options.selectedKeywords,
    options: request.current.options,
    refinements: [...request.current.refinements, request.instruction.trim()],
    experienceSkeleton: skeleton,
  });
}

interface BuildContext {
  jobKey: string;
  originalText: string;
  targets: string[];
  options: TailorOptions;
  refinements: string[];
  experienceSkeleton: ExperienceEntry[];
}

function buildTailored(raw: RawTailored, context: BuildContext): TailoredResume {
  const parsed = parseStructured(raw);
  parsed.experience = reconcileExperience(context.experienceSkeleton, parsed.experience);
  const structured = polishStructuredResume(parsed);
  const text = renderResumeText(structured);
  const { present, absent } = splitByPresence(text, context.targets);
  const claimedReasons = readOmissionReasons(raw.omittedKeywords);

  const changeNotes = toStringList(raw.changeNotes, 6);
  if (hasWeakBullets(structured) && changeNotes.length < 6) {
    changeNotes.push(
      'Some bullets still read duty-focused—use Tweak with AI to rewrite them as accomplishments.',
    );
  }

  return {
    jobKey: context.jobKey,
    ...structured,
    changeNotes,
    addedKeywords: present,
    omittedKeywords: absent.map((keyword) => ({
      keyword,
      reason: claimedReasons.get(keyword.toLowerCase()) ?? 'Could not be supported by your resume.',
    })),
    options: context.options,
    stats: computeStats(context.originalText, structured),
    refinements: context.refinements,
    text,
    accepted: false,
    createdAt: Date.now(),
  };
}

export function parseStructured(raw: RawTailored | TailoredResume): StructuredResume {
  const skillGroups = toSkillGroups(raw.skillGroups, (raw as RawTailored).skills);
  const experience = toExperience((raw as RawTailored).experience);
  const projects = toProjects((raw as RawTailored).projects);
  const education = toEducation((raw as RawTailored).education);
  const certifications = toStringList((raw as RawTailored).certifications, 12).map(stripBulletPrefix);
  const sections = toLegacySections((raw as RawTailored).sections);

  // Older drafts only had free-form sections; promote them so the new renderer still works.
  const promoted = promoteLegacySections(sections, {
    experience,
    projects,
    education,
    certifications,
  });

  return {
    headline: typeof raw.headline === 'string' ? raw.headline.trim() : '',
    summary: typeof raw.summary === 'string' ? raw.summary.trim() : '',
    skillGroups,
    skills: skillGroups.flatMap((group) => group.items),
    experience: promoted.experience,
    projects: promoted.projects,
    education: promoted.education,
    certifications: promoted.certifications,
    sections: promoted.leftover,
  };
}

function computeStats(originalText: string, resume: StructuredResume): TailorStats {
  const original = normalizeForCompare(originalText);
  let bulletsRewritten = 0;

  for (const role of resume.experience) {
    for (const bullet of role.bullets) {
      if (!original.includes(normalizeForCompare(bullet))) bulletsRewritten += 1;
    }
  }
  for (const project of resume.projects) {
    for (const bullet of project.bullets) {
      if (!original.includes(normalizeForCompare(bullet))) bulletsRewritten += 1;
    }
  }

  return {
    summaryUpdated: Boolean(resume.summary) && !original.includes(normalizeForCompare(resume.summary)),
    bulletsRewritten,
    skillsAdded: resume.skills.filter((skill) => !containsKeyword(originalText, skill)).length,
  };
}

function normalizeForCompare(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export function renderResumeText(resume: {
  headline?: string;
  summary: string;
  skillGroups?: SkillGroup[];
  skills?: string[];
  experience?: ExperienceEntry[];
  projects?: ProjectEntry[];
  education?: EducationEntry[];
  certifications?: string[];
  sections?: ResumeSection[];
}): string {
  const parts: string[] = [];
  if (resume.headline) parts.push(resume.headline, '');
  if (resume.summary) parts.push('SUMMARY', resume.summary, '');

  if (resume.education?.length) {
    parts.push('EDUCATION');
    for (const entry of resume.education) {
      const schoolLine = [entry.school, entry.location].filter(Boolean).join(' — ');
      if (schoolLine) parts.push(schoolLine);
      const degreeLine = [
        [entry.degree, ...entry.details.map(stripBulletPrefix).filter(Boolean)].filter(Boolean).join(', '),
        formatDateRange(entry.startDate, entry.endDate),
      ]
        .filter(Boolean)
        .join(' — ');
      if (degreeLine) parts.push(degreeLine);
      parts.push('');
    }
  }

  if (resume.experience?.length) {
    parts.push('EXPERIENCE');
    for (const role of resume.experience) {
      parts.push(
        [role.title, formatDateRange(role.startDate, role.endDate)].filter(Boolean).join(' — '),
      );
      const companyLine = [role.company, role.location].filter(Boolean).join(' — ');
      if (companyLine) parts.push(companyLine);
      for (const bullet of role.bullets) parts.push(`- ${stripBulletPrefix(bullet)}`);
      parts.push('');
    }
  }

  if (resume.projects?.length) {
    parts.push('PROJECTS');
    for (const project of resume.projects) {
      parts.push([project.name, project.tech].filter(Boolean).join(' | '));
      for (const bullet of project.bullets) parts.push(`- ${stripBulletPrefix(bullet)}`);
      parts.push('');
    }
  }

  const groups = resume.skillGroups?.length
    ? resume.skillGroups
    : resume.skills?.length
      ? [{ category: 'Skills', items: resume.skills }]
      : [];
  if (groups.length) {
    parts.push('TECHNICAL SKILLS');
    for (const group of groups) {
      parts.push(`${group.category}: ${group.items.join(', ')}`);
    }
    parts.push('');
  }

  if (resume.certifications?.length) {
    parts.push('CERTIFICATIONS', ...resume.certifications.map(stripBulletPrefix).filter(Boolean), '');
  }

  for (const section of resume.sections ?? []) {
    parts.push(section.heading.toUpperCase());
    for (const bullet of section.bullets) parts.push(`- ${stripBulletPrefix(bullet)}`);
    parts.push('');
  }

  return parts.join('\n').trim();
}

/** Strip markers the model often leaves on so the renderer does not double them. */
export { stripBulletPrefix } from './resumeFormat';

export function containsKeyword(text: string, keyword: string): boolean {
  const term = keyword.trim();
  if (!term) return false;
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  return new RegExp(`(^|[^a-z0-9+#])${escaped}([^a-z0-9+#]|$)`, 'i').test(text);
}

export function splitByPresence(text: string, keywords: string[]): { present: string[]; absent: string[] } {
  const present: string[] = [];
  const absent: string[] = [];
  for (const keyword of keywords) {
    (containsKeyword(text, keyword) ? present : absent).push(keyword);
  }
  return { present, absent };
}

function readOmissionReasons(value: unknown): Map<string, string> {
  const reasons = new Map<string, string>();
  if (!Array.isArray(value)) return reasons;
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const entry = item as { keyword?: unknown; reason?: unknown };
    if (typeof entry.keyword !== 'string') continue;
    reasons.set(entry.keyword.trim().toLowerCase(), typeof entry.reason === 'string' ? entry.reason.trim() : '');
  }
  return reasons;
}

/**
 * Reads a start/end pair, falling back to the single combined string that drafts stored
 * before the split still carry. Explicit halves win, but only when one of them holds
 * something: a model answering "" for both must not erase a legacy range.
 */
function readDateRange(
  start: unknown,
  end: unknown,
  legacy: unknown,
): { startDate: string; endDate: string } {
  const startDate = typeof start === 'string' ? start.trim() : '';
  const endDate = typeof end === 'string' ? end.trim() : '';
  if (startDate || endDate) return { startDate, endDate };
  return typeof legacy === 'string' ? splitDateRange(legacy) : { startDate: '', endDate: '' };
}

function toStringList(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => stripBulletPrefix(item))
    .filter(Boolean)
    .slice(0, limit);
}

function toSkillGroups(groups: unknown, flatSkills: unknown): SkillGroup[] {
  if (Array.isArray(groups) && groups.length) {
    const parsed: SkillGroup[] = [];
    for (const item of groups) {
      if (!item || typeof item !== 'object') continue;
      const entry = item as { category?: unknown; items?: unknown };
      const category = typeof entry.category === 'string' ? entry.category.trim() : '';
      const items = toStringList(entry.items, 12);
      if (!category || !items.length) continue;
      parsed.push({ category, items });
    }
    if (parsed.length) return parsed.slice(0, 8);
  }

  const flat = toStringList(flatSkills, 22);
  return flat.length ? [{ category: 'Skills', items: flat }] : [];
}

function toExperience(value: unknown): ExperienceEntry[] {
  if (!Array.isArray(value)) return [];
  const roles: ExperienceEntry[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const entry = item as {
      title?: unknown;
      company?: unknown;
      location?: unknown;
      startDate?: unknown;
      endDate?: unknown;
      dates?: unknown;
      bullets?: unknown;
    };
    const title = typeof entry.title === 'string' ? entry.title.trim() : '';
    const company = typeof entry.company === 'string' ? entry.company.trim() : '';
    const location = typeof entry.location === 'string' ? entry.location.trim() : '';
    const { startDate, endDate } = readDateRange(entry.startDate, entry.endDate, entry.dates);
    const bullets = toStringList(entry.bullets, 12);
    if (!title && !company && !bullets.length) continue;
    roles.push({ title: title || 'Role', company, location, startDate, endDate, bullets });
  }
  return roles;
}

/** Target bullet count label for prompts, and hard max for reconciliation. */
/**
 * Hands the rewrite the scorer's own findings about this resume.
 *
 * Without it the model has to rediscover the gaps from the two documents, and
 * it tends to spread its effort evenly instead. The score already knows which
 * of the three fronts is weakest - naming them is the difference between a
 * rewrite that polishes everything a little and one that fixes what is wrong.
 *
 * Only the rows that are not already a match are sent. Telling it what is
 * fine invites it to change something that was working.
 */
function weakestFronts(score: AtsScore | undefined): string[] {
  if (!score) return [];

  const gaps = score.comparison
    .filter((row) => row.status !== 'match')
    .map(
      (row) =>
        `- ${row.label}: the job wants "${row.jobValue}", this resume shows "${row.resumeValue}" (${row.status})`,
    );

  const buckets = [
    `- Skills overlap scored ${score.buckets.skillsOverlap}/100`,
    `- Title and experience alignment scored ${score.buckets.titleExperienceAlignment}/100`,
    `- Keyword coverage scored ${score.buckets.keywordCoverage}/100`,
  ];

  return [
    'WHERE THIS RESUME IS WEAKEST AGAINST THIS POSTING (from a prior review of it):',
    ...gaps,
    ...buckets,
    'Fix these with real material from the resume. A front that cannot be improved',
    'truthfully stays as it is - say so in changeNotes rather than inventing a way to close it.',
  ];
}

export function bulletCapForRole(index: number): number {
  if (index === 0) return 8;
  if (index === 1) return 6;
  return 4;
}

async function extractExperienceSkeleton(request: {
  llm: LlmPort;
  model: string;
  resumeText: string;
}): Promise<ExperienceEntry[]> {
  try {
    const raw = await request.llm.chatJson<{ experience?: unknown }>({
      purpose: 'extract_experience',
      model: request.model,
      system: EXTRACT_EXPERIENCE_PROMPT,
      user: truncate(request.resumeText, 14000),
      temperature: 0,
      maxTokens: 3000,
    });
    return toExperience(raw.experience);
  } catch {
    return [];
  }
}

/**
 * Force the tailored experience list to match the original skeleton:
 * same count/order, locked company + dates, optional title/bullet updates.
 */
export function reconcileExperience(
  skeleton: ExperienceEntry[],
  tailored: ExperienceEntry[],
): ExperienceEntry[] {
  if (!skeleton.length) return tailored;

  const unused = [...tailored];

  return skeleton.map((original, index) => {
    const byCompany = unused.findIndex(
      (role) =>
        normalizeCompany(role.company) === normalizeCompany(original.company) ||
        ((original.startDate || original.endDate) &&
          role.startDate === original.startDate &&
          role.endDate === original.endDate),
    );
    const matchIndex = byCompany >= 0 ? byCompany : unused.length ? 0 : -1;
    const match = matchIndex >= 0 ? unused.splice(matchIndex, 1)[0] : undefined;

    const cap = bulletCapForRole(index);
    const rewritten = (match?.bullets ?? [])
      .map(stripBulletPrefix)
      .filter(Boolean)
      .slice(0, cap);

    // Prefer rewritten bullets; if the model returned nothing, keep the original ones (capped).
    const bullets =
      rewritten.length > 0
        ? rewritten
        : original.bullets.map(stripBulletPrefix).filter(Boolean).slice(0, cap);

    return {
      title: match?.title?.trim() || original.title,
      company: original.company,
      location: original.location ?? match?.location ?? '',
      startDate: original.startDate,
      endDate: original.endDate,
      bullets,
    };
  });
}

function normalizeCompany(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function toProjects(value: unknown): ProjectEntry[] {
  if (!Array.isArray(value)) return [];
  const projects: ProjectEntry[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const entry = item as { name?: unknown; tech?: unknown; bullets?: unknown };
    const rawName = typeof entry.name === 'string' ? entry.name.trim() : '';
    let tech = typeof entry.tech === 'string' ? entry.tech.trim() : '';
    // Models often fold the stack into the name as "Checkout Service | Java, Redis";
    // split it back out so the renderer can set the two halves in different weights.
    const pipe = rawName.indexOf('|');
    const name = pipe >= 0 ? rawName.slice(0, pipe).trim() : rawName;
    if (!tech && pipe >= 0) tech = rawName.slice(pipe + 1).trim();
    const bullets = toStringList(entry.bullets, 3);
    if (!name && !bullets.length) continue;
    projects.push({ name: name || 'Project', tech, bullets });
  }
  return projects.slice(0, 6);
}

function toEducation(value: unknown): EducationEntry[] {
  if (!Array.isArray(value)) return [];
  const entries: EducationEntry[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const entry = item as {
      school?: unknown;
      location?: unknown;
      degree?: unknown;
      startDate?: unknown;
      endDate?: unknown;
      year?: unknown;
      details?: unknown;
    };
    const school = typeof entry.school === 'string' ? entry.school.trim() : '';
    const location = typeof entry.location === 'string' ? entry.location.trim() : '';
    const degree = typeof entry.degree === 'string' ? entry.degree.trim() : '';
    const { startDate, endDate } = readDateRange(entry.startDate, entry.endDate, entry.year);
    const details = toStringList(entry.details, 3);
    if (!school && !degree) continue;
    entries.push({ school, location, degree, startDate, endDate, details });
  }
  return entries.slice(0, 4);
}

function toLegacySections(value: unknown): ResumeSection[] {
  if (!Array.isArray(value)) return [];
  const sections: ResumeSection[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const candidate = item as { heading?: unknown; bullets?: unknown };
    const heading = typeof candidate.heading === 'string' ? candidate.heading.trim() : '';
    const bullets = toStringList(candidate.bullets, 12);
    if (!heading && !bullets.length) continue;
    sections.push({ heading: heading || 'Section', bullets });
  }
  return sections;
}

function promoteLegacySections(
  sections: ResumeSection[],
  current: {
    experience: ExperienceEntry[];
    projects: ProjectEntry[];
    education: EducationEntry[];
    certifications: string[];
  },
): {
  experience: ExperienceEntry[];
  projects: ProjectEntry[];
  education: EducationEntry[];
  certifications: string[];
  leftover: ResumeSection[];
} {
  if (!sections.length) {
    return { ...current, leftover: [] };
  }

  const experience = [...current.experience];
  const projects = [...current.projects];
  const education = [...current.education];
  let certifications = [...current.certifications];
  const leftover: ResumeSection[] = [];

  for (const section of sections) {
    const heading = section.heading.toLowerCase();
    if (!experience.length && /experience|engineer|developer|intern/.test(heading)) {
      const parsed = parseRoleHeading(section.heading);
      experience.push({
        title: parsed.title,
        company: parsed.company,
        ...splitDateRange(parsed.dates),
        bullets: section.bullets.slice(0, 8),
      });
      continue;
    }
    if (!projects.length && /project/.test(heading)) {
      projects.push({ name: section.heading, bullets: section.bullets.slice(0, 3) });
      continue;
    }
    if (!education.length && /education|university|college|school/.test(heading)) {
      education.push({
        school: section.heading,
        location: '',
        degree: section.bullets[0] ?? '',
        startDate: '',
        endDate: '',
        details: section.bullets.slice(1, 3),
      });
      continue;
    }
    if (!certifications.length && /certif/.test(heading)) {
      certifications = section.bullets;
      continue;
    }
    leftover.push(section);
  }

  return { experience, projects, education, certifications, leftover };
}
