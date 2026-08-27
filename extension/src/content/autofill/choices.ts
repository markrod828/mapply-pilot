import { isVisible } from './fill';

/**
 * Pick-one questions, however the form draws them.
 *
 * Three renderings in the wild, and a form often mixes them:
 *  - real radio inputs, usually visually hidden behind a styled label
 *  - ARIA widgets: [role="radiogroup"] with [role="radio"] children
 *  - a row of plain buttons (Ashby draws Yes/No this way - no input exists at all)
 *
 * Only the first is something `collectFields` can see, and even then only when the
 * input itself is visible, which for a styled form it usually is not.
 */

/** Buttons that do something rather than answer something. */
const ACTION_BUTTON = /upload|attach|submit|browse|choose file|drag|remove|delete|cancel|back|next|continue|add\b/i;
const MAX_OPTION_WORDS = 14;
const MAX_OPTIONS = 12;

export interface ChoiceGroup {
  /** The question text. */
  label: string;
  options: string[];
  /** True when one of the options is already picked. */
  answered(): boolean;
  /** Pick the option matching `value`; false when none of them does. */
  choose(value: string): boolean;
  /** Something to outline once chosen. */
  element: HTMLElement;
}

export function collectChoiceGroups(): ChoiceGroup[] {
  return [...radioGroups(), ...ariaRadioGroups(), ...buttonGroups()];
}

/** Radio inputs, grouped by name. The input may be hidden; its label is what shows. */
function radioGroups(): ChoiceGroup[] {
  const radios = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="radio"]')).filter(
    (input) => !input.disabled && (isVisible(input) || isVisible(labelFor(input) ?? input)),
  );

  const byName = new Map<string, HTMLInputElement[]>();
  for (const radio of radios) {
    const key = radio.name || String(labelText(labelFor(radio)));
    byName.set(key, [...(byName.get(key) ?? []), radio]);
  }

  const groups: ChoiceGroup[] = [];
  for (const inputs of byName.values()) {
    if (inputs.length < 2) continue;

    const options = inputs.map((input) => optionLabel(input));
    groups.push({
      label: questionLabel(commonAncestor(inputs), options),
      options,
      answered: () => inputs.some((input) => input.checked),
      choose: (value) => {
        const index = pick(options, value);
        if (index < 0) return false;
        activateRadio(inputs[index]);
        return true;
      },
      element: inputs[0],
    });
  }
  return groups;
}

function ariaRadioGroups(): ChoiceGroup[] {
  const containers = Array.from(document.querySelectorAll<HTMLElement>('[role="radiogroup"]'));

  return containers.flatMap((container) => {
    const items = Array.from(container.querySelectorAll<HTMLElement>('[role="radio"]')).filter(isVisible);
    if (items.length < 2) return [];

    const options = items.map((item) => text(item));
    return [
      {
        label: questionLabel(container, options),
        options,
        answered: () => items.some((item) => item.getAttribute('aria-checked') === 'true'),
        choose: (value) => {
          const index = pick(options, value);
          if (index < 0) return false;
          press(items[index]);
          return true;
        },
        element: items[0],
      },
    ];
  });
}

/**
 * A row of buttons acting as one question. Discovery is deliberately loose because
 * the caller only ever chooses when it already knows the answer for this label - a
 * group it has no answer for is simply never touched.
 */
function buttonGroups(): ChoiceGroup[] {
  const groups: ChoiceGroup[] = [];
  const seen = new Set<Element>();

  const buttons = Array.from(
    // A <button> with no type attribute is a submit button, so a bare `button` selector
    // could press "Apply". Each of these says the author meant a toggle instead:
    // aria-pressed is the ARIA toggle state, and Ashby marks its Yes/No pair with
    // data-option and no type attribute at all.
    document.querySelectorAll<HTMLElement>(
      'button[type="button"], button[aria-pressed], button[data-option], [role="button"]',
    ),
  ).filter(
    (button) =>
      isVisible(button) &&
      !(button as HTMLButtonElement).disabled &&
      !isSubmitLike(button) &&
      !button.closest('[role="radiogroup"]') &&
      isOptionLike(text(button)),
  );

  for (const button of buttons) {
    const parent = button.parentElement;
    if (!parent || seen.has(parent)) continue;

    const siblings = Array.from(parent.children).filter(
      (child): child is HTMLElement => child instanceof HTMLElement && buttons.includes(child),
    );
    if (siblings.length < 2 || siblings.length > MAX_OPTIONS) continue;
    seen.add(parent);

    const options = siblings.map((item) => text(item));
    groups.push({
      label: questionLabel(parent, options),
      options,
      answered: () => siblings.some(isPressed),
      choose: (value) => {
        const index = pick(options, value);
        if (index < 0) return false;
        press(siblings[index]);
        return true;
      },
      element: siblings[0],
    });
  }

  return groups;
}

