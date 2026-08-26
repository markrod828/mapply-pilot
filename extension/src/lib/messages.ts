import type { FormQuestion, QuestionAnswer } from './questions';
import type {
  AtsScore,
  CoverLetter,
  JobPosting,
  Profile,
  TailorOptions,
  TailoredResume,
} from './types';

export interface AutofillPayload {
  profile: Profile;
  resumeText: string;
  resumeFileName: string;
  /** base64 (no data: prefix) of the PDF to attach, when available. */
  resumeFileBase64: string;
  resumeFileMime: string;
  usingTailored: boolean;
  /** Human-readable description of the file being attached, shown in the page panel. */
  resumeLabel: string;
  /** A tailored draft exists for this job but has no stored PDF, so the default went up. */
  tailoredUnavailable: boolean;
}

export type Message =
  | { type: 'JOB_CAPTURED'; job: JobPosting }
  | { type: 'JOB_CLEARED' }
  | { type: 'OPEN_SIDE_PANEL' }
  | { type: 'REQUEST_SCORE'; job: JobPosting; force?: boolean }
  | { type: 'REQUEST_TAILOR'; jobKey: string; options: TailorOptions }
  | { type: 'REQUEST_REFINE'; jobKey: string; instruction: string }
  | { type: 'REQUEST_RESCORE_TAILORED'; jobKey: string }
  /** Omit jobKey to write one for whichever job is currently open. */
  | { type: 'REQUEST_COVER_LETTER'; jobKey?: string }
  | { type: 'GET_ACTIVE_JOB' }
  | { type: 'GET_AUTOFILL_PAYLOAD' }
  | { type: 'RUN_AUTOFILL'; tabId: number }
  | { type: 'REQUEST_ANSWERS'; questions: FormQuestion[] }
  | { type: 'STATE_CHANGED' };

export interface ScoreResponse {
  ok: boolean;
  error?: string;
  score?: AtsScore;
}

export interface TailorResponse {
  ok: boolean;
  error?: string;
  tailored?: TailoredResume;
}

export interface AutofillResponse {
  ok: boolean;
  error?: string;
  payload?: AutofillPayload;
}

export interface CoverLetterResponse {
  ok: boolean;
  error?: string;
  coverLetter?: CoverLetter;
}

export interface AnswersResponse {
  ok: boolean;
  error?: string;
  answers?: QuestionAnswer[];
}

export function sendMessage<T>(message: Message): Promise<T> {
  return chrome.runtime.sendMessage(message) as Promise<T>;
}
