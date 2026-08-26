import { base64ToBlob } from '../../lib/db';
import type { AnswersResponse, AutofillPayload, CoverLetterResponse } from '../../lib/messages';
import { findAdapter, resolveValue } from './adapters';
import { collectChoiceGroups } from './choices';
import { isCombobox, selectComboboxOption, waitFor } from './combobox';
import { collectQuestions } from './questions';
import {
  attachFile,
  collectFields,
  describeField,
  hasValue,
  highlight,
  isVisible,
  setValue,
  type Fillable,
} from './fill';
import { buildRules, matchScreeningAnswer } from './rules';

export interface AutofillResult {
  filled: string[];
  skipped: string[];
  resumeAttached: boolean;
  /** How the cover letter went in, or null when it did not. */
  coverLetter: 'text' | 'file' | null;
  /** Why the form asked for a cover letter but did not get one. */
  coverLetterWarning?: string;
  /** Which resume went up, e.g. "tailored resume for Platform Engineer". */
  resumeLabel: string;
  /** Set when the tailored draft could not be attached and the default went up instead. */
  resumeWarning?: string;
  /** Questions answered from your resume rather than from a saved value. */
  answered: string[];
  /** Of those, the ones whose wording asked for the applicant's own words. */
  ownWordsAsked: string[];
  answerWarning?: string;
  adapter: string;
}

const YES_NO = /^(yes|no)$/i;

export async function runAutofill(payload: AutofillPayload): Promise<AutofillResult> {
  const result: AutofillResult = {
    filled: [],
    skipped: [],
    resumeAttached: false,
    coverLetter: null,
    answered: [],
    ownWordsAsked: [],
    resumeLabel: payload.resumeLabel,
    resumeWarning: payload.tailoredUnavailable
      ? 'Your tailored resume has no saved PDF yet, so the default went up. Open ApplyPilot on this job, then autofill again.'
      : undefined,
    adapter: findAdapter(location.hostname)?.name ?? 'Generic',
  };

  const handled = new Set<Fillable>();
  applyAdapter(payload, handled, result);
  await applyRules(payload, handled, result);
  applyChoiceGroups(payload, result);
  await applyScreeningAnswers(payload, handled, result);
  await fillCoverLetter(payload, handled, result);
  attachResume(payload, result);
  await answerRemaining(handled, result);
  collectUnfilled(handled, result);

  return result;
}

/**
 * Whatever is still empty and reads like a question gets answered from the resume.
 * Runs last, so it only ever sees what the deterministic passes could not fill.
 */
async function answerRemaining(handled: Set<Fillable>, result: AutofillResult) {
  const questions = await collectQuestions(handled);
  if (!questions.length) return;

  let response: AnswersResponse;
  try {
    response = (await chrome.runtime.sendMessage({
      type: 'REQUEST_ANSWERS',
      questions: questions.map((item) => item.question),
    })) as AnswersResponse;
  } catch {
    return;
  }

  if (!response?.ok) {
    if (response?.error) result.answerWarning = response.error;
    return;
  }

  const byId = new Map(questions.map((item) => [item.question.id, item]));

  for (const { id, answer } of response.answers ?? []) {
    const target = byId.get(id);
    if (!target || !answer) continue;

    // The page may have moved on while the answers were being written.
    if (!(await target.fill(answer))) continue;

    if (target.element instanceof HTMLInputElement || target.element instanceof HTMLTextAreaElement) {
      handled.add(target.element);
    }
    // Amber rather than green: these are written for you and need reading.
    highlight(target.element, false);
    result.answered.push(target.question.label.slice(0, 70));
    if (target.ownWords) result.ownWordsAsked.push(target.question.label.slice(0, 70));
  }
}

function applyAdapter(payload: AutofillPayload, handled: Set<Fillable>, result: AutofillResult) {
  const adapter = findAdapter(location.hostname);
  if (!adapter) return;

  for (const field of adapter.fields) {
    const element = document.querySelector<Fillable>(field.selector);
    if (!element || handled.has(element) || !isVisible(element) || hasValue(element)) continue;

    const value = resolveValue(payload.profile, field.key);
    if (!value) continue;

    if (setValue(element, value)) {
      handled.add(element);
      highlight(element, true);
      result.filled.push(field.key);
    }
  }
}

