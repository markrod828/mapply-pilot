import type { FormQuestion } from '../../lib/questions';
import { collectChoiceGroups } from './choices';
import { isCombobox, readComboboxOptions, selectComboboxOption } from './combobox';
import { collectFields, describeField, hasValue, setValue, type Fillable } from './fill';

/**
 * Personal details come from your profile or not at all. A model asked for a phone
 * number, a salary or a start date has nothing to go on and would invent one.
 *
 * Work authorization and sponsorship are here deliberately: they are legal facts
 * about you, not something to infer from a resume. Your profile answers them, or
 * the field stays empty for you to answer.
 */
const PERSONAL =
  /first name|last name|full name|preferred name|e-?mail|phone|mobile|street|address|\bcity\b|\bstate\b|zip|postal|\bcountry\b|\blocation\b|relocat|linked-?in|git-?hub|portfolio|website|salary|compensation|desired pay|notice period|start date|date of birth|social security|\bssn\b|reference|sponsor|\bvisa\b|work authoriz|authorized to work|right to work|work permit|citizen/i;

/**
 * Protected characteristics. These are voluntary self-identification and are not a
 * model's to guess, whatever the resume happens to imply.
 */
const DEMOGRAPHIC =
  /gender|\brace\b|ethnic|veteran|disabilit|sexual orientation|pronoun|hispanic|latino|lgbt|self-?identif|\beeo\b|voluntary disclosure|accommodation|transgender/i;

/** Employers who ask for the applicant's own words deserve to know it was flagged. */
export const OWN_WORDS =
  /\bnot ai\b|no ai\b|without (?:using )?ai|your own words|own words|do not use (?:chat)?gpt|no chatgpt/i;

/** Long enough to read as a question rather than a stray input. */
const MIN_LABEL_WORDS = 3;

export interface CollectedQuestion {
  question: FormQuestion;
  /** The form asked for the candidate's own words. */
  ownWords: boolean;
  /** Apply an answer, however this particular control takes one. */
  fill: (answer: string) => Promise<boolean>;
  /** Something to outline once answered. */
  element: HTMLElement;
}

/**
 * Everything still empty after the deterministic passes that looks like a question
 * worth answering. Options for custom pickers are read by opening them, since they
 * are not in the DOM until then.
 */
export async function collectQuestions(handled: Set<Fillable>): Promise<CollectedQuestion[]> {
  const collected: CollectedQuestion[] = [];
  let id = 0;

  for (const element of collectFields()) {
    if (handled.has(element) || hasValue(element)) continue;
    if (element instanceof HTMLInputElement && ['radio', 'checkbox', 'file'].includes(element.type)) continue;

    const label = describeField(element);
    if (!label || label.split(/\s+/).length < MIN_LABEL_WORDS) continue;
    if (PERSONAL.test(label) || DEMOGRAPHIC.test(label)) continue;

    const question = await describeQuestion(element, label, id);
    if (!question) continue;

    collected.push({
      question,
      element,
      ownWords: OWN_WORDS.test(label),
      fill: async (answer) => {
        if (!element.isConnected || hasValue(element)) return false;
        return isCombobox(element) ? selectComboboxOption(element, answer) : setValue(element, answer);
      },
    });
    id += 1;
  }

  // Pick-one questions drawn as radios or buttons: no input for collectFields to
  // find, so they are gathered separately or they could never be answered at all.
  for (const group of collectChoiceGroups()) {
    if (group.answered()) continue;

    const label = group.label;
    if (!label || label.split(/\s+/).length < MIN_LABEL_WORDS) continue;
    if (PERSONAL.test(label) || DEMOGRAPHIC.test(label)) continue;

    collected.push({
      question: { id, label: cleanLabel(label), kind: 'choice', options: group.options },
      element: group.element,
      ownWords: OWN_WORDS.test(label),
      fill: async (answer) => group.choose(answer),
    });
    id += 1;
  }

  return collected;
}

async function describeQuestion(
  element: Fillable,
  label: string,
  id: number,
): Promise<FormQuestion | null> {
  const text = cleanLabel(label);
  const maxLength = element.getAttribute('maxlength');

  if (element instanceof HTMLSelectElement) {
    const options = Array.from(element.options)
      .map((option) => option.text.trim())
      .filter((option) => option && !/^(select|choose|please|--)/i.test(option));
    return options.length ? { id, label: text, kind: 'choice', options } : null;
  }

  if (isCombobox(element)) {
    const options = await readComboboxOptions(element);
    // No readable options means a free-text autocomplete, which we leave alone
    // rather than typing a value that will never be committed.
    return options.length ? { id, label: text, kind: 'choice', options } : null;
  }

  return {
    id,
    label: text,
    kind: element instanceof HTMLTextAreaElement ? 'textarea' : 'text',
    ...(maxLength && Number(maxLength) > 0 ? { maxLength: Number(maxLength) } : {}),
  };
}

/**
 * describeField concatenates every label source, so the same words often repeat and
 * the field id trails the end. Trim that down to something readable as a question.
 */
function cleanLabel(label: string): string {
  const withoutIds = label.replace(/\b(?:question_)?\d{6,}\b/g, ' ').replace(/\s+/g, ' ').trim();

  const seen = new Set<string>();
  const sentences: string[] = [];
  for (const part of withoutIds.split(/(?<=[.?!])\s+/)) {
    const key = part.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    sentences.push(part.trim());
  }

  return sentences.join(' ').slice(0, 600);
}
