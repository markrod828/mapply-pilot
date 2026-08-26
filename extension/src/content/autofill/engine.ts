import { base64ToBlob } from '../../lib/db';
import type { AutofillPayload } from '../../lib/messages';
import { findAdapter, resolveValue } from './adapters';
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
  /** Which resume went up, e.g. "tailored resume for Platform Engineer". */
  resumeLabel: string;
  /** Set when the tailored draft could not be attached and the default went up instead. */
  resumeWarning?: string;
  adapter: string;
}

const YES_NO = /^(yes|no)$/i;

export function runAutofill(payload: AutofillPayload): AutofillResult {
  const result: AutofillResult = {
    filled: [],
    skipped: [],
    resumeAttached: false,
    resumeLabel: payload.resumeLabel,
    resumeWarning: payload.tailoredUnavailable
      ? 'Your tailored resume has no saved PDF yet, so the default went up. Open ApplyPilot on this job, then autofill again.'
      : undefined,
    adapter: findAdapter(location.hostname)?.name ?? 'Generic',
  };

  const handled = new Set<Fillable>();
  applyAdapter(payload, handled, result);
  applyRules(payload, handled, result);
  applyChoiceGroups(payload, handled, result);
  applyScreeningAnswers(payload, handled, result);
  attachResume(payload, result);
  collectUnfilled(handled, result);

  return result;
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

function applyRules(payload: AutofillPayload, handled: Set<Fillable>, result: AutofillResult) {
  const rules = buildRules(payload.profile, payload.resumeText);

  for (const element of collectFields()) {
    if (handled.has(element) || hasValue(element)) continue;
    if (element instanceof HTMLInputElement && ['radio', 'checkbox', 'file'].includes(element.type)) continue;

    const label = describeField(element);
    if (!label) continue;

    const rule = rules.find((candidate) => {
      if (candidate.longForm && !(element instanceof HTMLTextAreaElement)) return false;
      if (candidate.exclude?.test(label)) return false;
      return candidate.test.test(label);
    });
    if (!rule) continue;

    // A yes/no answer only makes sense in a dropdown, not a free-text box.
    if (YES_NO.test(rule.value) && !(element instanceof HTMLSelectElement)) continue;

    if (setValue(element, rule.value)) {
      handled.add(element);
      highlight(element, true);
      result.filled.push(rule.key);
    }
  }
}

/** Radio groups such as "Do you require sponsorship?" get clicked, not typed into. */
function applyChoiceGroups(payload: AutofillPayload, handled: Set<Fillable>, result: AutofillResult) {
  const radios = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="radio"]')).filter(
    (input) => !input.disabled && isVisible(input),
  );

  const groups = new Map<string, HTMLInputElement[]>();
  for (const radio of radios) {
    const key = radio.name || describeField(radio);
    groups.set(key, [...(groups.get(key) ?? []), radio]);
  }

  for (const [, options] of groups) {
    if (options.some((option) => option.checked)) continue;

    const groupLabel = describeGroup(options);
    const answer = answerForGroup(payload, groupLabel);
    if (!answer) continue;

    const wanted = answer.trim().toLowerCase();
    const choice = options.find((option) => {
      const optionLabel = describeField(option);
      return optionLabel.includes(wanted) || option.value.trim().toLowerCase() === wanted;
    });
    if (!choice) continue;

    choice.click();
    handled.add(choice);
    highlight(choice, true);
    result.filled.push(groupLabel.slice(0, 40));
  }
}

function describeGroup(options: HTMLInputElement[]): string {
  const fieldset = options[0]?.closest('fieldset, [role="radiogroup"], div');
  const legend = fieldset?.querySelector('legend, label');
  if (legend instanceof HTMLElement && legend.innerText) {
    return legend.innerText.replace(/\s+/g, ' ').trim().toLowerCase();
  }
  return describeField(options[0]);
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

function applyScreeningAnswers(payload: AutofillPayload, handled: Set<Fillable>, result: AutofillResult) {
  for (const element of collectFields()) {
    if (handled.has(element) || hasValue(element)) continue;
    if (element instanceof HTMLInputElement && ['radio', 'checkbox', 'file'].includes(element.type)) continue;

    const label = describeField(element);
    const answer = matchScreeningAnswer(payload.profile, label);
    if (!answer) continue;

    if (setValue(element, answer)) {
      handled.add(element);
      highlight(element, true);
      result.filled.push(label.slice(0, 40));
    }
  }
}

function attachResume(payload: AutofillPayload, result: AutofillResult) {
  if (!payload.resumeFileBase64) return;

  const fileInputs = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="file"]')).filter(
    (input) => !input.disabled,
  );
  if (!fileInputs.length) return;

  const resumeInput =
    fileInputs.find((input) => /resume|cv/i.test(describeField(input))) ??
    (fileInputs.length === 1 ? fileInputs[0] : undefined);
  if (!resumeInput) return;

  const blob = base64ToBlob(payload.resumeFileBase64, payload.resumeFileMime);
  const file = new File([blob], payload.resumeFileName, { type: payload.resumeFileMime });
  if (attachFile(resumeInput, file)) {
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
