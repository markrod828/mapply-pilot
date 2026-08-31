import { base64ToBlob } from '../../lib/db';
import type { AnswersResponse, AutofillPayload, CoverLetterResponse } from '../../lib/messages';
import { findAdapter, resolveValue } from './adapters';
import { collectChoiceGroups } from './choices';
import { fillEmploymentHistory } from './employment';
import { isCombobox, selectComboboxOption, waitFor } from './combobox';
import { collectQuestions } from './questions';
import {
  attachFile,
  collectFields,
  describeField,
  resetFillMemory,
  hasValue,
  highlight,
  isVisible,
  markTouched,
  setValue,
  wasTouched,
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

function emptyResult(payload: AutofillPayload): AutofillResult {
  return {
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
}

/** How long the DOM must stop changing before a sweep is worth running. */
const SETTLE_MS = 600;
/** Bounded so a tab left open on a form does not observe forever. */
const WATCH_MS = 10 * 60 * 1000;

/**
 * The deterministic passes on their own, safe to repeat.
 *
 * No model calls, so a sweep costs nothing and can never reword an answer that is
 * already on the page. Anything holding a value is left alone, so this only ever
 * fills what has newly appeared.
 */
async function fillKnownFields(payload: AutofillPayload): Promise<string[]> {
  const result = emptyResult(payload);
  const handled = new Set<Fillable>();

  applyAdapter(payload, handled, result);
  result.filled.push(...(await fillEmploymentHistory(payload.experience ?? [], handled, { mayAddRows: false })));
  await applyRules(payload, handled, result);
  applyChoiceGroups(payload, result);
  applyConsent(payload, handled, result);

  return result.filled;
}

/**
 * Keeps filling as the rest of the form arrives.
 *
 * A framework-rendered application is not one form but several: Workday and its peers
 * are wizards whose steps each replace the DOM, and an answer often reveals the
 * follow-up question underneath it. One pass can only ever see the step that was on
 * screen when it ran, which is why the second step of an application always looked
 * empty. This re-runs the free passes whenever the DOM settles.
 *
 * Returns a function that stops watching.
 */
export function watchForNewFields(
  payload: AutofillPayload,
  onFilled: (keys: string[]) => void,
): () => void {
  let timer: number | undefined;
  let sweeping = false;
  let stopped = false;

  const stop = () => {
    stopped = true;
    observer.disconnect();
    window.clearTimeout(timer);
    window.clearTimeout(giveUp);
  };

  const sweep = async () => {
    timer = undefined;
    // Re-entrancy matters here: filling mutates the DOM, which wakes the observer.
    if (stopped || sweeping) return;
    sweeping = true;
    try {
      const filled = await fillKnownFields(payload);
      if (filled.length && !stopped) onFilled(filled);
    } finally {
      sweeping = false;
    }
  };

  const observer = new MutationObserver(() => {
    if (stopped || timer !== undefined) return;
    timer = window.setTimeout(sweep, SETTLE_MS);
  });

  // childList only: our own highlight writes inline styles, and watching attributes
  // would make every fill wake the observer that caused it.
  observer.observe(document.documentElement, { childList: true, subtree: true });
  const giveUp = window.setTimeout(stop, WATCH_MS);

  return stop;
}

export async function runAutofill(payload: AutofillPayload): Promise<AutofillResult> {
  const result = emptyResult(payload);
  // Pressing Autofill means "fill this form", including anything cleared since the
  // last press and anything that failed. Only the automatic sweeps have to hold back.
  resetFillMemory();

  const handled = new Set<Fillable>();
  applyAdapter(payload, handled, result);
  result.filled.push(...(await fillEmploymentHistory(payload.experience ?? [], handled, { mayAddRows: true })));
  await applyRules(payload, handled, result);
  applyChoiceGroups(payload, result);
  applyConsent(payload, handled, result);
  await applyScreeningAnswers(payload, handled, result);
  await fillCoverLetter(payload, handled, result);
  attachResume(payload, result);
  await answerRemaining(payload, handled, result);
  collectUnfilled(handled, result);

  return result;
}

/**
 * Whatever is still empty and reads like a question gets answered from the resume.
 * Runs last, so it only ever sees what the deterministic passes could not fill.
 */
async function answerRemaining(
  payload: AutofillPayload,
  handled: Set<Fillable>,
  result: AutofillResult,
) {
  // Checked before collecting rather than after: collectQuestions opens every
  // unanswered picker to read its options, which is the slowest thing autofill does.
  if (!payload.answerQuestions) return;

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

const CONSENT =
  /by (selecting|checking) agree|i (have read and )?agree|acknowledge that i have read|consent to|privacy (notice|policy)|terms (and conditions|of use)/;
const CONSENT_NOT = /do not agree|disagree|opt out|unsubscribe|marketing|newsletter|promotional/;

/**
 * Lone tick-boxes: "I agree to the Privacy Notice".
 *
 * Nothing else reaches these. applyRules skips checkboxes outright, and the choice-group
 * pass only handles pick-one questions, which needs two options. Gated on a stored
 * choice rather than assumed, because ticking it is giving consent on someone's behalf,
 * and deliberately blind to marketing opt-ins, which are not the same thing.
 */
function applyConsent(payload: AutofillPayload, handled: Set<Fillable>, result: AutofillResult) {
  if (payload.profile.agreeToTerms !== 'yes') return;

  for (const box of document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) {
    if (box.disabled || box.checked || handled.has(box) || wasTouched(box)) continue;

    // Styled forms hide the input behind its label, so either one being visible counts.
    const label = box.closest('label');
    if (!isVisible(box) && !(label && isVisible(label))) continue;

    const text = describeField(box);
    if (!CONSENT.test(text) || CONSENT_NOT.test(text)) continue;

    box.click();
    handled.add(box);
    markTouched(box);
    highlight(label ?? box, true);
    result.filled.push('agreeToTerms');
  }
}

function applyAdapter(payload: AutofillPayload, handled: Set<Fillable>, result: AutofillResult) {
  const adapter = findAdapter(location.hostname);
  if (!adapter) return;

  for (const field of adapter.fields) {
    const element = document.querySelector<Fillable>(field.selector);
    if (!element || handled.has(element) || wasTouched(element)) continue;
    if (!isVisible(element) || hasValue(element)) continue;

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
    if (handled.has(element) || hasValue(element) || wasTouched(element)) continue;
    if (element instanceof HTMLInputElement && ['radio', 'checkbox', 'file'].includes(element.type)) continue;
    // A sweep can land while the candidate is typing; never write over the caret.
    if (element === document.activeElement) continue;

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
    if (group.answered() || wasTouched(group.element)) continue;

    const answer = answerForGroup(payload, group.label);
    if (!answer || !group.choose(answer)) continue;

    markTouched(group.element);
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

  // Everything else a pick-one question can ask is already described by the fill rules.
  // Going through them means a question drawn as radios is answered from the same
  // profile field as the same question drawn as a text input — relocation, work
  // preference and the self-identification block are radios about as often as not.
  const rule = buildRules(profile, '').find(
    (candidate) =>
      !candidate.longForm && !candidate.exclude?.test(label) && candidate.test.test(label),
  );
  if (rule) return rule.value;

  return matchScreeningAnswer(profile, label);
}

async function applyScreeningAnswers(
  payload: AutofillPayload,
  handled: Set<Fillable>,
  result: AutofillResult,
) {
  for (const element of collectFields()) {
    if (handled.has(element) || hasValue(element) || wasTouched(element)) continue;
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
