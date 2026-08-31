import type { Locator } from 'playwright';
import { jitter } from './wait';

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/**
 * Rewrites an ISO date into whatever a box says it wants.
 *
 * The profile keeps dates as YYYY-MM-DD, which almost no form accepts as typed.
 * The form usually says what it expects, in its placeholder or its pattern, and
 * taking it at its word beats guessing - typing an American order into a
 * European box produces a date that is wrong rather than rejected, which is far
 * worse, and silently so for any day of the month below thirteen.
 *
 * Returns null when the hint cannot be read, so the caller can decline rather
 * than write something it does not understand.
 */
export function formatDateFor(hint: string, iso: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
  if (!match) return null;
  const [, year, month, day] = match;

  const shape = hint.toLowerCase();
  const monthName = MONTHS[Number(month) - 1];

  // A hint written "D" wants 5, one written "DD" wants 05. Padding regardless
  // is usually harmless and occasionally rejected, and the form has already
  // said which it wants.
  const d = /d{2}/.test(shape) ? day : String(Number(day));
  const m = /m{2}/.test(shape) ? month : String(Number(month));

  // Longest patterns first: "dd/mm/yyyy" also contains "mm/yyyy".
  const sep = separator(shape);
  if (/d{1,2}\s*[-/.]\s*mmm/.test(shape)) return `${d}-${monthName.slice(0, 3)}-${year}`;
  if (/mmm\s*[-/. ]\s*d{1,2}/.test(shape)) return `${monthName.slice(0, 3)} ${d}, ${year}`;
  if (/yyyy\s*([-/.])\s*m{1,2}\s*\1\s*d{1,2}/.test(shape)) return `${year}${sep}${month}${sep}${day}`;
  if (/d{1,2}\s*([-/.])\s*m{1,2}\s*\1\s*yyyy/.test(shape)) return `${d}${sep}${m}${sep}${year}`;
  if (/m{1,2}\s*([-/.])\s*d{1,2}\s*\1\s*yyyy/.test(shape)) return `${m}${sep}${d}${sep}${year}`;
  if (/m{1,2}\s*([-/.])\s*yyyy/.test(shape)) return `${m}${sep}${year}`;
  if (/mm\s*([-/.])\s*yyyy/.test(shape)) return `${month}${separator(shape)}${year}`;

  return null;
}

function separator(shape: string): string {
  if (shape.includes('/')) return '/';
  if (shape.includes('.')) return '.';
  return '-';
}

/**
 * Writes a date into whatever kind of control the form used for it.
 *
 * A native date input takes the ISO value directly - the browser renders it in
 * the reader's own locale, which is the whole point of the type. Anything else
 * is a text box with an opinion, and that opinion is read off the placeholder or
 * the pattern before anything is typed.
 */
export async function setDate(locator: Locator, iso: string): Promise<boolean> {
  const kind = await locator
    .evaluate((element) => {
      const input = element as HTMLInputElement;
      return {
        type: (input.type ?? '').toLowerCase(),
        hint: input.placeholder || input.getAttribute('pattern') || input.getAttribute('aria-describedby') || '',
      };
    })
    .catch(() => null);

  if (!kind) return false;

  if (kind.type === 'date') {
    await locator.fill(iso).catch(() => {});
    return (await locator.inputValue().catch(() => '')) === iso;
  }

  const written = formatDateFor(kind.hint, iso);
  if (!written) return false;

  await locator.fill('').catch(() => {});
  // Typed rather than set: date boxes are commonly masked, and a mask reacts to
  // keystrokes while ignoring a value that simply appears.
  await locator.pressSequentially(written, { delay: jitter(70, 25) }).catch(() => {});
  await locator.blur().catch(() => {});

  const got = await locator.inputValue().catch(() => '');
  // Compared by digits: the mask adds its own punctuation as you type.
  return got.replace(/\D/g, '') === written.replace(/\D/g, '');
}