async function applyRules(payload: AutofillPayload, handled: Set<Fillable>, result: AutofillResult) {
  const rules = buildRules(payload.profile, payload.resumeText);

  for (const element of collectFields()) {
    if (handled.has(element) || hasValue(element)) continue;
    if (element instanceof HTMLInputElement && ['radio', 'checkbox', 'file'].includes(element.type)) continue;

    const label = describeField(element);
    if (!label) continue;

    const combobox = isCombobox(element);

    const rule = rules.find((candidate) => {
      if (candidate.longForm && !(element instanceof HTMLTextAreaElement)) return false;
      if (candidate.exclude?.test(label)) return false;
      return candidate.test.test(label);
    });
    if (!rule) continue;

    // A yes/no answer only makes sense in a picker, not a free-text box.
    if (YES_NO.test(rule.value) && !(element instanceof HTMLSelectElement) && !combobox) continue;

    const filled = combobox
      ? // A location is reworded by the picker ("Austin" -> "Austin, TX, USA"), so
        // take its first suggestion; anything else must match what we asked for.
        await selectComboboxOption(element, rule.value, { allowFirst: rule.key === 'location' })
      : setValue(element, rule.value);

    if (filled) {
      handled.add(element);
      highlight(element, true);
      result.filled.push(rule.key);
    }
  }
}

/**
 * Pick-one questions, whether the form draws them as radios, ARIA widgets or a row
 * of buttons. Only groups we already have an answer for are touched.
 */
function applyChoiceGroups(payload: AutofillPayload, result: AutofillResult) {
  for (const group of collectChoiceGroups()) {
    if (group.answered()) continue;

    const answer = answerForGroup(payload, group.label);
    if (!answer || !group.choose(answer)) continue;

    highlight(group.element, true);
    result.filled.push(group.label.slice(0, 40));
  }
}

function answerForGroup(payload: AutofillPayload, label: string): string | null {
  const { profile } = payload;
  if (/sponsorship|visa|h-?1b/.test(label) && profile.requiresSponsorship) {
    return profile.requiresSponsorship;
  }
  if (/authorized to work|work authorization|right to work|legally/.test(label) && profile.workAuthorization) {
    return profile.workAuthorization;
  }
  return matchScreeningAnswer(profile, label);
}

async function applyScreeningAnswers(
  payload: AutofillPayload,
  handled: Set<Fillable>,
  result: AutofillResult,
) {
  for (const element of collectFields()) {
    if (handled.has(element) || hasValue(element)) continue;
    if (element instanceof HTMLInputElement && ['radio', 'checkbox', 'file'].includes(element.type)) continue;

    const label = describeField(element);
    const answer = matchScreeningAnswer(payload.profile, label);
    if (!answer) continue;

    // Screening questions are often pickers ("Do you have 5+ years…" -> Yes/No),
    // so a saved answer has to be selected rather than typed.
    const filled = isCombobox(element)
      ? await selectComboboxOption(element, answer)
      : setValue(element, answer);

    if (filled) {
      handled.add(element);
      highlight(element, true);
      result.filled.push(label.slice(0, 40));
    }
  }
}

const COVER_LETTER = /cover[\s_-]?letter|letter of interest|motivation letter/i;
const UPLOAD_LABEL = /upload|attach|drag|drop|file type/i;
const MANUAL_ENTRY = /enter manually|type manually|paste|write it|enter text/i;

/**
 * Prefer pasting the letter over uploading it: a textarea is read directly by the
 * ATS, while an attachment has to survive their parser. Greenhouse only renders the
 * textarea after "Enter manually" is clicked, so reveal it first when it is missing.
 *
 * The letter is written only once a field for it is actually on the page, so forms
 * that never ask for one cost nothing.
 */
async function fillCoverLetter(payload: AutofillPayload, handled: Set<Fillable>, result: AutofillResult) {
  const upload = findCoverLetterUpload();
  let area = findCoverLetterTextarea();

  if (!area) {
    const button = findManualEntryButton();
    if (button) {
      button.click();
      area = await waitFor(findCoverLetterTextarea, 2000);
    }
  }

  if (!area && !upload) return;

  const letter = await requestCoverLetter(result);
  if (!letter) return;

  if (area && !hasValue(area) && setValue(area, letter)) {
    handled.add(area);
    highlight(area, true);
    result.filled.push('cover letter');
    result.coverLetter = 'text';
    return;
  }

  // No text box: upload it as plain text, which every ATS that takes a cover letter
  // file accepts and parses more reliably than a generated PDF.
  if (upload && acceptsPlainText(upload)) {
    const name = `${payload.profile.firstName}${payload.profile.lastName}`.replace(/[^a-z0-9]/gi, '');
    const file = new File([letter], `${name || 'Cover'}-CoverLetter.txt`, { type: 'text/plain' });
    if (attachFile(upload, file)) {
      result.coverLetter = 'file';
      result.filled.push('cover letter');
    }
  }
}

