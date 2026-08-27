import { formatAddress, formatLocation } from '../../lib/profile';
import type { Profile } from '../../lib/types';

export interface FieldRule {
  key: string;
  test: RegExp;
  exclude?: RegExp;
  value: string;
  /** Long-form answers should only land in textareas. */
  longForm?: boolean;
}

/**
 * Ordered: the first rule whose label matches wins, so put the specific ones first.
 * The cover letter is not here - it needs a textarea revealed by a button on some
 * forms, so the engine handles it directly.
 */
export function buildRules(profile: Profile, resumeText: string): FieldRule[] {
  const fullName = `${profile.firstName} ${profile.lastName}`.trim();
  const location = formatLocation(profile.address);
  const { address } = profile;

  const rules: FieldRule[] = [
    { key: 'firstName', test: /first[\s_-]*name|given[\s_-]*name|fname/, value: profile.firstName },
    { key: 'middleName', test: /middle[\s_-]*name|middle[\s_-]*initial|\bmname\b/, value: profile.middleName },
    { key: 'lastName', test: /last[\s_-]*name|family[\s_-]*name|surname|lname/, value: profile.lastName },
    { key: 'preferredName', test: /preferred[\s_-]*name|nickname/, value: profile.firstName },
    {
      key: 'fullName',
      test: /(^|\b)(full[\s_-]*name|your name|name)(\b|$)/,
      // Plenty of boxes say "name" and mean something narrower: one part of the name,
      // or somebody else's entirely — a relative at the company, an emergency contact,
      // a referrer. Each part is listed because its own rule drops out when that part
      // of the profile is blank, leaving this rule to claim the box by default.
      exclude:
        /first|middle|last|maiden|user|company|employer|school|university|file|reference|manager|relative|spouse|emergency|referr/,
      value: fullName,
    },
    {
      key: 'preferredContact',
      // Ahead of the email and phone rules on purpose: a label like "Preferred contact
      // method (email or phone)" names both, and it wants the choice between them, not
      // the address itself. "Preferred contact number" is excluded, since that is asking
      // for the number and the phone rule below should answer it.
      test: /preferred (method of )?contact|preferred contact|contact (method|preference)|best way to (reach|contact)|how (should|do) (we|you) (prefer to )?(contact|reach)/,
      exclude: /contact number|contact phone|emergency/,
      value: profile.preferredContact,
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
    // Line 2 is tested before line 1, because "address line 1" and "address line 2"
    // both contain "address" and the first matching rule wins.
    {
      key: 'addressLine2',
      test: /address ?(line ?)?2|apt|apartment|\bsuite\b|\bunit\b/,
      value: address.line2,
    },
    {
      key: 'addressLine1',
      test: /street|address ?(line ?)?1|\baddress\b/,
      // An email field is an "email address", and the administrative parts of an address
      // are their own boxes on any form that also asks for a street.
      exclude: /e-?mail|city|town|state|province|zip|postal|country|ip address|web|url/,
      value: address.line1,
    },
    {
      key: 'fullAddress',
      test: /(full|complete|mailing|home|current) address|address \(full\)/,
      exclude: /e-?mail/,
      value: formatAddress(address),
      longForm: true,
    },
    {
      key: 'postalCode',
      test: /zip|postal ?code|post ?code|\bpostcode\b/,
      value: address.postalCode,
    },
    {
      key: 'city',
      test: /\bcity\b|\btown\b/,
      // "Are you open to relocating to New York City?" is a preference question that
      // happens to name a city, not a box to type your own city into.
      exclude: /company|employer|relocat|willing|open to|prefer|commut/,
      value: address.city,
    },
    { key: 'state', test: /\bstate\b|province|\bregion\b/, exclude: /united states/, value: address.state },
    {
      key: 'country',
      test: /\bcountry\b/,
      // "…sponsorship for the country you are applying?" is a sponsorship question
      // that happens to contain the word, and it is answered yes/no, not "USA".
      exclude: /sponsor|visa|authoriz|permit|citizen|eligib/,
      value: address.country,
    },
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
      test: /salary|compensation|expected pay|rate expectation/,
      // "Compensation" alone is the field; the same word inside a benefits or equity
      // question is not something to type a number into.
      exclude: /benefit|equity|stock|bonus structure|package includes/,
      value: profile.salaryExpectation,
    },
    {
      key: 'availableStartDate',
      test: /available (start )?date|start date|when can you (start|begin)|earliest (start|availability)/,
      // A "Start date month" box belongs to an employment row, not to your availability.
      exclude: /end date|employment|\bmonth\b|\byear\b|previous|prior|last job/,
      value: profile.availableStartDate,
    },
    {
      key: 'notice',
      test: /notice period|when can you start|start date|availability/,
      exclude: /\bmonth\b|\byear\b|employment|end date/,
      value: profile.noticePeriod,
    },
    {
      key: 'gender',
      // "Gender" on an application is the voluntary self-identification block. Whatever
      // the candidate typed is matched against the form's own options, blank stays blank.
      test: /\bgender\b|\bsex\b|gender identity/,
      exclude: /transgender/,
      value: profile.gender,
    },
    {
      key: 'ethnicity',
      test: /ethnicity|\brace\b|racial|hispanic|latino/,
      value: profile.ethnicity,
    },
    {
      key: 'veteranStatus',
      test: /veteran|military service|protected veteran/,
      value: profile.veteranStatus,
    },
    {
      key: 'disabilityStatus',
      test: /disability|disabled|cc-?305/,
      value: profile.disabilityStatus,
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
      key: 'willingToRelocate',
      test: /willing to relocate|open to relocat|relocat/,
      value: profile.willingToRelocate,
    },
    {
      key: 'workPreference',
      test: /work (preference|arrangement|model|setting)|remote or|on-?site or|hybrid/,
      value: profile.workPreference,
    },
    {
      key: 'referralSource',
      test: /how did you (hear|find|learn)|referral source|where did you (hear|find)|source/,
      exclude: /resume|cv/,
      value: profile.referralSource,
    },
    {
      key: 'previouslyEmployed',
      // "previously been employed" puts a word between the two halves, and a bare
      // "ever worked" would swallow "have you ever worked with React?".
      test: /(previously|formerly)\s+(been\s+)?(employed|worked)|ever been employed|former employee|worked (here|for us|at this)/,
      value: profile.previouslyEmployed,
    },
    {
      key: 'over18',
      test: /\b18\b.*(or older|or above|years of age)|at least 18|over 18|18\+/,
      exclude: /under 18/,
      value: profile.isOver18,
    },
    // The follow-up is tested first: it also says "relative(s)", and the first rule
    // whose label matches wins.
    {
      key: 'relativesDetail',
      test: /if you responded|name\(s\) of (known )?relative|names? of (the )?relatives?/,
      value: profile.relativesDetail,
    },
    {
      key: 'relativesAtCompany',
      test: /relatives?\b.*(employed|work)|family member.*(employed|work)|any relatives? (at|with)/,
      value: profile.hasRelativesAtCompany,
    },
    {
      key: 'agreeToTerms',
      test: /by (selecting|checking) agree|i (have read and )?agree to|acknowledge that i have read|privacy (notice|policy)|terms (and conditions|of use)/,
      exclude: /do not agree|disagree/,
      value: profile.agreeToTerms,
    },
    {
      key: 'pronouns',
      test: /pronoun/,
      value: profile.pronouns,
    },
    {
      key: 'resumeText',
      test: /paste (your )?(resume|cv)|resume text|cv text/,
      value: resumeText,
      longForm: true,
    },
  ];

  // Tolerant of a missing value despite the types: a profile stored before a field
  // existed is untyped JSON by the time it gets here, and one undefined field must not
  // take the whole form down with it.
  return rules.filter((rule) => (rule.value ?? '').trim() !== '');
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
