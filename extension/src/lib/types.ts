export interface ScreeningAnswer {
  id: string;
  question: string;
  answer: string;
}

export interface Profile {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  city: string;
  state: string;
  country: string;
  linkedin: string;
  github: string;
  portfolio: string;
  currentTitle: string;
  yearsExperience: string;
  workAuthorization: string;
  requiresSponsorship: 'yes' | 'no' | '';
  salaryExpectation: string;
  noticePeriod: string;
  screeningAnswers: ScreeningAnswer[];
}

export interface ResumeDoc {
  fileName: string;
  mimeType: string;
  text: string;
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
  dates: string;
  bullets: string[];
}

export interface ProjectEntry {
  name: string;
  bullets: string[];
}

export interface EducationEntry {
  school: string;
  location: string;
  degree: string;
  year: string;
  details: string[];
}

/** Legacy free-form section used only when migrating older tailored drafts. */
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

export interface TailoredResume {
  jobKey: string;
  /**
   * Positioning line for the target role, e.g.
   * "Full-Stack Engineer | React/TypeScript | Java/Spring Boot | AWS".
   */
  headline: string;
  summary: string;
  skillGroups: SkillGroup[];
  /** Flattened skill list for keyword checks and autofill. */
  skills: string[];
  experience: ExperienceEntry[];
  projects: ProjectEntry[];
  education: EducationEntry[];
  certifications: string[];
  /** @deprecated Kept for migrating older drafts only. */
  sections?: ResumeSection[];
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

export interface Settings {
  openaiApiKey: string;
  scoreModel: string;
  tailorModel: string;
  autoScore: boolean;
  resumeTemplate: ResumeTemplate;
  /**
   * Name of the folder picked for saved resumes, for display only - the handle that
   * grants access lives in IndexedDB. Empty means save to the Downloads folder.
   */
  saveDirectoryName: string;
}

export interface JobRecord {
  job: JobPosting;
  baseScore?: AtsScore;
  tailoredScore?: AtsScore;
  tailored?: TailoredResume;
  /** Hash of the resume text used for baseScore, so stale caches are refreshed. */
  baseResumeHash?: string;
}

export const DEFAULT_SETTINGS: Settings = {
  openaiApiKey: '',
  scoreModel: 'gpt-4o-mini',
  tailorModel: 'gpt-4o',
  autoScore: true,
  resumeTemplate: 'classic',
  saveDirectoryName: '',
};

export const EMPTY_PROFILE: Profile = {
  firstName: '',
  lastName: '',
  email: '',
  phone: '',
  city: '',
  state: '',
  country: '',
  linkedin: '',
  github: '',
  portfolio: '',
  currentTitle: '',
  yearsExperience: '',
  workAuthorization: '',
  requiresSponsorship: '',
  salaryExpectation: '',
  noticePeriod: '',
  screeningAnswers: [],
};
