import type { Locator } from 'playwright';
import type { FormRoot } from './templates/index';
import { delay, jitter } from './wait';

/**
 * Driving the custom pickers that have replaced `<select>` on modern ATS forms.
 *
 * Greenhouse's current form is react-select throughout: what looks like a
 * dropdown is a text input with `role="combobox"`, and the options do not exist
 * in the document until the menu is opened. Nothing can be chosen by setting a
 * value - the menu has to be opened, filtered and clicked, and then read back,
 * because the click is the least reliable part of the whole sequence.
 */

// Generous: these menus are often filled from a server request made on the first
// keystroke, and three seconds was short enough to lose them under load.
const MENU_TIMEOUT_MS = 6000;

export interface ComboboxChoice {
  ok: boolean;
  /** What was actually committed, which is often a reworded version of the ask. */
  chosen?: string;
  options?: string[];
}

export async function isCombobox(locator: Locator): Promise<boolean> {
  return locator
    .evaluate((element) => {
      const role = element.getAttribute('role');
      if (role === 'combobox') return true;
      const popup = element.getAttribute('aria-haspopup');
      if (popup === 'listbox' || popup === 'menu' || popup === 'true') return true;
      return element.hasAttribute('aria-autocomplete');
    })
    .catch(() => false);
}

export interface ComboboxOptions {
  /**
   * Accept the first option when nothing matches. Right only where the control
   * rewords what it is given - a location picker turning "Austin, TX" into
   * "Austin, TX, United States" - and wrong anywhere a wrong pick is a claim.
   */
  allowFirst?: boolean;
  /** Chosen when the profile is silent, e.g. the decline option on an EEOC question. */
  fallback?: RegExp;
}

/**
 * Opens a picker, filters it, chooses, and proves the choice stuck.
 *
 * The verification at the end is the point. react-select commits on mousedown,
 * ignores clicks while it is still fetching, and will silently keep its previous
 * value; treating the click as success is how a form ends up submitted with a
 * question visibly unanswered.
 */
export async function selectComboboxOption(
  root: FormRoot,
  input: Locator,
  want: string,
  { allowFirst = false, fallback }: ComboboxOptions = {},
): Promise<ComboboxChoice> {
  const wanted = want.trim().toLowerCase();
  if (!wanted && !fallback) return { ok: false };

  await input.scrollIntoViewIfNeeded().catch(() => {});
  await input.click();

  if (wanted) {
    await input.pressSequentially(want, { delay: jitter(60, 25) });
  } else {
    // Nothing to filter by, so just open it and read what is on offer.
    await input.press('ArrowDown');
  }

  const menu = await openMenu(root, input);
  if (!menu) {
    await input.press('Escape').catch(() => {});
    return { ok: false };
  }

  const options = await menu.locator('[role="option"]').allTextContents();
  const cleaned = options.map((option) => option.replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (!cleaned.length) {
    await input.press('Escape').catch(() => {});
    return { ok: false, options: [] };
  }

  const index = pick(cleaned, wanted, fallback, allowFirst);
  if (index < 0) {
    await input.press('Escape').catch(() => {});
    return { ok: false, options: cleaned };
  }

  const chosen = cleaned[index];
  await menu.locator('[role="option"]').nth(index).click();
  await delay(jitter(200, 80));

  return { ok: await committed(input, chosen), chosen, options: cleaned };
}

/**
 * Finds the menu that just opened, and waits for it to have something in it.
 *
 * `aria-controls` names the listbox unambiguously and is tried first. The
 * fallback - the single visible listbox - is sound only because we opened one a
 * moment ago, and it is genuinely ambiguous on a page like Greenhouse's, which
 * keeps a second listbox around for the phone dialing code. Ambiguity is not a
 * reason to give up early though: the other menu may simply not have closed yet,
 * so keep looking until the deadline and only then admit defeat.
 *
 * A listbox with no options in it does not count as open. react-select renders
 * the element before its contents arrive, and returning it too early reads an
 * empty menu as "no matches" on every server-backed picker.
 */
async function openMenu(root: FormRoot, input: Locator): Promise<Locator | null> {
  const deadline = Date.now() + MENU_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const controls = await input.getAttribute('aria-controls').catch(() => null);
    if (controls) {
      // An attribute selector rather than '#id': these ids are generated and can
      // hold characters a bare id selector cannot carry.
      const byId = root.locator(`[id="${controls.replace(/"/g, '\\"')}"]`);
      if ((await byId.locator('[role="option"]').count().catch(() => 0)) > 0) return byId;
    }

    const listboxes = root.locator('[role="listbox"]:visible');
    const count = await listboxes.count().catch(() => 0);
    for (let i = 0; i < count; i += 1) {
      const candidate = listboxes.nth(i);
      if ((await candidate.locator('[role="option"]').count().catch(() => 0)) > 0) {
        // Only trust this when it is the only populated one; two means we cannot
        // tell ours from somebody else's, and clicking into the wrong menu is
        // worse than reporting that we could not choose.
        if (count === 1) return candidate;
      }
    }

    await delay(100);
  }
  return null;
}

/** Exact, then prefix, then substring, then the fallback. Never a blind first. */
function pick(options: string[], wanted: string, fallback?: RegExp, allowFirst = false): number {
  const lower = options.map((option) => option.toLowerCase());

  if (wanted) {
    const exact = lower.indexOf(wanted);
    if (exact >= 0) return exact;
    const prefix = lower.findIndex((option) => option.startsWith(wanted));
    if (prefix >= 0) return prefix;
    const contains = lower.findIndex((option) => option.includes(wanted));
    if (contains >= 0) return contains;
    // The other direction too: the profile may hold "Male" where the option
    // reads "Man", or "US Citizen" where the option spells it out at length.
    const reverse = lower.findIndex((option) => wanted.includes(option) && option.length > 2);
    if (reverse >= 0) return reverse;
  }

  if (fallback) {
    const matched = options.findIndex((option) => fallback.test(option));
    if (matched >= 0) return matched;
  }

  return allowFirst && options.length ? 0 : -1;
}

/**
 * Confirms the control now shows the choice.
 *
 * react-select renders the committed value as `.select__single-value` inside
 * `.select__control` - the box a person actually sees - so that is what gets
 * read. Two traps here, both found by looking at a live form rather than
 * reasoning about one:
 *
 * - `closest` matches the element itself, and the input's own class is
 *   `select__input`, so a loose `[class*="select"]` matches the input and the
 *   search starts one level too deep. The control has to be named exactly.
 * - The input's value is *cleared* on commit, because it held the filter text.
 *   Checking it for the chosen option is backwards: empty is what success looks
 *   like, so that check fails precisely when the pick worked.
 */
async function committed(input: Locator, chosen: string): Promise<boolean> {
  const wanted = chosen.replace(/\s+/g, ' ').trim().toLowerCase();

  const shown = await input
    .evaluate((element) => {
      const control =
        element.closest('[class*="select__control"]') ??
        element.closest('[class*="value-container" i]') ??
        element.parentElement?.parentElement ??
        null;
      if (!control) return null;
      const value = control.querySelector('[class*="single-value" i], [class*="multi-value" i]');
      return (value ?? control).textContent ?? '';
    })
    .catch(() => null);

  const text = shown?.replace(/\s+/g, ' ').trim().toLowerCase() ?? null;
  if (text && text.includes(wanted)) return true;

  // The menu closed and the control is no longer showing nothing. Weaker, but it
  // covers a picker that renders its value somewhere we do not recognise.
  const expanded = await input.getAttribute('aria-expanded').catch(() => null);
  return expanded === 'false' && !!text && text.length > 0;
}
