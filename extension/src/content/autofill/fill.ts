export type Fillable = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

const SKIPPED_INPUT_TYPES = new Set([
  'hidden',
  'submit',
  'button',
  'image',
  'reset',
  'password',
  'range',
  'color',
]);

export function collectFields(root: ParentNode = document): Fillable[] {
  return Array.from(root.querySelectorAll<Fillable>('input, textarea, select')).filter((element) => {
    if (element instanceof HTMLInputElement && SKIPPED_INPUT_TYPES.has(element.type)) return false;
    if (element.disabled) return false;
    if ('readOnly' in element && element.readOnly) return false;
    return isVisible(element);
  });
}

export function isVisible(element: HTMLElement): boolean {
  if (element.hidden) return false;
  const style = getComputedStyle(element);
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
  return element.getClientRects().length > 0;
}

/** All the text a human would read as this field's label. */
export function describeField(element: Fillable): string {
  const parts: string[] = [];

  if (element.id) {
    const label = document.querySelector<HTMLLabelElement>(`label[for="${cssEscape(element.id)}"]`);
    if (label?.innerText) parts.push(label.innerText);
  }

  const ancestorLabel = element.closest('label');
  if (ancestorLabel?.innerText) parts.push(ancestorLabel.innerText);

  const labelledBy = element.getAttribute('aria-labelledby');
  if (labelledBy) {
    for (const id of labelledBy.split(/\s+/)) {
      const node = document.getElementById(id);
      if (node?.innerText) parts.push(node.innerText);
    }
  }

  parts.push(element.getAttribute('aria-label') ?? '', (element as HTMLInputElement).placeholder ?? '');

  for (const identifier of [
    element.name ?? '',
    element.id ?? '',
    element.getAttribute('data-testid') ?? '',
    // Workday names every field this way and often nothing else: its visible label is
    // a plain <div>, while data-automation-id reads "legalNameSection_firstName".
    element.getAttribute('data-automation-id') ?? '',
  ]) {
    if (!identifier) continue;
    // Both spellings: rules anchored on a word boundary need the split form, and rules
    // written against the run-together one ("linkedin") need the raw.
    parts.push(identifier, identifierWords(identifier));
  }

  const group = element.closest('div, fieldset, li');
  const groupLabel = group?.querySelector('label, legend');
  if (groupLabel instanceof HTMLElement && groupLabel.innerText) parts.push(groupLabel.innerText);

  return parts
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Attribute values are identifiers rather than prose. Splitting them into words is what
 * lets a rule anchored on a word boundary match: an underscore is a word character, so
 * /\bcity\b/ never matches "addressSection_city" until it reads "address section city".
 */
function identifierWords(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_\-.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function hasValue(element: Fillable): boolean {
  if (element instanceof HTMLSelectElement) {
    return element.selectedIndex > 0 && element.value !== '';
  }
  return element.value.trim() !== '';
}

/**
 * Writes through the prototype's setter instead of assigning to the property.
 *
 * React installs its own `value` setter on each element to track changes. Assigning
 * through that setter updates the tracker as well, so the `input` event that follows
 * looks like a no-op and onChange never runs — the box shows the text while React's
 * state stays empty, and the form reports the field as missing on submit. Writing
 * through the prototype leaves the tracker stale, which is what makes React accept it.
 */
function writeValue(element: Fillable, value: string): void {
  const prototype =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : element instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;

  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  if (setter) setter.call(element, value);
  else element.value = value;
}

/**
 * `element.focus()` and `.blur()` fire nothing when the document itself is not
 * focused, which is often the case while autofill runs. Form libraries decide a field
 * is "touched" from these events and only validate it then, so a field filled without
 * them keeps its initial "required" error until the user clicks it by hand. React 17+
 * listens for the bubbling focusin/focusout pair, so both are dispatched explicitly.
 */
function fireFocus(element: Fillable): void {
  element.focus();
  element.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
  element.dispatchEvent(new FocusEvent('focus'));
}

function fireBlur(element: Fillable): void {
  element.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
  element.dispatchEvent(new FocusEvent('blur'));
  element.blur();
}

/**
 * How many times a single field may be attempted per Autofill press.
 *
 * One. A field that did not take the value first time rarely takes it on the third
 * either, and retrying is expensive: a failed combobox attempt types, waits up to three
 * seconds for a menu that never opens, then presses Escape — and the watcher re-runs on
 * every DOM change, so that cost repeats for as long as the page is open. Filling what
 * can be filled quickly and leaving the rest to be typed by hand beats grinding.
 */
const MAX_ATTEMPTS = 1;

/**
 * Weakly keyed, so the budget is per element rather than per label: a wizard step that
 * is routed away and back brings new nodes, and those start fresh.
 *
 * Reassigned rather than cleared on a new run, which is the only way to empty a WeakMap.
 */
let attempts = new WeakMap<Element, number>();

/** True once a field has been tried often enough to stop trying. */
export function givenUpOn(element: Element): boolean {
  return (attempts.get(element) ?? 0) >= MAX_ATTEMPTS;
}

/**
 * Every control autofill has already put an answer into on this page.
 *
 * The background sweep re-runs on any DOM change, and clearing a field is itself a DOM
 * change — so without this, deleting a wrong answer makes the sweep notice an empty
 * field and put it straight back. That is the extension arguing with the person using
 * it, and no attempt budget makes it acceptable; it just ends the argument after three
 * rounds. So a sweep never touches a control twice, whatever it now contains.
 *
 * Pressing Autofill is a fresh instruction and forgets all of this, which is how you
 * ask for a field to be filled again after clearing it.
 */
const touched = new Set<Element>();

export function markTouched(element: Element): void {
  touched.add(element);
}

export function wasTouched(element: Element): boolean {
  return touched.has(element);
}

/**
 * Wipes both memories, so everything on the page is fair game again.
 *
 * Called when Autofill is pressed, and only then. That press is a fresh instruction:
 * it should refill what was cleared and re-try what failed, because the alternative is
 * a button that does nothing the second time you press it. The background sweeps share
 * the run's budget instead, which is what stops them grinding on a stubborn field.
 */
export function resetFillMemory(): void {
  touched.clear();
  attempts = new WeakMap<Element, number>();
}

/**
 * Spends one of a field's attempts, returning false when there are none left.
 *
 * Attempts are counted rather than failures: a field that fills first time is never
 * retried anyway, because every caller skips a field that already holds a value. So a
 * second attempt only happens when the first did not survive, and three of those is
 * enough to conclude the page does not want the value.
 */
export function claimAttempt(element: Element): boolean {
  const used = attempts.get(element) ?? 0;
  if (used >= MAX_ATTEMPTS) return false;
  attempts.set(element, used + 1);
  return true;
}

/** Sets a value the way React and friends notice: native setter, then input+change. */
export function setValue(element: Fillable, value: string): boolean {
  if (!claimAttempt(element)) return false;
  if (element instanceof HTMLSelectElement) return selectOption(element, value);

  fireFocus(element);
  writeValue(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
  fireBlur(element);
  markTouched(element);
  return true;
}

export function selectOption(element: HTMLSelectElement, value: string): boolean {
  const wanted = value.trim().toLowerCase();
  if (!wanted) return false;

  const options = Array.from(element.options);
  const match =
    options.find((option) => option.text.trim().toLowerCase() === wanted) ??
    options.find((option) => option.value.trim().toLowerCase() === wanted) ??
    options.find((option) => option.text.trim().toLowerCase().includes(wanted)) ??
    options.find((option) => wanted.includes(option.text.trim().toLowerCase()) && option.text.trim().length > 1);

  if (!match) return false;

  // Same tracker problem as a text input, and the same fix: a select assigned with
  // `element.value = x` renders the choice but never reaches React's onChange.
  fireFocus(element);
  writeValue(element, match.value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
  fireBlur(element);
  markTouched(element);
  return true;
}

export function attachFile(input: HTMLInputElement, file: File): boolean {
  try {
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    // "Resume is required" is validated on blur as often as any other field.
    fireBlur(input);
    return true;
  } catch {
    return false;
  }
}

export function highlight(element: HTMLElement, ok: boolean): void {
  element.style.outline = `2px solid ${ok ? '#22c55e' : '#f59e0b'}`;
  element.style.outlineOffset = '1px';
  window.setTimeout(() => {
    element.style.outline = '';
    element.style.outlineOffset = '';
  }, 4000);
}

function cssEscape(value: string): string {
  return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(value) : value.replace(/["\\]/g, '\\$&');
}