/** A button that would submit or reset the form is never an answer to a question. */
function isSubmitLike(element: HTMLElement): boolean {
  const type = element.getAttribute('type');
  return type === 'submit' || type === 'reset';
}

function isOptionLike(label: string): boolean {
  if (!label || label.length > 80) return false;
  if (label.split(/\s+/).length > MAX_OPTION_WORDS) return false;
  return !ACTION_BUTTON.test(label);
}

function isPressed(element: HTMLElement): boolean {
  return (
    element.getAttribute('aria-pressed') === 'true' ||
    element.getAttribute('aria-checked') === 'true' ||
    element.getAttribute('data-state') === 'checked' ||
    /\b(selected|active|checked)\b/i.test(element.className)
  );
}

/** Exact match, then prefix, then substring - never a blind first option. */
function pick(options: string[], value: string): number {
  const wanted = value.trim().toLowerCase();
  if (!wanted) return -1;

  const lower = options.map((option) => option.trim().toLowerCase());
  const exact = lower.indexOf(wanted);
  if (exact >= 0) return exact;

  const prefix = lower.findIndex((option) => option.startsWith(wanted));
  if (prefix >= 0) return prefix;

  return lower.findIndex((option) => option.includes(wanted));
}

function activateRadio(input: HTMLInputElement): void {
  // A hidden input still responds to click, but clicking the visible label is what
  // a person does and is what styled components listen for.
  const label = labelFor(input);
  if (!isVisible(input) && label && isVisible(label)) {
    press(label);
    return;
  }
  input.click();
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

function press(element: HTMLElement): void {
  for (const type of ['mousedown', 'mouseup', 'click'] as const) {
    element.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
  }
}

function labelFor(input: HTMLInputElement): HTMLElement | null {
  if (input.id) {
    const byFor = document.querySelector<HTMLElement>(`label[for="${cssEscape(input.id)}"]`);
    if (byFor) return byFor;
  }
  return input.closest('label');
}

function optionLabel(input: HTMLInputElement): string {
  return text(labelFor(input)) || input.value.trim();
}

function labelText(element: HTMLElement | null): string {
  return text(element);
}

function text(element: HTMLElement | null): string {
  return (element?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

function commonAncestor(elements: HTMLElement[]): HTMLElement {
  let node: HTMLElement | null = elements[0];
  while (node && !elements.every((element) => node!.contains(element))) {
    node = node.parentElement;
  }
  return node ?? elements[0];
}

/**
 * The question a group belongs to: the nearest label above it that is not just one
 * of the options repeated back.
 */
function questionLabel(container: HTMLElement, options: string[]): string {
  const optionText = new Set(options.map((option) => option.toLowerCase()));
  let node: HTMLElement | null = container;

  for (let depth = 0; node && depth < 5; depth += 1) {
    const labels = Array.from(
      node.querySelectorAll<HTMLElement>('label, legend, [class*="label" i], [class*="question" i]'),
    );
    for (const label of labels) {
      const candidate = text(label);
      if (candidate && candidate.length > 3 && !optionText.has(candidate.toLowerCase())) {
        return candidate.toLowerCase();
      }
    }

    const labelledBy = node.getAttribute('aria-labelledby');
    if (labelledBy) {
      const named = labelledBy
        .split(/\s+/)
        .map((id) => text(document.getElementById(id)))
        .filter(Boolean)
        .join(' ');
      if (named) return named.toLowerCase();
    }

    node = node.parentElement;
  }

  // Last resort: the container's own text with the option words removed.
  const whole = text(container).toLowerCase();
  return options.reduce((acc, option) => acc.replace(option.toLowerCase(), ' '), whole).replace(/\s+/g, ' ').trim();
}

function cssEscape(value: string): string {
  return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(value) : value.replace(/["\\]/g, '\\$&');
}
