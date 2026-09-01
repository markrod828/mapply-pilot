/** A tri-state answer: unset is meaningfully different from "no" on an application. */
export type YesNo = 'yes' | 'no' | '';

export interface ScreeningAnswer {
  id: string;
  question: string;
  answer: string;
}

/**
 * A postal address as application forms ask for it: two street lines, then the
 * administrative fields. Every part is free text — postal codes, regions and country
 * naming vary too much between countries to constrain here.
 */
export interface Address {
  line1: string;
  /** Apartment, suite or unit. Usually blank. */
  line2: string;
  city: string;
  /** State, province or region. */
  state: string;
  postalCode: string;
  country: string;
}

export interface Profile {
  firstName: string;
  /** Required by several ATS platforms even though a resume rarely shows it. */
  middleName: string;
  lastName: string;
  /** e.g. "she/her". Asked by some forms; never rendered on the resume. */
  pronouns: string;
  email: string;
  phone: string;
  /** How you would rather be reached: "Email", "Phone", "Text message". */
  preferredContact: string;
  address: Address;
  /**
   * Free text rather than a fixed set, because forms offer different options and most
   * allow declining. Autofill matches it against a form's own choices, so whatever the
   * candidate types here is what gets looked for.
   */
  gender: string;
  /** Voluntary self-identification, same free-text reasoning as gender. */
  ethnicity: string;
  veteranStatus: string;
  disabilityStatus: string;
  linkedin: string;
  github: string;
  portfolio: string;
  currentTitle: string;
  yearsExperience: string;
  /**
   * Citizenship, as a form asks it: "Nationality", "Citizenship", "Country of
   * citizenship". Kept apart from `address.country`, which is where you live -
   * the two differ often enough that answering one with the other is wrong
   * rather than merely imprecise.
   */
  nationality: string;
  workAuthorization: string;
  requiresSponsorship: YesNo;
  salaryExpectation: string;
  noticePeriod: string;
  /** ISO 8601 (YYYY-MM-DD). Some forms want a date where others want a notice period. */
  availableStartDate: string;
  willingToRelocate: YesNo;
  /** Remote, Hybrid, On-site. Free text, because forms word the choices differently. */
  workPreference: string;
  /** "How did you hear about us?" */
  referralSource: string;
  previouslyEmployed: YesNo;
  /** Age eligibility, asked as "Are you 18 years of age or older?". */
  isOver18: YesNo;
  /** Nepotism disclosure: a relative already working at the company. */
  hasRelativesAtCompany: YesNo;
  /** Their names, or "N/A" — the follow-up box is usually required either way. */
  relativesDetail: string;
  /**
   * Whether to tick "I agree to the Privacy Notice" and its equivalents. A consent,
   * so it is a stored choice rather than something the filler assumes.
   */
  agreeToTerms: YesNo;
  screeningAnswers: ScreeningAnswer[];
}

export interface ResumeDoc {
  fileName: string;
  mimeType: string;
  text: string;
  /**
   * The resume parsed into fields, filled in lazily the first time there is an API key
   * to do it with. Optional on purpose: `text` stays the source of truth, a re-upload
   * writes a fresh doc without it, and every reader falls back to the text when absent.
   */
  data?: StructuredResume;
  parsedAt?: number;
  /** Byte size of the stored original file, 0 when only text was provided. */
  size: number;
  updatedAt: number;
}

export interface AtsBuckets {
  keywordCoverage: number;
  skillsOverlap: number;
  titleExperienceAlignment: number;
  mustHaveRequirements: number;
}

export type ComparisonStatus = 'match' | 'partial' | 'miss';

/** One row of the job-requirement vs your-resume table. */
export interface ComparisonRow {
  label: string;
  status: ComparisonStatus;
  jobValue: string;
  resumeValue: string;
}

export interface ScoredKeyword {
  term: string;
  /** Grouping for the picker, e.g. "Functional Skills", "Tools", "Domain". */
  category: string;
  present: boolean;
}

export interface AtsScore {
  overall: number;
  buckets: AtsBuckets;
  keywords: ScoredKeyword[];
  matchedKeywords: string[];
  missingKeywords: string[];
  mustHaveGaps: string[];
  comparison: ComparisonRow[];
  summaryVerdict: string;
  rationale: string;
  scoredAt: number;
  /** Which resume version produced this score. */
  source: 'default' | 'tailored';
}

export interface JobPosting {
  jobKey: string;
  url: string;
  title: string;
  company: string;
  location: string;
  description: string;
  capturedAt: number;
}

export interface SkillGroup {
  category: string;
  items: string[];
}

export interface ExperienceEntry {
  title: string;
  company: string;
  /** Optional. Rendered right-aligned opposite the company, as a classic resume does. */
  location?: string;
  /**
   * Kept as the resume wrote it, e.g. "June 2022" — not normalised, because a rewrite
   * must never drift a date. Use formatDateRange to show the two together.
   */
  startDate: string;
  /** e.g. "May 2022", or "Present" for a role still held. */
  endDate: string;
  bullets: string[];
}

export interface ProjectEntry {
  name: string;
  /** Optional stack line, rendered after the name as "NAME | React, Node.js". */
  tech?: string;
  bullets: string[];
}

export interface EducationEntry {
  school: string;
  location: string;
  degree: string;
  /** Often empty: most resumes show only the year a degree finished. */
  startDate: string;
  /** When the degree completed, e.g. "2019". */
  endDate: string;
  details: string[];
}

