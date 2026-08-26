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

  parts.push(
    element.getAttribute('aria-label') ?? '',
    (element as HTMLInputElement).placeholder ?? '',
    element.name ?? '',
    element.id ?? '',
    element.getAttribute('data-testid') ?? '',
  );

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

export function hasValue(element: Fillable): boolean {
  if (element instanceof HTMLSelectElement) {
    return element.selectedIndex > 0 && element.value !== '';
  }
  return element.value.trim() !== '';
}

/** Sets a value the way React and friends notice: native setter, then input+change. */
export function setValue(element: Fillable, value: string): boolean {
  if (element instanceof HTMLSelectElement) return selectOption(element, value);

  const prototype =
    element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  element.focus();
  if (setter) {
    setter.call(element, value);
  } else {
    element.value = value;
  }
  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
  element.blur();
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
  element.value = match.value;
  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}

export function attachFile(input: HTMLInputElement, file: File): boolean {
  try {
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
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