async function requestCoverLetter(result: AutofillResult): Promise<string> {
  try {
    const response = (await chrome.runtime.sendMessage({
      type: 'REQUEST_COVER_LETTER',
    })) as CoverLetterResponse;

    if (!response?.ok) {
      if (response?.error) result.coverLetterWarning = response.error;
      return '';
    }
    return response.coverLetter?.text ?? '';
  } catch {
    return '';
  }
}

function acceptsPlainText(input: HTMLInputElement): boolean {
  const accept = (input.getAttribute('accept') ?? '').toLowerCase();
  return !accept || accept.includes('.txt') || accept.includes('text/plain') || accept.includes('*');
}

function findCoverLetterTextarea(): HTMLTextAreaElement | null {
  const areas = Array.from(document.querySelectorAll<HTMLTextAreaElement>('textarea')).filter(
    (area) => !area.disabled && !area.readOnly && isVisible(area),
  );

  return (
    areas.find((area) => {
      const label = describeField(area);
      return COVER_LETTER.test(label) && !UPLOAD_LABEL.test(label);
    }) ?? null
  );
}

/** The button that swaps a cover letter upload for a plain textarea. */
function findManualEntryButton(): HTMLElement | null {
  const group =
    document.querySelector<HTMLElement>('[aria-labelledby*="cover" i]') ??
    document
      .querySelector<HTMLInputElement>('input[type="file"][id*="cover" i], input[type="file"][name*="cover" i]')
      ?.closest<HTMLElement>('div') ??
    null;
  if (!group) return null;

  const buttons = Array.from(group.querySelectorAll<HTMLElement>('button, [role="button"]'));
  return (
    buttons.find((button) => {
      const testId = button.getAttribute('data-testid') ?? '';
      return MANUAL_ENTRY.test(button.textContent ?? '') || /-text$/.test(testId);
    }) ?? null
  );
}

function fileInputs(): HTMLInputElement[] {
  return Array.from(document.querySelectorAll<HTMLInputElement>('input[type="file"]')).filter(
    (input) => !input.disabled,
  );
}

function findCoverLetterUpload(): HTMLInputElement | null {
  return fileInputs().find((input) => COVER_LETTER.test(describeField(input))) ?? null;
}

/** Some forms offer to parse a resume into the fields; that is not the resume field. */
const RESUME_PARSER = /autofill|parse|prefill|fill (?:in |out )?(?:the )?(?:form|application)|import/i;

/** The resume upload: any file input that is not the cover letter's. */
function attachResume(payload: AutofillPayload, result: AutofillResult) {
  if (!payload.resumeFileBase64) return;

  const cover = findCoverLetterUpload();
  const candidates = fileInputs().filter(
    (input) => input !== cover && !RESUME_PARSER.test(describeField(input)),
  );

  const target =
    // The real field names itself; Ashby uses `_systemfield_resume`, Greenhouse `resume`.
    candidates.find((input) => /resume|cv/i.test(`${input.id} ${input.name}`)) ??
    candidates.find((input) => /resume|cv/i.test(describeField(input))) ??
    (candidates.length === 1 ? candidates[0] : undefined);
  if (!target) return;

  const blob = base64ToBlob(payload.resumeFileBase64, payload.resumeFileMime);
  const file = new File([blob], payload.resumeFileName, { type: payload.resumeFileMime });
  if (attachFile(target, file)) {
    result.resumeAttached = true;
    result.filled.push(payload.usingTailored ? 'tailored resume' : 'resume');
  }
}

function collectUnfilled(handled: Set<Fillable>, result: AutofillResult) {
  for (const element of collectFields()) {
    if (handled.has(element) || hasValue(element)) continue;
    if (element instanceof HTMLInputElement && ['radio', 'checkbox', 'file'].includes(element.type)) continue;

    const label = describeField(element);
    if (!label || !element.required) continue;
    result.skipped.push(label.slice(0, 60));
  }
}
