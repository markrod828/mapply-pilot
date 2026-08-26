import { isVisible } from './fill';

/**
 * Driving react-select and friends. These render a text input plus a menu built on
 * click, so assigning `.value` types characters that are never committed - the form
 * still submits empty. The option has to be opened, filtered and clicked.
 */

const OPTION_TIMEOUT_MS = 3000;
const POLL_MS = 60;
const SETTLE_MS = 80;

export function isCombobox(element: Element): element is HTMLInputElement {
  return (
    element instanceof HTMLInputElement &&
    (element.getAttribute('role') === 'combobox' || element.getAttribute('aria-haspopup') === 'true')
  );
}

export interface ComboboxOptions {
  /**
   * Take the first option when nothing matches the text. Right for fields whose
   * options come from a server and are reworded (a location becomes "Austin, TX,
   * USA"), wrong for a Yes/No where the wrong pick is a lie.
   */
  allowFirst?: boolean;
}

export async function selectComboboxOption(
  input: HTMLInputElement,
  value: string,
  { allowFirst = false }: ComboboxOptions = {},
): Promise<boolean> {
  const wanted = value.trim().toLowerCase();
  if (!wanted) return false;

  input.focus();
  // Opens the menu even when typing alone would not.
  press(input, 'ArrowDown');
  type(input, value);

  const options = await waitForOptions(input);
  if (!options.length) {
    press(input, 'Escape');
    return false;
  }

  const match =
    options.find((option) => label(option) === wanted) ??
    options.find((option) => label(option).startsWith(wanted)) ??
    options.find((option) => label(option).includes(wanted)) ??
    (allowFirst ? options[0] : undefined);

  if (!match) {
    press(input, 'Escape');
    return false;
  }

  const chosen = label(match);
  click(match);
  return committed(input, chosen);
}

function label(option: HTMLElement): string {
  return (option.textContent ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Native setter first, so React sees a real change rather than a stale value. */
function type(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (setter) setter.call(input, value);
  else input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function press(input: HTMLInputElement, key: string): void {
  input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
}

/** react-select commits on mousedown, others on click, so send the whole sequence. */
function click(option: HTMLElement): void {
  for (const type of ['mousedown', 'mouseup', 'click'] as const) {
    option.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
  }
}

async function waitForOptions(input: HTMLInputElement): Promise<HTMLElement[]> {
  const scope = input.closest('[class*="select" i]');
  const deadline = Date.now() + OPTION_TIMEOUT_MS;

  while (Date.now() < deadline) {
    // Menus usually render inside the control, but can be portalled to the body.
    const found = query(scope) ?? query(document);
    if (found) return found;
    await delay(POLL_MS);
  }
  return [];
}

function query(scope: ParentNode | null): HTMLElement[] | null {
  if (!scope) return null;
  const options = Array.from(scope.querySelectorAll<HTMLElement>('[role="option"]')).filter(isVisible);
  return options.length ? options : null;
}

/** Confirm the control now shows the choice, rather than trusting the click. */
async function committed(input: HTMLInputElement, chosen: string): Promise<boolean> {
  await delay(SETTLE_MS);

  const container = input.closest('[class*="select" i]');
  const shown = container?.querySelector('[class*="single-value" i], [class*="multi-value" i]');
  if (shown) return label(shown as HTMLElement).includes(chosen);

  // No recognisable value node: an open menu means nothing was taken.
  return input.getAttribute('aria-expanded') !== 'true';
}

/**
 * Open a picker just to see what it offers, then close it again. The options are
 * built on demand, so this is the only way to know what an answer may be.
 */
export async function readComboboxOptions(input: HTMLInputElement): Promise<string[]> {
  input.focus();
  press(input, 'ArrowDown');

  const options = await waitForOptions(input);
  const labels = options.map((option) => (option.textContent ?? '').replace(/\s+/g, ' ').trim());

  press(input, 'Escape');
  input.blur();
  await delay(SETTLE_MS);

  return labels.filter(Boolean).slice(0, 40);
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

/** Poll for something a click is expected to reveal. */
export async function waitFor<T>(find: () => T | null, timeoutMs: number): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = find();
    if (found) return found;
    await delay(POLL_MS);
  }
  return null;
}
