import type { ValueKey } from './values';

/**
 * What a form's own words mean, in profile terms.
 *
 * Carried over from the rule table the extension used, which had already learned
 * the distinctions that cost something to discover - that "compensation" inside a
 * benefits question is not a salary box, that "start date month" belongs to an
 * employment row rather than to your availability, that a bare "ever worked"
 * would swallow "have you ever worked with React?".
 *
 * One thing is deliberately different. These patterns are tested against the
 * *attributed* label only - the words discovery decided belong to this field -
 * never against a concatenation of every nearby string. That is what the
 * exclusions assume, and testing them against a blob is what made them misfire:
 * a rule written to exclude "email" would reject a phone box merely because the
 * email label happened to sit in the same wrapper.
 */
export interface LabelRule {
  key: ValueKey;
  test: RegExp;
  exclude?: RegExp;
  /** Only ever right in a textarea - a whole resume does not go in a text box. */
  longForm?: boolean;
}

/** Ordered: the first rule whose label matches wins, so the narrow ones come first. */
export const LABEL_RULES: readonly LabelRule[] = [
  { key: 'firstName', test: /first[\s_-]*name|given[\s_-]*name|fname/ },
  { key: 'middleName', test: /middle[\s_-]*name|middle[\s_-]*initial|\bmname\b/ },
  { key: 'lastName', test: /last[\s_-]*name|family[\s_-]*name|surname|lname/ },
  { key: 'preferredName', test: /preferred[\s_-]*name|nickname/ },
  {
    key: 'fullName',
    test: /(^|\b)(full[\s_-]*name|your name|name)(\b|$)/,
    exclude:
      /first|middle|last|maiden|user|company|employer|school|university|file|reference|manager|relative|spouse|emergency|referr/,
  },

  { key: 'email', test: /e-?mail/ },
  { key: 'phone', test: /phone|mobile|contact number|telephone/ },
  { key: 'linkedin', test: /linked-?in/ },
  { key: 'github', test: /git-?hub/ },
  { key: 'portfolio', test: /portfolio|personal (site|website)|^website/ },

  // Line 2 before line 1: both contain "address", and the first match wins.
  { key: 'addressLine2', test: /address ?(line ?)?2|apartment|suite|unit\b/ },
  {
    key: 'addressLine1',
    test: /street|address ?(line ?)?1|\baddress\b/,
    exclude: /e-?mail|city|town|state|province|zip|postal|country|ip address|web|url/,
  },
  { key: 'postalCode', test: /zip|postal ?code|post ?code/ },
  {
    key: 'city',
    test: /\bcity\b|\btown\b/,
    // "Are you open to relocating to New York City?" is not a city box.
    exclude: /relocat|willing|open to|prefer|commut/,
  },
  { key: 'state', test: /\bstate\b|province|\bregion\b/, exclude: /united states/ },
  // Before `country`, and no longer sharing its pattern. "Country of
  // citizenship" contains the word country, so whichever rule is tested first
  // takes it - and the one that should win is the one about citizenship.
  {
    key: 'nationality',
    test: /nationality|citizenship|country of citizen|citizen of/,
  },
  {
    key: 'country',
    test: /\bcountry\b/,
    exclude: /sponsor|visa|authoriz|permit|citizen|nationality|eligib/,
  },
  {
    key: 'location',
    test: /current location|where are you (based|located)|location/,
    exclude: /relocat|preferred|office|job/,
  },

  {
    key: 'currentTitle',
    test: /current (job )?title|current role|your title|job title/,
    exclude: /desired|company/,
  },
  { key: 'yearsExperience', test: /years? of (relevant )?experience|experience \(years\)|yoe/ },
  {
    key: 'salaryExpectation',
    test: /salary|compensation|expected pay|rate expectation/,
    exclude: /benefit|equity|stock|bonus structure|package includes/,
  },
  {
    key: 'availableStartDate',
    test: /available (start )?date|start date|when can you (start|begin)|earliest (start|availability)/,
    exclude: /end date|employment|\bmonth\b|\byear\b|previous|prior|last job/,
  },
  {
    key: 'noticePeriod',
    test: /notice period|when can you start|start date|availability/,
    exclude: /\bmonth\b|\byear\b|employment|end date/,
  },

  { key: 'gender', test: /\bgender\b|\bsex\b|gender identity/, exclude: /transgender/ },
  { key: 'ethnicity', test: /ethnicity|\brace\b|racial|hispanic|latino/ },
  { key: 'veteranStatus', test: /veteran|military service|protected veteran/ },
  { key: 'disabilityStatus', test: /disability|disabled|cc-?305/ },

  {
    key: 'workAuthorization',
    test: /work authorization|authorized to work|legally (authorized|entitled)|right to work|work permit/,
  },
  {
    key: 'requiresSponsorship',
    test: /sponsorship|visa (support|status)|require sponsorship|h-?1b/,
  },
  { key: 'willingToRelocate', test: /willing to relocate|open to relocat|relocat/ },
  {
    key: 'workPreference',
    test: /work (preference|arrangement|model|setting)|remote or|on-?site or|hybrid/,
  },
  {
    key: 'referralSource',
    test: /how did you (hear|find|learn)|referral source|where did you (hear|find)|source/,
    exclude: /resume|cv/,
  },
  {
    key: 'previouslyEmployed',
    test: /(previously|formerly)\s+(been\s+)?(employed|worked)|ever been employed|former employee|worked (here|for us|at this)/,
  },
  { key: 'isOver18', test: /\b18\b.*(or older|or above|years of age)|at least 18|over 18|18\+/, exclude: /under 18/ },

  // The follow-up first: it also says "relative", and first match wins.
  {
    key: 'relativesDetail',
    test: /if you responded|name\(s\) of (known )?relative|names? of (the )?relatives?/,
  },
  {
    key: 'hasRelativesAtCompany',
    test: /relatives?\b.*(employed|work)|family member.*(employed|work)|any relatives? (at|with)/,
  },
  {
    key: 'agreeToTerms',
    test: /by (selecting|checking) agree|i (have read and )?agree to|acknowledge that i have read|privacy (notice|policy)|terms (and conditions|of use)/,
    exclude: /do not agree|disagree/,
  },
  { key: 'pronouns', test: /pronoun/ },
  { key: 'resumeText', test: /paste (your )?(resume|cv)|resume text|cv text/, longForm: true },
];

/**
 * The first rule that claims this label, if any.
 *
 * `longForm` rules are held back from anything but a textarea: a rule that means
 * "paste your whole resume here" must not fire on a one-line box.
 */
export function matchRule(label: string, control: string): LabelRule | undefined {
  const text = label.toLowerCase();
  if (!text) return undefined;

  return LABEL_RULES.find((rule) => {
    if (rule.longForm && control !== 'textarea') return false;
    if (rule.exclude?.test(text)) return false;
    return rule.test.test(text);
  });
}

/** Normalised question text, used as the answer bank's key. */
export function questionKey(label: string): string {
  return label
    .toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
