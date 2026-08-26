import type { Profile } from '../../lib/types';

export interface FieldRule {
  key: string;
  test: RegExp;
  exclude?: RegExp;
  value: string;
  /** Long-form answers should only land in textareas. */
  longForm?: boolean;
}

export function buildRules(profile: Profile, resumeText: string): FieldRule[] {
  const fullName = `${profile.firstName} ${profile.lastName}`.trim();
  const location = [profile.city, profile.state, profile.country].filter(Boolean).join(', ');

  const rules: FieldRule[] = [
    { key: 'firstName', test: /first[\s_-]*name|given[\s_-]*name|fname/, value: profile.firstName },
    { key: 'lastName', test: /last[\s_-]*name|family[\s_-]*name|surname|lname/, value: profile.lastName },
    { key: 'preferredName', test: /preferred[\s_-]*name|nickname/, value: profile.firstName },
    {
      key: 'fullName',
      test: /(^|\b)(full[\s_-]*name|your name|name)(\b|$)/,
      exclude: /first|last|user|company|employer|school|university|file|reference|manager/,
      value: fullName,
    },
    { key: 'email', test: /e-?mail/, value: profile.email },
    { key: 'phone', test: /phone|mobile|contact number|telephone/, value: profile.phone },
    { key: 'linkedin', test: /linked-?in/, value: profile.linkedin },
    { key: 'github', test: /git-?hub/, value: profile.github },
    {
      key: 'portfolio',
      test: /portfolio|personal (site|website)|website|other url|blog/,
      exclude: /linked-?in|git-?hub|company/,
      value: profile.portfolio,
    },
    { key: 'city', test: /\bcity\b|\btown\b/, exclude: /company|employer/, value: profile.city },
    { key: 'state', test: /\bstate\b|province|\bregion\b/, exclude: /united states/, value: profile.state },
    { key: 'country', test: /\bcountry\b/, value: profile.country },
    {
      key: 'location',
      test: /current location|where are you (based|located)|location/,
      exclude: /relocat|preferred|office|job/,
      value: location,
    },
    {
      key: 'currentTitle',
      test: /current (job )?title|current role|your title|job title/,
      exclude: /desired|company/,
      value: profile.currentTitle,
    },
    {
      key: 'yearsExperience',
      test: /years? of (relevant )?experience|experience \(years\)|yoe/,
      value: profile.yearsExperience,
    },
    {
      key: 'salary',
      test: /salary|compensation expectation|expected pay|desired (pay|compensation)|rate expectation/,
      value: profile.salaryExpectation,
    },
    {
      key: 'notice',
      test: /notice period|when can you start|start date|availability/,
      value: profile.noticePeriod,
    },
    {
      key: 'workAuthorization',
      test: /work authorization|authorized to work|legally (authorized|entitled)|right to work|work permit/,
      value: profile.workAuthorization,
    },
    {
      key: 'sponsorship',
      test: /sponsorship|visa (support|status)|require sponsorship|h-?1b/,
      value: profile.requiresSponsorship,
    },
    {
      key: 'resumeText',
      test: /paste (your )?(resume|cv)|resume text|cv text/,
      value: resumeText,
      longForm: true,
    },
  ];

  return rules.filter((rule) => rule.value.trim() !== '');
}

/** Finds a saved screening answer whose question overlaps the field label. */
export function matchScreeningAnswer(profile: Profile, label: string): string | null {
  const labelTokens = tokenize(label);
  if (labelTokens.size < 2) return null;

  let best: { answer: string; ratio: number } | null = null;
  for (const saved of profile.screeningAnswers) {
    if (!saved.question.trim() || !saved.answer.trim()) continue;
    const questionTokens = tokenize(saved.question);
    if (!questionTokens.size) continue;

    let shared = 0;
    for (const token of questionTokens) {
      if (labelTokens.has(token)) shared += 1;
    }
    const ratio = shared / questionTokens.size;
    if (ratio >= 0.6 && (!best || ratio > best.ratio)) {
      best = { answer: saved.answer, ratio };
    }
  }
  return best?.answer ?? null;
}

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'of', 'to', 'in', 'for', 'and', 'or', 'is', 'are', 'do', 'does',
  'you', 'your', 'we', 'this', 'that', 'with', 'on', 'at', 'be', 'have', 'has', 'will',
  'what', 'why', 'how', 'please', 'if', 'any', 'us', 'our', 'it', 'as',
]);

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((word) => word.length > 2 && !STOP_WORDS.has(word)),
  );
}
