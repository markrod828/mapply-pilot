import type { Locator } from 'playwright';
import { delay, jitter } from './wait';

/**
 * How to decide a written value "took".
 *
 * Not everything reads back the way it went in, and treating that as failure is
 * as wrong as not checking at all. A phone box formats 5551234567 into
 * (555) 123-4567; a salary box adds a currency symbol; a text box may trim.
 */
export type Comparator = 'exact' | 'loose' | 'digits' | 'money';

const NORMALISE: Record<Comparator, (value: string) => string> = {
  exact: (v) => v,
  loose: (v) => v.trim().replace(/\s+/g, ' ').toLowerCase(),
  digits: (v) => v.replace(/\D/g, ''),
  money: (v) => v.replace(/[^0-9.]/g, ''),
};

export function equivalent(got: string, want: string, comparator: Comparator = 'loose'): boolean {
  const normalise = NORMALISE[comparator];
  const a = normalise(got);
  const b = normalise(want);
  if (a === b) return true;

  // A phone box commonly keeps the national number and puts the country code in
  // a picker of its own, so what is read back is the tail of what was written.
  // Comparing by suffix accepts that without accepting two different numbers:
  // the shared part still has to be long enough to identify one.
  if (comparator === 'digits' && a && b) {
    const shorter = a.length < b.length ? a : b;
    const longer = a.length < b.length ? b : a;
    return shorter.length >= 7 && longer.endsWith(shorter);
  }
  return false;
}

export type WriteStrategy = 'fill' | 'type' | 'nativeSet';

export interface WriteResult {
  ok: boolean;
  /** Which strategy succeeded. Worth recording: a field that only ever works
   *  via `type` is telling you it is masked or listening for key events. */
  via?: WriteStrategy;
  got: string;
}

export interface WriteOptions {
  comparator?: Comparator;
  /** Skip `fill` and go straight to per-character typing. Right for anything
   *  whose options are fetched as you type. */
  typeOnly?: boolean;
}

/**
 * Writes a value and proves it stuck, escalating until one works.
 *
 * Playwright's `fill` produces trusted events, which is enough for almost
 * everything and makes the old native-setter dance unnecessary. But it is not
 * enough for every field: an input behind a mask can revert what was set, and a
 * control that only listens for real keystrokes ignores a value that simply
 * appears. So each attempt is read back rather than assumed - the extension this
 * replaces counted a write as filled the moment it dispatched, which is how
 * reverted fields were reported as complete.
 */
export async function writeVerified(
  locator: Locator,
  want: string,
  options: WriteOptions = {},
): Promise<WriteResult> {
  const comparator = options.comparator ?? 'loose';
  const strategies: WriteStrategy[] = options.typeOnly
    ? ['type', 'nativeSet']
    : ['fill', 'type', 'nativeSet'];

  let got = '';
  for (const strategy of strategies) {
    try {
      await apply(locator, want, strategy);
    } catch {
      continue;
    }
    await delay(jitter(120, 60));
    got = await readBack(locator);
    if (equivalent(got, want, comparator)) return { ok: true, via: strategy, got };
  }
  return { ok: false, got };
}

async function apply(locator: Locator, value: string, strategy: WriteStrategy): Promise<void> {
  if (strategy === 'fill') {
    await locator.fill(value);
    return;
  }

  if (strategy === 'type') {
    await locator.fill('');
    // Real per-character keystrokes. Anything that filters options as you type,
    // or reformats on keyup, needs these and sees nothing from `fill`.
    await locator.pressSequentially(value, { delay: jitter(70, 30) });
    await locator.blur().catch(() => {});
    return;
  }

  // Last resort: assign through the prototype's setter so React's value tracker
  // does not swallow the change, then announce it by hand. Only reached when a
  // control has ignored two rounds of genuine input events.
  await locator.evaluate((element, next) => {
    const node = element as HTMLInputElement | HTMLTextAreaElement;
    const prototype =
      node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(node, next);
    node.dispatchEvent(new Event('input', { bubbles: true }));
    node.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}

async function readBack(locator: Locator): Promise<string> {
  try {
    return await locator.inputValue();
  } catch {
    // Not an input: a contenteditable, or a widget that shows its value as text.
    return (await locator.textContent())?.trim() ?? '';
  }
}