/**
 * A section the structured shape does not model — awards, publications, target roles —
 * plus the landing place when migrating older free-form drafts.
 */
export interface ResumeSection {
  heading: string;
  bullets: string[];
}

export interface OmittedKeyword {
  keyword: string;
  reason: string;
}

export interface TailorSections {
  summary: boolean;
  skills: boolean;
  workExperience: boolean;
  projects: boolean;
}

export interface TailorOptions {
  sections: TailorSections;
  /** Quick rewrites the two most recent roles; full rewrites every role. */
  workExperienceDepth: 'quick' | 'full';
  /** Missing keywords the user asked to add, including any typed by hand. */
  selectedKeywords: string[];
}

export interface TailorStats {
  summaryUpdated: boolean;
  bulletsRewritten: number;
  skillsAdded: number;
}

/**
 * A resume's content, independent of any job. The uploaded base resume and a tailored
 * draft are both this shape; TailoredResume adds the target job and the provenance of
 * the rewrite. Always produced by parseStructured, so every field is populated.
 */
export interface StructuredResume {
  /**
   * Positioning line under the name, e.g.
   * "Full-Stack Engineer | React/TypeScript | Java/Spring Boot | AWS".
   * Empty on most base resumes; a tailored draft aims it at the target role.
   */
  headline: string;
  summary: string;
  skillGroups: SkillGroup[];
  /** Flattened from skillGroups for keyword checks and autofill. */
  skills: string[];
  experience: ExperienceEntry[];
  projects: ProjectEntry[];
  education: EducationEntry[];
  certifications: string[];
  sections: ResumeSection[];
}

export interface TailoredResume extends StructuredResume {
  jobKey: string;
  changeNotes: string[];
  /** Requested keywords the rewrite actually worked into the resume. */
  addedKeywords: string[];
  /** Requested keywords left out because the resume showed no evidence for them. */
  omittedKeywords: OmittedKeyword[];
  options: TailorOptions;
  stats: TailorStats;
  /** Free-text refinement instructions applied so far, oldest first. */
  refinements: string[];
  /** Plain-text render used for scoring, autofill and PDF export. */
  text: string;
  accepted: boolean;
  createdAt: number;
}

export const DEFAULT_TAILOR_OPTIONS: TailorOptions = {
  sections: { summary: true, skills: true, workExperience: true, projects: true },
  workExperienceDepth: 'quick',
  selectedKeywords: [],
};

export type ResumeTemplate = 'classic' | 'modern';

/** 'system' follows the OS; the other two override it. */
export type Theme = 'system' | 'light' | 'dark';

export interface Settings {
  openaiApiKey: string;
  scoreModel: string;
  tailorModel: string;
  /** Write answers to screening questions the form asks during autofill. */
  answerQuestions: boolean;
  resumeTemplate: ResumeTemplate;
  /**
   * Name of the folder picked for saved resumes, for display only - the handle that
   * grants access lives in IndexedDB. Empty means save to the Downloads folder.
   */
  saveDirectoryName: string;
  theme: Theme;
}

export interface CoverLetter {
  /** The letter body, from "Dear …" to the sign-off. Plain text. */
  text: string;
  createdAt: number;
}

export interface GeneratedAnswer {
  /** The question exactly as the form asked it, used as the cache key. */
  question: string;
  answer: string;
}

/** One line of a conversation about a posting. */
export interface ChatTurn {
  role: 'you' | 'assistant';
  text: string;
  at: number;
}

export interface JobRecord {
  job: JobPosting;
  /** Screening answers written for this job's application form. */
  answers?: GeneratedAnswer[];
  baseScore?: AtsScore;
  tailoredScore?: AtsScore;
  tailored?: TailoredResume;
  coverLetter?: CoverLetter;
  /**
   * Questions asked about this posting, oldest first.
   *
   * Kept per job rather than globally: a question about one role means nothing
   * against another, and threading them together would send the wrong posting
   * as context.
   */
  chat?: ChatTurn[];
  /** Hash of the resume text used for baseScore, so stale caches are refreshed. */
  baseResumeHash?: string;
}

export const DEFAULT_SETTINGS: Settings = {
  openaiApiKey: '',
  scoreModel: 'gpt-4o-mini',
  tailorModel: 'gpt-4o',
  answerQuestions: true,
  resumeTemplate: 'classic',
  saveDirectoryName: '',
  theme: 'system',
};

export const EMPTY_ADDRESS: Address = {
  line1: '',
  line2: '',
  city: '',
  state: '',
  postalCode: '',
  country: '',
};

export const EMPTY_PROFILE: Profile = {
  firstName: '',
  middleName: '',
  lastName: '',
  pronouns: '',
  email: '',
  phone: '',
  preferredContact: 'Email',
  address: EMPTY_ADDRESS,
  gender: '',
  ethnicity: '',
  veteranStatus: '',
  disabilityStatus: '',
  linkedin: '',
  github: '',
  portfolio: '',
  currentTitle: '',
  yearsExperience: '',
  nationality: '',
  workAuthorization: '',
  requiresSponsorship: '',
  salaryExpectation: '',
  noticePeriod: '',
  availableStartDate: '',
  willingToRelocate: '',
  workPreference: '',
  referralSource: '',
  previouslyEmployed: '',
  isOver18: 'yes',
  hasRelativesAtCompany: 'no',
  relativesDetail: 'N/A',
  agreeToTerms: 'yes',
  screeningAnswers: [],
};
